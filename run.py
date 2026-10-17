"""Prepare and run the official SheetSage2 model locally.

Examples:
    python3 run.py check
    python3 run.py setup
    python3 run.py download-sample
    python3 run.py transcribe samples/demo.mp3
    python3 run.py --storage /Volumes/External/SheetSage2 setup

Setup needs at least 8 GiB free for checkpoints, Python, packages, and temporary
downloads. Inference uses the official CPU path by default. Apple MPS can be
selected explicitly for experimentation; it has not been validated here.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent
MODEL_ID = "m-a-p/SheetSage2"
MODEL_REVISION = "b83c3d79a6d98bcffaf8f9ed112c90aa887887bc"
BASE_ID = "m-a-p/MERT-v2-FullSong"
BASE_REVISION = "d8ba1c745e733b3908ce6ad16ebeb17ac7600a42"
MINIMUM_SETUP_FREE_BYTES = 8 * 1024**3
MINIMUM_INFERENCE_FREE_BYTES = 256 * 1024**2
MODEL_WEIGHTS_BYTES = 228_738_564
BASE_WEIGHTS_BYTES = 2_529_812_848
SAMPLE_URL = "https://map-yue2.github.io/assets/covers/where-is-my-wallet-chord/where-is-my-wallet-chord.mp3"
SAMPLE_SHA256 = "fc9af1b1d1f05381c3479f92773a8959e18b7aaec49c057d068ba0cd52295807"


def storage_usage(storage: Path) -> shutil._ntuple_diskusage:
    existing = storage
    while not existing.exists():
        existing = existing.parent
    return shutil.disk_usage(existing)


def environment(storage: Path) -> dict[str, str]:
    values = os.environ.copy()
    values["HF_HOME"] = str(storage / "huggingface")
    values["HF_HUB_CACHE"] = str(storage / "huggingface" / "hub")
    values["PYTHONDONTWRITEBYTECODE"] = "1"
    values["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    values["PATH"] = str(storage / ".venv/bin") + os.pathsep + values.get("PATH", "")
    return values


def call(arguments: list[str], storage: Path) -> None:
    print("Running:", " ".join(arguments), flush=True)
    subprocess.run(arguments, env=environment(storage), check=True)


def base_snapshot(storage: Path) -> Path:
    return storage / "huggingface/hub/models--m-a-p--MERT-v2-FullSong/snapshots" / BASE_REVISION


def has_expected_size(path: Path, expected: int) -> bool:
    return path.is_file() and path.stat().st_size == expected


def runtime_ready(storage: Path) -> bool:
    """Check required files, not package imports or a costly model load."""
    return (
        (storage / ".venv/bin/python").is_file()
        and (storage / "model/infer.py").is_file()
        and (storage / "model/config.json").is_file()
        and has_expected_size(storage / "model/model.safetensors", MODEL_WEIGHTS_BYTES)
        and (base_snapshot(storage) / "config.json").is_file()
        and has_expected_size(base_snapshot(storage) / "model.safetensors", BASE_WEIGHTS_BYTES)
    )


def check(storage: Path) -> int:
    free = storage_usage(storage).free
    print(f"Runtime storage: {storage}")
    print(f"Available disk: {free / 1024**3:.2f} GiB")
    print("Checkpoints: 2,758,551,412 bytes total (about 2.76 GB)")
    print("Setup budget: at least 8 GiB free, including dependencies and headroom")
    print(f"Python environment: {'present' if (storage / '.venv/bin/python').is_file() else 'missing'}")
    print(f"SheetSage2 weights: {'present' if (storage / 'model/model.safetensors').is_file() else 'missing'}")
    ready = runtime_ready(storage)
    print(f"Pinned base weights: {'present' if has_expected_size(base_snapshot(storage) / 'model.safetensors', BASE_WEIGHTS_BYTES) else 'missing or incomplete'}")
    print(f"Runtime files: {'ready (not a model-load health check)' if ready else 'setup required'}")
    ffmpeg = shutil.which("ffmpeg", path=environment(storage)["PATH"])
    print(f"FFmpeg: {ffmpeg or 'missing; setup will install a local executable'}")
    print("Official inference pads each encoder window to 300 seconds, even for short clips.")
    required = MINIMUM_INFERENCE_FREE_BYTES if ready else MINIMUM_SETUP_FREE_BYTES
    if free < required:
        print("BLOCKED: free disk space or select an external drive with --storage.")
        return 1
    return 0


def setup(storage: Path) -> int:
    if check(storage):
        return 1
    uv = shutil.which("uv")
    hf = shutil.which("hf")
    if not uv or not hf:
        raise ValueError("setup requires uv and hf on PATH; install hf with: uv tool install huggingface-hub==1.27.0")
    storage.mkdir(parents=True, exist_ok=True)
    python = storage / ".venv/bin/python"
    if not python.is_file():
        call([uv, "venv", "--python", "3.11", str(storage / ".venv")], storage)
    call([
        uv, "--no-cache", "pip", "install", "--python", str(python), "-r",
        str(ROOT / "requirements-model.txt"),
    ], storage)
    if not shutil.which("ffmpeg", path=environment(storage)["PATH"]):
        call([
            uv, "--no-cache", "pip", "install", "--python", str(python),
            "imageio-ffmpeg==0.6.0",
        ], storage)
        binary = subprocess.check_output(
            [str(python), "-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"],
            env=environment(storage), text=True,
        ).strip()
        ffmpeg_link = storage / ".venv/bin/ffmpeg"
        if ffmpeg_link.is_symlink():
            ffmpeg_link.unlink()  # Replace only a broken local-environment link.
        ffmpeg_link.symlink_to(binary)
    call([
        hf, "download", MODEL_ID, "--revision", MODEL_REVISION,
        "--local-dir", str(storage / "model"),
        "--include", "*.py", "--include", "*.json", "--include", "*.txt",
        "--include", "LICENSE", "--include", "THIRD_PARTY_NOTICES.md",
        "--include", "model.safetensors", "--max-workers", "4",
    ], storage)
    call([
        hf, "download", BASE_ID, "--revision", BASE_REVISION,
        "--include", "*.py", "--include", "config.json",
        "--include", "model.safetensors", "--max-workers", "4",
    ], storage)
    if not runtime_ready(storage):
        raise ValueError("setup did not produce the complete pinned runtime; rerun setup to resume downloads")
    print("Setup complete. Next: python3 run.py download-sample")
    return 0


def download_sample() -> int:
    """Fetch an optional upstream demo; do not redistribute it in this repo."""
    target = ROOT / "samples/demo.mp3"
    if target.exists():
        if hashlib.sha256(target.read_bytes()).hexdigest() != SAMPLE_SHA256:
            raise ValueError("samples/demo.mp3 differs from the pinned sample; refusing to overwrite it")
        print(f"Sample already verified: {target}")
        return 0
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        digest = hashlib.sha256()
        total = 0
        with urlopen(SAMPLE_URL, timeout=60) as response, tempfile.NamedTemporaryFile(
            dir=target.parent, prefix=".demo-", suffix=".part", delete=False,
        ) as output:
            temporary = Path(output.name)
            while block := response.read(64 * 1024):
                total += len(block)
                if total > 8 * 1024**2:
                    raise ValueError("upstream demo is unexpectedly large; download stopped")
                digest.update(block)
                output.write(block)
        if digest.hexdigest() != SAMPLE_SHA256:
            raise ValueError("sample SHA-256 mismatch; upstream content changed, no sample installed")
        temporary.replace(target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    print(f"Downloaded and SHA-256 verified: {target}")
    return 0


def transcribe(storage: Path, arguments: argparse.Namespace) -> int:
    python = storage / ".venv/bin/python"
    model = storage / "model"
    if not math.isfinite(arguments.max_seconds) or not 0 < arguments.max_seconds <= 300:
        raise ValueError("max-seconds must be finite, greater than 0 and at most 300")
    if not runtime_ready(storage):
        raise ValueError("runtime or weights are missing; run the setup command first")
    audio = arguments.audio.expanduser().resolve()
    if not audio.is_file():
        raise ValueError(f"audio file does not exist: {audio}")
    if storage_usage(storage).free < MINIMUM_INFERENCE_FREE_BYTES:
        raise ValueError("at least 256 MiB free is required for transcription output")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output = storage / "outputs" / f"{audio.stem}-{stamp}"
    print("The official encoder processes a 300-second window; encoding may take time.")
    call([
        str(python), str(model / "infer.py"), str(audio),
        "--model", str(model), "--output", str(output),
        "--device", arguments.device, "--dtype", "fp32",
        "--max-seconds", str(arguments.max_seconds), "--local-files-only",
    ], storage)
    print(f"Transcription outputs: {output}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--storage", type=Path, default=ROOT / "runtime")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check", help="check disk and runtime without downloading")
    commands.add_parser("setup", help="install official requirements and download pinned weights")
    commands.add_parser("download-sample", help="download and checksum-verify the optional upstream demo")
    inference = commands.add_parser("transcribe", help="run local inference on a music recording")
    inference.add_argument("audio", type=Path)
    inference.add_argument("--max-seconds", type=float, default=20)
    inference.add_argument("--device", choices=("cpu", "mps"), default="cpu")
    arguments = parser.parse_args()
    storage = arguments.storage.expanduser().resolve()
    try:
        if arguments.command == "check":
            return check(storage)
        if arguments.command == "setup":
            return setup(storage)
        if arguments.command == "download-sample":
            return download_sample()
        return transcribe(storage, arguments)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"SheetSage2: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
