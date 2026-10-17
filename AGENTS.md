# Agent instructions

## Purpose and scope

SheetSage Studio is a macOS-tested Rust/Tauri desktop UI around the official SheetSage2 Python model. It is a local inference lab, not a new model implementation, a training stack, a hosted service, or live microphone transcription.

Read [README.md](README.md), then follow [docs/AGENT_RUNBOOK.md](docs/AGENT_RUNBOOK.md) for clean-machine installation, downloads, verification, and troubleshooting. Run commands from the repository root unless explicitly stated otherwise.

## Repository boundaries

| Path | Responsibility |
| --- | --- |
| `run.py` | Runtime preflight, environment setup, pinned downloads, sample download, CLI inference |
| `requirements-model.txt` | Pinned model Python dependencies |
| `sources.json` | Upstream provenance, revisions, and sample verification data |
| `desktop/src/main.rs` | Tauri commands, app lifecycle, allowed file boundaries |
| `desktop/src/worker.rs` | Persistent Python process and request/event lifecycle |
| `desktop/src/catalog.rs` | Imported audio, history, artifact validation and export |
| `desktop/worker.py` | Validated JSON-lines protocol and CPU model execution |
| `desktop/ui/` | Buildless HTML/CSS/JavaScript, score and piano-roll views |
| `runtime/` | Downloaded Python environment, models, imported audio, private output; never commit |

No npm install or frontend bundler is required. Retain `desktop/Cargo.lock` and use Cargo's `--locked` flag. Do not silently upgrade model revisions, Python dependencies, Rust dependencies, or the bundled abcjs asset.

## First run

Check free disk and installed tools before downloading. Allow 8 GiB for fresh model setup plus roughly 2 GiB of Rust-build headroom. `python3 run.py setup` downloads model files and executes upstream model Python code during inference. Review the pinned sources and their terms before running untrusted changes. Do not replace the pinned revisions with `main`.

```sh
uv tool install huggingface-hub==1.27.0
python3 run.py check
python3 run.py setup
python3 run.py download-sample
python3 run.py transcribe samples/demo.mp3 --max-seconds 20
cargo run --manifest-path desktop/Cargo.toml --locked
```

If `hf` is not on PATH, run `uv tool update-shell` and start a new terminal. Model setup creates `runtime/.venv` with Python 3.11; do not install model packages globally. The desktop worker requires the default `runtime/` within this checkout; `--storage` currently changes CLI storage only.

## Verification without model downloads

```sh
python3 -m unittest discover -s tests -v
python3 -m unittest discover -s desktop -p 'test_*.py' -v
cargo test --manifest-path desktop/Cargo.toml --locked
node --check desktop/ui/app.js
```

Node is optional for the JavaScript syntax check, not an app runtime requirement. Python worker tests use a fake model and must not download weights or import torch. Rust tests validate catalog paths and lifecycle behavior without model inference.

For a model-related change, also run one real CPU/FP32 transcription and inspect `result.json`, `events.json`, `playback.json`, and any generated ABC/MIDI. For a UI change, exercise the native app, not only a browser mock. Report whether validation used a fake model, real inference, or visual inspection.

## Invariants to preserve

- Keep model loading/inference outside the GUI process and keep the worker warm between requests.
- Worker stdout is JSON lines only. Python and native-library diagnostics belong on stderr.
- Preserve request IDs, validation, one-active-job behavior, and cancellation/error recovery. Do not fabricate progress percentages.
- Desktop inference uses local files only. Do not add upload, telemetry, credentials, or cloud dependencies without an explicit request.
- Preserve canonical-path restrictions and artifact allowlists. Imported recordings belong in `runtime/uploads/`.
- A desktop run is successful only after `ui.json` is atomically published. Cancelled or failed partial outputs must not appear as successful history.
- Do not represent the `.app` as self-contained: it depends on this checkout, Python, and downloaded model files.
- MPS is unvalidated; the desktop uses CPU/FP32. Do not claim GPU acceleration or real-time audio streaming without implementation and measurement.

## Safety and publication

Never commit downloaded weights, Hugging Face caches, Python environments, user audio, transcription outputs, generated builds, tokens, or machine-specific paths. Do not commit `vendor/` or `desktop/asset-source/`; setup obtains upstream model code separately. Keep third-party license notices intact. The MERT weights are CC BY-NC 4.0; do not imply an app-source license makes the model commercially licensed.

Do not delete another model cache or private recording to make room. If space is insufficient, report the exact requirement and ask the user to choose what to remove or use an external location. Do not publish repositories, change visibility, push releases, or deploy services without the user's authorization for that action.
