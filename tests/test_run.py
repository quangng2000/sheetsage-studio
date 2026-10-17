"""Offline setup/CLI tests: no packages, checkpoints, or network are needed."""

from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import call, patch


SPEC = importlib.util.spec_from_file_location("sheetsage_setup", Path(__file__).resolve().parents[1] / "run.py")
assert SPEC is not None and SPEC.loader is not None
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class RunnerTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.storage = self.root / "runtime"
        self.patch("ROOT", self.root)
        # Small files exercise the real size checks without allocating GiB.
        self.patch("MODEL_WEIGHTS_BYTES", 5)
        self.patch("BASE_WEIGHTS_BYTES", 7)
        self.urlopen = self.patch("urlopen", side_effect=AssertionError("Unexpected network access"))
        self.subprocess_run = patch.object(runner.subprocess, "run", side_effect=AssertionError("Unexpected subprocess"))
        self.subprocess_run.start()
        self.addCleanup(self.subprocess_run.stop)
        self.output = io.StringIO()
        capture = redirect_stdout(self.output)
        capture.__enter__()
        self.addCleanup(capture.__exit__, None, None, None)

    def patch(self, name, *args, **kwargs):
        patcher = patch.object(runner, name, *args, **kwargs)
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def write(self, path: Path, content: bytes = b"fixture") -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def ready_runtime(self) -> None:
        for filename in (".venv/bin/python", "model/infer.py", "model/config.json"):
            self.write(self.storage / filename)
        self.write(self.storage / "model/model.safetensors", b"model")
        self.write(runner.base_snapshot(self.storage) / "config.json")
        self.write(runner.base_snapshot(self.storage) / "model.safetensors", b"encoder")

    def disk(self, free: int) -> None:
        self.patch("storage_usage", return_value=SimpleNamespace(free=free))
        self.patch("shutil", wraps=runner.shutil).which.return_value = "/tools/ffmpeg"

    def setup_tools(self) -> None:
        self.patch("check", return_value=0)
        self.patch("shutil", wraps=runner.shutil).which.side_effect = lambda name, **kwargs: f"/tools/{name}"

    def test_runtime_requires_complete_pinned_files(self):
        self.assertFalse(runner.runtime_ready(self.storage))
        self.ready_runtime()
        self.assertTrue(runner.runtime_ready(self.storage))
        base = runner.base_snapshot(self.storage)
        self.assertEqual(base.name, "d8ba1c745e733b3908ce6ad16ebeb17ac7600a42")
        for path in (
            self.storage / ".venv/bin/python", self.storage / "model/infer.py",
            self.storage / "model/config.json", base / "config.json",
            self.storage / "model/model.safetensors", base / "model.safetensors",
        ):
            with self.subTest(file=path.relative_to(self.storage)):
                saved = path.read_bytes()
                path.unlink()
                self.assertFalse(runner.runtime_ready(self.storage))
                path.write_bytes(saved)

    def test_runtime_rejects_incomplete_or_wrong_sized_weights(self):
        self.ready_runtime()
        for path in (self.storage / "model/model.safetensors", runner.base_snapshot(self.storage) / "model.safetensors"):
            with self.subTest(file=path):
                original = path.read_bytes()
                for content in (b"", original[:-1], original + b"x"):
                    path.write_bytes(content)
                    self.assertFalse(runner.runtime_ready(self.storage))
                path.write_bytes(original)
        self.assertTrue(runner.runtime_ready(self.storage))

    def test_nonready_runtime_needs_setup_budget(self):
        self.disk(runner.MINIMUM_SETUP_FREE_BYTES - 1)
        self.assertEqual(runner.check(self.storage), 1)
        self.assertIn("setup required", self.output.getvalue())

    def test_nonready_runtime_accepts_exact_setup_budget(self):
        self.disk(runner.MINIMUM_SETUP_FREE_BYTES)
        self.assertEqual(runner.check(self.storage), 0)

    def test_ready_runtime_accepts_smaller_inference_budget(self):
        self.ready_runtime()
        self.disk(runner.MINIMUM_INFERENCE_FREE_BYTES)
        self.assertEqual(runner.check(self.storage), 0)
        self.assertIn("ready (not a model-load health check)", self.output.getvalue())

    def test_ready_runtime_still_requires_output_headroom(self):
        self.ready_runtime()
        self.disk(runner.MINIMUM_INFERENCE_FREE_BYTES - 1)
        self.assertEqual(runner.check(self.storage), 1)

    def test_setup_bootstraps_own_requirements_and_exact_pinned_downloads(self):
        self.setup_tools()
        self.patch("runtime_ready", return_value=True)
        execute = self.patch("call")
        self.assertEqual(runner.setup(self.storage), 0)
        python = str(self.storage / ".venv/bin/python")
        self.assertEqual(execute.call_args_list, [
            call(["/tools/uv", "venv", "--python", "3.11", str(self.storage / ".venv")], self.storage),
            call(["/tools/uv", "--no-cache", "pip", "install", "--python", python, "-r", str(self.root / "requirements-model.txt")], self.storage),
            call([
                "/tools/hf", "download", "m-a-p/SheetSage2", "--revision", "b83c3d79a6d98bcffaf8f9ed112c90aa887887bc",
                "--local-dir", str(self.storage / "model"),
                "--include", "*.py", "--include", "*.json", "--include", "*.txt",
                "--include", "LICENSE", "--include", "THIRD_PARTY_NOTICES.md",
                "--include", "model.safetensors", "--max-workers", "4",
            ], self.storage),
            call([
                "/tools/hf", "download", "m-a-p/MERT-v2-FullSong", "--revision", "d8ba1c745e733b3908ce6ad16ebeb17ac7600a42",
                "--include", "*.py", "--include", "config.json", "--include", "model.safetensors", "--max-workers", "4",
            ], self.storage),
        ])
        self.assertNotIn("vendor", str(execute.call_args_list))
        self.urlopen.assert_not_called()

    def test_setup_reuses_existing_python_environment(self):
        self.setup_tools()
        self.ready_runtime()
        execute = self.patch("call")
        self.assertEqual(runner.setup(self.storage), 0)
        self.assertFalse(any("venv" in request.args[0] for request in execute.call_args_list))

    def test_setup_stops_before_install_when_disk_check_fails(self):
        self.patch("check", return_value=1)
        execute = self.patch("call")
        self.assertEqual(runner.setup(self.storage), 1)
        execute.assert_not_called()
        self.assertFalse(self.storage.exists())

    def test_setup_rejects_missing_tools_or_incomplete_download(self):
        self.patch("check", return_value=0)
        which = self.patch("shutil", wraps=runner.shutil).which
        execute = self.patch("call")
        for missing in ("uv", "hf"):
            with self.subTest(missing=missing):
                which.side_effect = lambda name, **kwargs: None if name == missing else f"/tools/{name}"
                with self.assertRaisesRegex(ValueError, "requires uv and hf"):
                    runner.setup(self.storage)
                execute.assert_not_called()
        which.side_effect = lambda name, **kwargs: f"/tools/{name}"
        with self.assertRaisesRegex(ValueError, "complete pinned runtime"):
            runner.setup(self.storage)

    def sample_response(self, content: bytes) -> None:
        self.patch("SAMPLE_SHA256", hashlib.sha256(content).hexdigest())
        self.urlopen.side_effect = None
        self.urlopen.return_value = io.BytesIO(content)

    def test_sample_download_is_checksummed_and_then_idempotent(self):
        content = b"small official sample fixture"
        self.sample_response(content)
        self.assertEqual(runner.download_sample(), 0)
        target = self.root / "samples/demo.mp3"
        self.assertEqual(target.read_bytes(), content)
        self.urlopen.assert_called_once_with(runner.SAMPLE_URL, timeout=60)
        self.assertEqual(list(target.parent.glob("*.part")), [])
        self.assertEqual(runner.download_sample(), 0)
        self.urlopen.assert_called_once()

    def test_sample_existing_mismatch_is_not_overwritten(self):
        target = self.root / "samples/demo.mp3"
        self.write(target, b"my own recording")
        with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
            runner.download_sample()
        self.assertEqual(target.read_bytes(), b"my own recording")
        self.urlopen.assert_not_called()

    def test_sample_hash_mismatch_leaves_no_target_or_partial(self):
        self.sample_response(b"downloaded fixture")
        self.patch("SAMPLE_SHA256", "0" * 64)
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            runner.download_sample()
        self.assertEqual(list((self.root / "samples").iterdir()), [])

    def test_sample_network_failure_leaves_no_partial(self):
        self.urlopen.side_effect = OSError("network unavailable")
        with self.assertRaisesRegex(OSError, "network unavailable"):
            runner.download_sample()
        self.assertEqual(list((self.root / "samples").iterdir()), [])

    def test_sample_interrupted_transfer_cleans_written_partial(self):
        class InterruptedResponse(io.BytesIO):
            def read(self, size=-1):
                if self.tell():
                    raise OSError("connection lost during transfer")
                return super().read(size)

        self.urlopen.side_effect = None
        self.urlopen.return_value = InterruptedResponse(b"received partial data")
        with self.assertRaisesRegex(OSError, "connection lost during transfer"):
            runner.download_sample()
        self.assertEqual(list((self.root / "samples").iterdir()), [])

    def test_sample_size_limit_stops_download_and_cleans_partial(self):
        self.sample_response(b"x" * (8 * 1024**2 + 1))
        with self.assertRaisesRegex(ValueError, "unexpectedly large"):
            runner.download_sample()
        self.assertEqual(list((self.root / "samples").iterdir()), [])

    def test_duration_is_validated_before_any_model_or_subprocess_work(self):
        execute = self.patch("call")
        ready = self.patch("runtime_ready", side_effect=AssertionError("Runtime must not be accessed"))
        for duration in (float("nan"), float("inf"), float("-inf"), 0, -1, 300.1):
            with self.subTest(duration=duration), self.assertRaisesRegex(ValueError, "max-seconds must be finite"):
                runner.transcribe(self.storage, argparse.Namespace(audio=self.root / "missing.mp3", max_seconds=duration, device="cpu"))
        ready.assert_not_called()
        execute.assert_not_called()

    def test_transcribe_requires_runtime_audio_and_output_headroom(self):
        args = argparse.Namespace(audio=self.root / "song.mp3", max_seconds=20.0, device="cpu")
        execute = self.patch("call")
        with self.assertRaisesRegex(ValueError, "runtime or weights are missing"):
            runner.transcribe(self.storage, args)
        self.ready_runtime()
        with self.assertRaisesRegex(ValueError, "audio file does not exist"):
            runner.transcribe(self.storage, args)
        self.write(args.audio)
        self.patch("storage_usage", return_value=SimpleNamespace(free=runner.MINIMUM_INFERENCE_FREE_BYTES - 1))
        with self.assertRaisesRegex(ValueError, "256 MiB"):
            runner.transcribe(self.storage, args)
        execute.assert_not_called()

    def test_transcribe_explicitly_uses_local_cpu_fp32_and_duration(self):
        self.ready_runtime()
        audio = self.root / "song with spaces.mp3"
        self.write(audio)
        self.patch("storage_usage", return_value=SimpleNamespace(free=runner.MINIMUM_INFERENCE_FREE_BYTES))
        execute = self.patch("call")
        self.assertEqual(runner.transcribe(self.storage, argparse.Namespace(audio=audio, max_seconds=300.0, device="cpu")), 0)
        args, storage = execute.call_args.args
        self.assertEqual(storage, self.storage)
        self.assertEqual(args[:3], [str(self.storage / ".venv/bin/python"), str(self.storage / "model/infer.py"), str(audio)])
        self.assertEqual(args[-7:], ["--device", "cpu", "--dtype", "fp32", "--max-seconds", "300.0", "--local-files-only"])
        self.assertEqual(Path(args[args.index("--output") + 1]).parent, self.storage / "outputs")


if __name__ == "__main__":
    unittest.main()
