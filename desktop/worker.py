"""Persistent, offline SheetSage2 inference over a JSON-lines protocol.

The native app owns stdin/stdout. Model messages and native library output go
to stderr; stdout contains one JSON event per line. A single inference thread
keeps the input loop responsive to cancellation while retaining the model.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import sys
import threading
import traceback
from typing import Any, Callable, TextIO
from uuid import uuid4


# Keep these identifiers aligned with catalog.rs. The native API accepts an ID,
# never a caller-provided filename. Optional exports remain genuinely optional.
ARTIFACTS = (
    ("abc", "score.abc", "ABC score", "notation"),
    ("midi", "transcription.mid", "Arrangement MIDI", "midi"),
    ("events", "events.json", "Raw model events", "json"),
    ("summary", "result.json", "Analysis summary", "json"),
    ("playback", "playback.json", "Playback tracks", "json"),
    ("events_tsv", "events.tsv", "Event table", "table"),
    ("beat", "beat.lab", "Beat grid", "annotation"),
    ("downbeat", "downbeat.lab", "Downbeats", "annotation"),
    ("rhythm_events", "rhythm_events.lab", "Raw rhythm events", "annotation"),
    ("beat_meter", "beat_meter.lab", "Paper-preset beat/meter events", "annotation"),
    ("structure", "structure.lab", "Song structure", "annotation"),
    ("key", "key.lab", "Key changes", "annotation"),
    ("chord", "chord.lab", "Chords", "annotation"),
    ("melody_full", "melody_full.lab", "All melody notes", "annotation"),
    ("melody_vocal", "melody_vocal.lab", "Vocal melody notes", "annotation"),
    ("melody_instrumental", "melody_instrumental.lab", "Instrumental melody notes", "annotation"),
    ("melody_midi", "melody.mid", "All melody MIDI", "midi"),
    ("melody_vocal_midi", "melody_vocal.mid", "Vocal melody MIDI", "midi"),
    ("melody_instrumental_midi", "melody_instrumental.mid", "Instrumental melody MIDI", "midi"),
    ("chords_midi", "chords.mid", "Chord MIDI", "midi"),
)
RECORDED_SETTINGS = (
    "prompts", "preset", "melody_only", "dtype", "window_seconds",
    "overlap_seconds", "lookahead_seconds", "duration_seconds",
)
MAX_EXPORT_BYTES = 16 * 1024 * 1024


class Cancelled(Exception):
    """Cooperative interruption at a model progress callback."""


@dataclass(frozen=True)
class Command:
    id: str | int
    command: str
    audio_path: Path | None = None
    max_seconds: float = 20.0
    audio_name: str | None = None


def parse_command(value: Any) -> Command:
    """Validate untrusted UI input before loading the expensive model."""
    if not isinstance(value, dict):
        raise ValueError("command must be a JSON object")
    request_id = value.get("id")
    if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
        raise ValueError("id must be a string or integer")
    if isinstance(request_id, str) and not request_id.strip():
        raise ValueError("id must not be empty")
    operation = value.get("command")
    if operation not in ("load", "transcribe", "cancel", "shutdown"):
        raise ValueError("command must be load, transcribe, cancel, or shutdown")
    if operation != "transcribe":
        return Command(request_id, operation)
    raw_path = value.get("audio_path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("audio_path must identify an existing audio file")
    audio_path = Path(raw_path).expanduser().resolve()
    if not audio_path.is_file():
        raise ValueError(f"audio file does not exist: {audio_path}")
    audio_name = value.get("audio_name", audio_path.name)
    if (
        not isinstance(audio_name, str)
        or not audio_name.strip()
        or len(audio_name) > 1024
        or audio_name in (".", "..")
        or "/" in audio_name
        or "\\" in audio_name
        or "\0" in audio_name
    ):
        raise ValueError("audio_name must be a nonempty basename of at most 1024 characters")
    max_seconds = value.get("max_seconds", 20.0)
    if isinstance(max_seconds, bool) or not isinstance(max_seconds, (int, float)):
        raise ValueError("max_seconds must be a finite number greater than 0 and at most 300")
    try:
        valid_duration = math.isfinite(max_seconds) and 0 < max_seconds <= 300
    except OverflowError:
        valid_duration = False
    if not valid_duration:
        raise ValueError("max_seconds must be a finite number greater than 0 and at most 300")
    return Command(request_id, operation, audio_path, float(max_seconds), audio_name)


class JsonEmitter:
    """Serialize writes from the command and inference threads atomically."""

    def __init__(self, stream: TextIO):
        self.stream = stream
        self.lock = threading.Lock()

    def emit(self, request_id: str | int | None, event_type: str, **fields: Any) -> None:
        line = json.dumps(
            {"id": request_id, "type": event_type, **fields},
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
        with self.lock:
            self.stream.write(line + "\n")
            self.stream.flush()


def load_local_model(lab_root: Path) -> Any:
    """Load the reviewed local snapshot and its cached parent without networking."""
    runtime = lab_root / "runtime"
    model_path = runtime / "model"
    if not (model_path / "model.safetensors").is_file():
        raise FileNotFoundError("Local model weights are missing. Run python3 run.py setup first.")
    os.environ["HF_HOME"] = str(runtime / "huggingface")
    os.environ["HF_HUB_CACHE"] = str(runtime / "huggingface" / "hub")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["PATH"] = str(runtime / ".venv" / "bin") + os.pathsep + os.environ.get("PATH", "")
    import torch
    from transformers import AutoModel

    torch.set_num_threads(4)
    return AutoModel.from_pretrained(
        str(model_path), local_files_only=True, trust_remote_code=True,
        torch_dtype=torch.float32,
    ).eval().to("cpu")


def recorded_provenance(summary: dict[str, Any], lab_root: Path | None = None) -> dict[str, Any]:
    """Record settings, not a quality/confidence score or unmeasured hardware claim."""
    provenance: dict[str, Any] = {
        "recorded_settings": {key: summary[key] for key in RECORDED_SETTINGS if key in summary},
    }
    if lab_root is not None:
        sources_path = lab_root / "sources.json"
        if sources_path.is_file():
            sources = json.loads(sources_path.read_text(encoding="utf-8"))
            provenance["sources"] = {
                key: sources[key] for key in (
                    "paper", "model", "model_revision", "base_model", "base_revision", "base_weight_license",
                ) if isinstance(sources.get(key), str)
            }
        provenance["device"] = "cpu"
        provenance["application"] = "SheetSage Studio"
        provenance["capture_version"] = 1
    return provenance


def read_result(
    output_dir: Path,
    audio_path: Path,
    audio_name: str | None = None,
    *,
    lab_root: Path | None = None,
) -> dict[str, Any]:
    """Read only public, JSON-compatible exports, never model tensors or bytes."""
    output_dir = output_dir.resolve()

    def export_path(filename: str) -> Path | None:
        path = output_dir / filename
        if not path.is_file():
            return None
        path = path.resolve()
        if not path.is_relative_to(output_dir):
            raise ValueError("The model export is outside its output directory")
        return path

    def read_text(filename: str) -> str | None:
        path = export_path(filename)
        if path is None:
            return None
        with path.open("rb") as stream:
            data = stream.read(MAX_EXPORT_BYTES + 1)
        if len(data) > MAX_EXPORT_BYTES:
            raise ValueError("The model export exceeds the size limit")
        return data.decode("utf-8")

    def read_json(filename: str, default: Any = None) -> Any:
        text = read_text(filename)
        return json.loads(text) if text is not None else default

    summary = read_json("result.json")
    if not isinstance(summary, dict):
        raise ValueError("The model did not produce a valid result.json export")
    abc = ""
    for filename in ("score.browser.abc", "score.abc"):
        text = read_text(filename)
        if text is not None:
            abc = text
            break
    annotations = {}
    available_artifacts = []
    for artifact, filename, label, kind in ARTIFACTS:
        if export_path(filename) is None:
            continue
        available_artifacts.append({"id": artifact, "filename": filename, "label": label, "kind": kind})
        if kind == "annotation":
            annotations[artifact] = read_text(filename)
    # Notation appends its own final boundary beat. Follow-audio mapping must
    # use this exact exported grid, not reconstruct it from raw beat.lab.
    notation_beats = read_text("notation/song_beats.txt")
    payload = {
        "run_id": output_dir.name,
        "output_dir": str(output_dir),
        "audio_path": str(audio_path),
        "audio_name": audio_name if audio_name is not None else audio_path.name,
        "summary": summary,
        "abc": abc,
        "playback": read_json("playback.json", {"tracks": [], "duration": summary.get("duration_seconds", 0)}),
        "events": read_json("events.json", {"events": []}),
        "annotations": annotations,
        "available_artifacts": available_artifacts,
        "provenance": recorded_provenance(summary, lab_root),
        "score_timing": {"version": 1, "notation_beats": notation_beats} if notation_beats is not None else None,
    }
    # Validate before publishing the history success marker or an event.
    json.dumps(payload, ensure_ascii=False, allow_nan=False)
    return payload


@dataclass
class Task:
    command: Command
    cancel: threading.Event = field(default_factory=threading.Event)
    thread: threading.Thread | None = None

    def check_cancelled(self) -> None:
        if self.cancel.is_set():
            raise Cancelled()


class InferenceWorker:
    def __init__(
        self,
        lab_root: Path,
        emitter: JsonEmitter,
        model_loader: Callable[[Path], Any] = load_local_model,
    ):
        self.lab_root = lab_root.expanduser().resolve()
        self.emitter = emitter
        self.model_loader = model_loader
        self.model: Any = None
        self.task: Task | None = None
        self.lock = threading.RLock()
        self.closing = False

    def status(self, request_id: str | int | None, state: str, message: str) -> None:
        self.emitter.emit(request_id, "status", state=state, message=message, model_loaded=self.model is not None)

    def handle_line(self, line: str) -> bool:
        request_id = None
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                candidate_id = value.get("id")
                if isinstance(candidate_id, (str, int)) and not isinstance(candidate_id, bool):
                    request_id = candidate_id
            command = parse_command(value)
            return self.dispatch(command)
        except (ValueError, TypeError, OSError) as error:
            self.emitter.emit(request_id, "error", message=str(error), model_loaded=self.model is not None)
            return True

    def dispatch(self, command: Command) -> bool:
        with self.lock:
            if command.command == "shutdown":
                self.closing = True
                if self.task:
                    self.task.cancel.set()
                    self.status(command.id, "cancelling", "Closing after the current model operation reaches a cancellation point.")
                else:
                    self.status(command.id, "idle", "Worker shutting down.")
                return False
            if self.closing:
                raise ValueError("worker is shutting down")
            if command.command == "cancel":
                if self.task:
                    self.task.cancel.set()
                    self.status(
                        command.id, "cancelling",
                        "Cancellation requested. Audio encoding cannot stop mid-kernel; waiting for the next model callback.",
                    )
                else:
                    self.status(command.id, "ready" if self.model is not None else "idle", "No active transcription to cancel.")
                return True
            if self.task is not None:
                raise ValueError("worker is busy; cancel or wait for the active request")
            if command.command == "load" and self.model is not None:
                self.status(command.id, "ready", "Model is already loaded on CPU (FP32).")
                return True
            task = Task(command)
            task.thread = threading.Thread(target=self._run, args=(task,), name="sheetsage2-inference")
            self.task = task
            task.thread.start()
        return True

    def _load(self, task: Task) -> None:
        task.check_cancelled()
        if self.model is None:
            self.status(task.command.id, "loading", "Loading the local model on CPU (FP32). The model will stay in memory.")
            self.model = self.model_loader(self.lab_root)
        task.check_cancelled()

    def _progress(self, task: Task, value: dict[str, Any]) -> None:
        task.check_cancelled()
        fields = {name: value[name] for name in ("stage", "window", "windows", "tokens") if name in value}
        if value.get("stage") == "encoding":
            fields["message"] = "Encoding audio; this stage may take time and has no intermediate progress callbacks."
        self.emitter.emit(task.command.id, "progress", **fields)

    def _transcribe(self, task: Task) -> tuple[dict[str, Any], Path]:
        command = task.command
        assert command.audio_path is not None
        # Recheck because a file may have been moved after protocol validation.
        if not command.audio_path.is_file():
            raise FileNotFoundError(f"audio file does not exist: {command.audio_path}")
        task.check_cancelled()
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        stem = re.sub(r"[^A-Za-z0-9_-]+", "-", command.audio_path.stem).strip("-")[:64] or "audio"
        output_dir = self.lab_root / "runtime" / "outputs" / f"{stem}-{stamp}-{uuid4().hex[:8]}"
        output_dir.mkdir(parents=True, exist_ok=False)
        # The catalog uses this marker to distinguish desktop jobs from legacy
        # CLI outputs. Only ui.json makes a desktop job a successful history item.
        (output_dir / ".desktop-job.json").write_text(
            json.dumps({"version": 1, "request_id": command.id, "created_at": datetime.now(timezone.utc).isoformat()}, allow_nan=False),
            encoding="utf-8",
        )
        self.status(command.id, "transcribing", "Transcribing locally. Progress updates arrive between model stages.")
        self.model.transcribe(
            command.audio_path,
            output_dir=output_dir,
            dtype="fp32",
            max_seconds=command.max_seconds,
            progress=lambda value: self._progress(task, value),
        )
        task.check_cancelled()
        return read_result(output_dir, command.audio_path, command.audio_name, lab_root=self.lab_root), output_dir

    def _run(self, task: Task) -> None:
        command = task.command
        try:
            self._load(task)
            payload, output_dir = self._transcribe(task) if command.command == "transcribe" else (None, None)
            # Completion and cancellation are serialized: a request is either
            # published successfully or cancelled, never both.
            with self.lock:
                task.check_cancelled()
                if payload is not None and output_dir is not None:
                    metadata = {
                        "run_id": payload["run_id"],
                        "audio_path": payload["audio_path"],
                        "audio_name": payload["audio_name"],
                        "max_seconds": command.max_seconds,
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "provenance": payload["provenance"],
                    }
                    temporary = output_dir / ".ui.json.tmp"
                    temporary.write_text(json.dumps(metadata, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")
                    temporary.replace(output_dir / "ui.json")
                    self.emitter.emit(command.id, "result", result=payload, model_loaded=self.model is not None)
                # Finalize inside this same lock so a late cancel cannot report
                # an already-published result as still running.
                self.task = None
                self.status(command.id, "ready", "Model ready on CPU (FP32).")
        except Cancelled:
            with self.lock:
                if self.task is task:
                    self.task = None
                self.emitter.emit(command.id, "cancelled", message="Request cancelled. Partial files were not added to history.", model_loaded=self.model is not None)
                self.status(
                    command.id, "ready" if self.model is not None else "idle",
                    "Model ready on CPU (FP32)." if self.model is not None else "Model is not loaded.",
                )
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            with self.lock:
                if self.task is task:
                    self.task = None
                self.emitter.emit(command.id, "error", message=str(error) or type(error).__name__, model_loaded=self.model is not None)
                self.status(
                    command.id, "ready" if self.model is not None else "idle",
                    "Model ready on CPU (FP32)." if self.model is not None else "Model is not loaded.",
                )
        finally:
            with self.lock:
                if self.task is task:
                    self.task = None
                    self.status(
                        command.id, "ready" if self.model is not None else "idle",
                        "Model ready on CPU (FP32)." if self.model is not None else "Model is not loaded.",
                    )

    def wait_idle(self) -> None:
        """Wait for the current operation; primarily useful for tests."""
        with self.lock:
            thread = self.task.thread if self.task is not None else None
        if thread is not None:
            thread.join()

    def close(self) -> None:
        with self.lock:
            self.closing = True
            if self.task is not None:
                self.task.cancel.set()
                thread = self.task.thread
            else:
                thread = None
        if thread is not None:
            thread.join()


def run_stdio(lab_root: Path, input_stream: TextIO, protocol_stream: TextIO) -> None:
    worker = InferenceWorker(lab_root, JsonEmitter(protocol_stream))
    # Connection is independent of request lifecycle: a startup idle status
    # could otherwise clear a first request already marked busy by the app.
    worker.emitter.emit(None, "connected", message="Local worker connected. Load the model or choose an audio file.", model_loaded=False)
    try:
        for line in input_stream:
            if line.strip() and not worker.handle_line(line):
                break
    finally:
        worker.close()


def protocol_stdout() -> TextIO:
    """Reserve the pipe before sending Python and native stdout logs to stderr."""
    stream = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    sys.stdout.flush()
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    return stream


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lab-root", type=Path, required=True)
    args = parser.parse_args()
    protocol = protocol_stdout()
    try:
        run_stdio(args.lab_root, sys.stdin, protocol)
    finally:
        protocol.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
