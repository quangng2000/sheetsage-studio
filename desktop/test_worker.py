"""Protocol and lifecycle tests; never import torch or load model weights."""

from __future__ import annotations

from contextlib import redirect_stderr
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock


SPEC = importlib.util.spec_from_file_location("sheetsage2_worker", Path(__file__).with_name("worker.py"))
assert SPEC is not None and SPEC.loader is not None
worker_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = worker_module
SPEC.loader.exec_module(worker_module)
Command = worker_module.Command
InferenceWorker = worker_module.InferenceWorker
JsonEmitter = worker_module.JsonEmitter
parse_command = worker_module.parse_command


def write_exports(output_dir: Path) -> None:
    (output_dir / "result.json").write_text(json.dumps({"duration_seconds": 20, "melody_notes": 2}), encoding="utf-8")
    (output_dir / "score.abc").write_text("X:1\nT:Example\nK:C\nC D E F|\n", encoding="utf-8")
    (output_dir / "playback.json").write_text(json.dumps({"duration": 20, "tracks": []}), encoding="utf-8")
    (output_dir / "events.json").write_text(json.dumps({"events": [{"time": 0, "values": {"key": "C:major"}}]}), encoding="utf-8")


class WorkerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.audio = self.root / "song one.mp3"
        self.audio.write_bytes(b"test fixture; fake model does not decode")
        self.output = io.StringIO()

    def make_worker(self, model=None, loader=None):
        self.loader = loader or Mock(return_value=model or Mock())
        self.worker = InferenceWorker(self.root, JsonEmitter(self.output), model_loader=self.loader)
        self.addCleanup(self.worker.close)
        return self.worker

    def events(self):
        return [json.loads(line) for line in self.output.getvalue().splitlines()]

    def transcribe_command(self, request_id="run"):
        return parse_command({"id": request_id, "command": "transcribe", "audio_path": str(self.audio)})

    def test_protocol_rejects_malformed_input_without_loading(self):
        worker = self.make_worker()
        for line in ("not json", "[]", '{"id":true,"command":"load"}', '{"id":"x","command":"unknown"}'):
            self.assertTrue(worker.handle_line(line))
        self.assertEqual([event["type"] for event in self.events()], ["error"] * 4)
        self.assertTrue(all(event["model_loaded"] is False for event in self.events()))
        self.loader.assert_not_called()

    def test_duration_limits_and_input_file_are_validated(self):
        for duration in (0, -1, 301, float("nan"), float("inf"), True, "20", 10**1000):
            with self.subTest(duration=str(duration)[:30]), self.assertRaises(ValueError):
                parse_command({"id": "x", "command": "transcribe", "audio_path": str(self.audio), "max_seconds": duration})
        for path in ("", str(self.root), str(self.root / "missing.mp3")):
            with self.subTest(path=path), self.assertRaises(ValueError):
                parse_command({"id": "x", "command": "transcribe", "audio_path": path})
        self.assertEqual(self.transcribe_command().max_seconds, 20.0)
        self.assertEqual(parse_command({"id": 1, "command": "transcribe", "audio_path": str(self.audio), "max_seconds": 300}).max_seconds, 300.0)

    def test_audio_name_is_an_optional_validated_basename(self):
        self.assertEqual(self.transcribe_command().audio_name, self.audio.name)
        for name in (None, "", "   ", ".", "..", "../song.mp3", "folder/song.mp3", "folder\\song.mp3", "bad\0.mp3", "a" * 1025):
            with self.subTest(name=name), self.assertRaises(ValueError):
                parse_command({"id": "x", "command": "transcribe", "audio_path": str(self.audio), "audio_name": name})
        command = parse_command({"id": "x", "command": "transcribe", "audio_path": str(self.audio), "audio_name": "Original mélodie.mp3"})
        self.assertEqual(command.audio_name, "Original mélodie.mp3")

    def test_model_is_loaded_only_once_and_exports_are_serialized(self):
        model = Mock()
        def transcribe(audio, *, output_dir, progress, **options):
            self.assertEqual(audio, self.audio)
            self.assertEqual(options, {"dtype": "fp32", "max_seconds": 20.0})
            progress({"stage": "encoding", "window": 1, "windows": 1, "start": 0})
            progress({"stage": "decoding", "window": 1, "windows": 1, "tokens": 64})
            write_exports(output_dir)
            return {"unsafe_tensor": object()}
        model.transcribe.side_effect = transcribe
        worker = self.make_worker(model)
        worker.dispatch(Command("load", "load"))
        worker.wait_idle()
        worker.dispatch(self.transcribe_command("first"))
        worker.wait_idle()
        worker.dispatch(self.transcribe_command("second"))
        worker.wait_idle()
        self.loader.assert_called_once_with(self.root)
        self.assertEqual(model.transcribe.call_count, 2)
        results = [event["result"] for event in self.events() if event["type"] == "result"]
        self.assertEqual(len(results), 2)
        self.assertNotEqual(results[0]["run_id"], results[1]["run_id"])
        self.assertEqual(results[0]["summary"]["melody_notes"], 2)
        self.assertIn("K:C", results[0]["abc"])
        self.assertEqual(results[0]["events"]["events"][0]["values"]["key"], "C:major")
        self.assertEqual(json.loads((Path(results[0]["output_dir"]) / "ui.json").read_text())["audio_path"], str(self.audio))
        self.assertTrue((Path(results[0]["output_dir"]) / ".desktop-job.json").is_file())
        self.assertTrue(all("model_loaded" in event for event in self.events() if event["type"] == "status"))
        self.assertTrue(all(event["model_loaded"] for event in self.events() if event["type"] == "result"))

    def test_original_audio_name_is_used_in_payload_and_history(self):
        model = Mock()
        model.transcribe.side_effect = lambda audio, *, output_dir, **options: write_exports(output_dir)
        worker = self.make_worker(model)
        command = parse_command({"id": "run", "command": "transcribe", "audio_path": str(self.audio), "audio_name": "Original mélodie.mp3"})
        worker.dispatch(command)
        worker.wait_idle()
        payload = next(event["result"] for event in self.events() if event["type"] == "result")
        self.assertEqual(payload["audio_name"], "Original mélodie.mp3")
        metadata = json.loads((Path(payload["output_dir"]) / "ui.json").read_text())
        self.assertEqual(metadata["audio_name"], "Original mélodie.mp3")

    def test_all_annotation_fields_and_available_exports_are_preserved(self):
        output = self.root / "exports"
        output.mkdir()
        write_exports(output)
        raw_events = {
            "schema_version": "v1",
            "events": [{"time": 0.25, "global_subbeat": 1, "values": {
                "timestamp": 0.25, "rhythm": {"meter": [6, 8], "eighth_position": 1},
                "structure": "verse", "key": "C:major", "chord": "C:maj",
                "melody": [{"pitch": 60, "track": 0, "end_time": 0.75}],
            }}],
        }
        (output / "events.json").write_text(json.dumps(raw_events), encoding="utf-8")
        for artifact, filename, label, kind in worker_module.ARTIFACTS:
            if kind == "annotation":
                (output / filename).write_text(f"0.25\t1.0\t{artifact}\n", encoding="utf-8")
            elif not (output / filename).exists():
                (output / filename).write_bytes(b"fixture")
        payload = worker_module.read_result(output, self.audio)
        self.assertEqual(payload["events"], raw_events)
        self.assertEqual(len(payload["annotations"]), 10)
        self.assertEqual(payload["annotations"]["rhythm_events"], "0.25\t1.0\trhythm_events\n")
        self.assertEqual([value["id"] for value in payload["available_artifacts"]],
                         [value[0] for value in worker_module.ARTIFACTS])
        self.assertEqual(len({value[0] for value in worker_module.ARTIFACTS}), len(worker_module.ARTIFACTS))
        json.dumps(payload, allow_nan=False)

    def test_optional_and_empty_annotations_are_distinguished(self):
        output = self.root / "exports"
        output.mkdir()
        write_exports(output)
        (output / "melody_instrumental.lab").write_text("", encoding="utf-8")
        (output / "unrecognized.lab").write_text("not allowlisted", encoding="utf-8")
        payload = worker_module.read_result(output, self.audio)
        self.assertEqual(payload["annotations"], {"melody_instrumental": ""})
        available = {value["id"] for value in payload["available_artifacts"]}
        self.assertIn("melody_instrumental", available)
        self.assertNotIn("beat_meter", available)
        self.assertNotIn("unrecognized", available)
        self.assertNotIn("device", payload["provenance"])

    def test_new_run_provenance_is_recorded_for_history_without_private_paths(self):
        (self.root / "sources.json").write_text(json.dumps({
            "model": "publisher/model", "model_revision": "pinned-revision",
            "base_model": "publisher/base", "base_revision": "base-revision",
            "private_local_path": str(self.root),
        }), encoding="utf-8")
        model = Mock()
        def transcribe(audio, *, output_dir, **options):
            write_exports(output_dir)
            summary = json.loads((output_dir / "result.json").read_text())
            summary.update({"preset": "default", "dtype": "fp32", "window_seconds": 300,
                            "prompts": ["timestamp", "downbeat_meter", "structure", "key", "chord_full", "melody_full"]})
            (output_dir / "result.json").write_text(json.dumps(summary), encoding="utf-8")
        model.transcribe.side_effect = transcribe
        worker = self.make_worker(model)
        worker.dispatch(self.transcribe_command())
        worker.wait_idle()
        payload = next(event["result"] for event in self.events() if event["type"] == "result")
        provenance = payload["provenance"]
        self.assertEqual(provenance["device"], "cpu")
        self.assertEqual(provenance["sources"]["model_revision"], "pinned-revision")
        self.assertEqual(provenance["recorded_settings"]["window_seconds"], 300)
        self.assertNotIn(str(self.root), json.dumps(provenance))
        metadata = json.loads((Path(payload["output_dir"]) / "ui.json").read_text())
        self.assertEqual(metadata["provenance"], provenance)

    def test_annotation_symlink_escape_and_oversized_export_are_rejected(self):
        output = self.root / "exports"
        output.mkdir()
        write_exports(output)
        (output / "key.lab").symlink_to(self.audio)
        with self.assertRaisesRegex(ValueError, "outside"):
            worker_module.read_result(output, self.audio)
        (output / "key.lab").unlink()
        with (output / "beat.lab").open("wb") as stream:
            stream.truncate(worker_module.MAX_EXPORT_BYTES + 1)
        with self.assertRaisesRegex(ValueError, "size limit"):
            worker_module.read_result(output, self.audio)

    def test_nonfinite_raw_event_is_rejected_before_serialization(self):
        output = self.root / "exports"
        output.mkdir()
        write_exports(output)
        (output / "events.json").write_text('{"events":[{"time":Infinity}]}', encoding="utf-8")
        with self.assertRaises(ValueError):
            worker_module.read_result(output, self.audio)

    def test_cancel_is_processed_while_inference_is_busy(self):
        entered = threading.Event()
        resume = threading.Event()
        model = Mock()
        def transcribe(audio, *, output_dir, progress, **options):
            progress({"stage": "encoding", "window": 1, "windows": 1})
            entered.set()
            self.assertTrue(resume.wait(3))
            progress({"stage": "decoding", "tokens": 64})
            write_exports(output_dir)
        model.transcribe.side_effect = transcribe
        worker = self.make_worker(model)
        worker.dispatch(self.transcribe_command())
        self.assertTrue(entered.wait(3))
        worker.handle_line('{"id":"busy","command":"load"}')
        worker.dispatch(Command("stop", "cancel"))
        self.assertTrue(any(event.get("state") == "cancelling" for event in self.events()))
        resume.set()
        worker.wait_idle()
        self.assertEqual([event["id"] for event in self.events() if event["type"] == "cancelled"], ["run"])
        self.assertFalse(any(event["type"] == "result" for event in self.events()))
        self.assertEqual(list((self.root / "runtime" / "outputs").glob("*/ui.json")), [])

    def test_cancel_after_model_exports_retains_pending_marker_without_success(self):
        exported = threading.Event()
        resume = threading.Event()
        model = Mock()
        def transcribe(audio, *, output_dir, progress, **options):
            self.assertTrue((output_dir / ".desktop-job.json").is_file())
            write_exports(output_dir)
            exported.set()
            self.assertTrue(resume.wait(3))
            progress({"stage": "complete"})
        model.transcribe.side_effect = transcribe
        worker = self.make_worker(model)
        worker.dispatch(self.transcribe_command())
        self.assertTrue(exported.wait(3))
        worker.dispatch(Command("stop", "cancel"))
        resume.set()
        worker.wait_idle()
        outputs = list((self.root / "runtime" / "outputs").iterdir())
        self.assertEqual(len(outputs), 1)
        self.assertTrue((outputs[0] / ".desktop-job.json").is_file())
        self.assertTrue((outputs[0] / "result.json").is_file())
        self.assertFalse((outputs[0] / "ui.json").exists())
        self.assertFalse(any(event["type"] == "result" for event in self.events()))

    def test_cancel_during_loading_preserves_loaded_model(self):
        entered = threading.Event()
        resume = threading.Event()
        model = Mock()
        def loader(root):
            entered.set()
            self.assertTrue(resume.wait(3))
            return model
        worker = self.make_worker(loader=loader)
        worker.dispatch(Command("load", "load"))
        self.assertTrue(entered.wait(3))
        worker.dispatch(Command("cancel", "cancel"))
        resume.set()
        worker.wait_idle()
        self.assertIs(worker.model, model)
        self.assertTrue(any(event["type"] == "cancelled" for event in self.events()))
        self.assertTrue(next(event for event in self.events() if event["type"] == "cancelled")["model_loaded"])
        self.assertEqual(self.events()[-1]["state"], "ready")

    def test_error_does_not_create_success_marker_and_model_can_retry(self):
        model = Mock()
        model.transcribe.side_effect = RuntimeError("Audio decoder failed")
        worker = self.make_worker(model)
        with redirect_stderr(io.StringIO()):
            worker.dispatch(self.transcribe_command())
            worker.wait_idle()
        self.assertTrue(any(event.get("message") == "Audio decoder failed" for event in self.events()))
        self.assertEqual(list((self.root / "runtime" / "outputs").glob("*/ui.json")), [])
        model.transcribe.side_effect = lambda audio, *, output_dir, **options: write_exports(output_dir)
        worker.dispatch(self.transcribe_command("retry"))
        worker.wait_idle()
        self.assertTrue(any(event["type"] == "result" and event["id"] == "retry" for event in self.events()))
        self.loader.assert_called_once()

    def test_terminal_error_and_cancellation_release_task_before_retry_signal(self):
        for exception in (RuntimeError("first request failed"), worker_module.Cancelled()):
            with self.subTest(exception=type(exception).__name__):
                output = io.StringIO()
                observed_tasks = []
                model = Mock()
                def transcribe(audio, *, output_dir, **options):
                    if model.transcribe.call_count == 1:
                        raise exception
                    write_exports(output_dir)
                model.transcribe.side_effect = transcribe
                class ObservingEmitter(JsonEmitter):
                    def emit(emitter, request_id, event_type, **fields):
                        if event_type in ("error", "cancelled") and request_id == "first":
                            # This is exactly when the native app can signal a
                            # retry. The active task must already be released.
                            observed_tasks.append(worker.task)
                        super().emit(request_id, event_type, **fields)
                worker = InferenceWorker(self.root, ObservingEmitter(output), model_loader=lambda root: model)
                self.addCleanup(worker.close)
                with redirect_stderr(io.StringIO()):
                    worker.dispatch(self.transcribe_command("first"))
                    worker.wait_idle()
                self.assertEqual(observed_tasks, [None])
                worker.dispatch(self.transcribe_command("retry"))
                worker.wait_idle()
                events = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertTrue(any(event["type"] == "result" and event["id"] == "retry" for event in events))
                self.assertTrue(all(event["model_loaded"] for event in events if event["type"] in ("result", "error", "cancelled")))

    def test_nonfinite_model_export_does_not_mark_history_success(self):
        model = Mock()
        def transcribe(audio, *, output_dir, **options):
            write_exports(output_dir)
            (output_dir / "result.json").write_text('{"duration_seconds": NaN}')
        model.transcribe.side_effect = transcribe
        worker = self.make_worker(model)
        with redirect_stderr(io.StringIO()):
            worker.dispatch(self.transcribe_command())
            worker.wait_idle()
        self.assertFalse(any(event["type"] == "result" for event in self.events()))
        self.assertEqual(list((self.root / "runtime" / "outputs").glob("*/ui.json")), [])

    def test_shutdown_cancels_and_joins_active_task(self):
        entered = threading.Event()
        resume = threading.Event()
        def loader(root):
            entered.set()
            self.assertTrue(resume.wait(3))
            return Mock()
        worker = self.make_worker(loader=loader)
        worker.dispatch(Command("load", "load"))
        self.assertTrue(entered.wait(3))
        self.assertFalse(worker.dispatch(Command("close", "shutdown")))
        resume.set()
        worker.close()
        self.assertIsNone(worker.task)
        self.assertTrue(any(event["type"] == "cancelled" for event in self.events()))

    def test_json_emitter_preserves_unicode_and_line_boundaries(self):
        emitter = JsonEmitter(self.output)
        emitter.emit("x", "error", message="mélodie\nnext line")
        self.assertEqual(len(self.output.getvalue().splitlines()), 1)
        self.assertEqual(self.events()[0]["message"], "mélodie\nnext line")
        with self.assertRaises(ValueError):
            emitter.emit("x", "result", value=float("nan"))

    def test_real_stdio_protocol_stays_json_and_eof_exits(self):
        # Exercise fd isolation and EOF handling without starting the model.
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("worker.py")), "--lab-root", str(self.root)],
            input='not json\n{"id":"stop","command":"cancel"}\n',
            text=True, capture_output=True, timeout=10, check=True,
        )
        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([event["type"] for event in events], ["connected", "error", "status"])
        self.assertNotIn("state", events[0])
        self.assertEqual(events[-1]["state"], "idle")


if __name__ == "__main__":
    unittest.main()
