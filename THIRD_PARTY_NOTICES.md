# Third-party notices

The root Apache-2.0 license applies to original SheetSage Studio application
code and documentation, not to separately downloaded models, audio, or upstream
source code. This repository does not redistribute model weights or demo audio.

## Bundled: abcjs 6.6.3

- File: `desktop/ui/assets/abcjs-basic-min.js`
- Project: [paulrosen/abcjs](https://github.com/paulrosen/abcjs)
- License: MIT; full notice preserved in
  [`desktop/ui/assets/LICENSE.abcjs`](desktop/ui/assets/LICENSE.abcjs).
- Used locally to engrave ABC notation. No CDN is used at runtime.

## Downloaded during setup: SheetSage2 and MERT

- Paper: [SheetSage2: Coherent Lead-Sheet Transcription with Synthetic Supervision](https://arxiv.org/abs/2610.05336).
- SheetSage2: [m-a-p/SheetSage2](https://huggingface.co/m-a-p/SheetSage2),
  revision `b83c3d79a6d98bcffaf8f9ed112c90aa887887bc`.
- Base encoder: [MERT2 FullSong / m-a-p/MERT-v2-FullSong](https://huggingface.co/m-a-p/MERT-v2-FullSong),
  revision `d8ba1c745e733b3908ce6ad16ebeb17ac7600a42`.
- The upstream MERT2 model-weight license identifies the MERT2 checkpoint
  weights as **CC BY-NC 4.0 (noncommercial)**. Read the
  [upstream weight license](https://huggingface.co/m-a-p/MERT-v2-FullSong/blob/d8ba1c745e733b3908ce6ad16ebeb17ac7600a42/LICENSE)
  and model cards before use.
- Setup downloads the SheetSage2 `LICENSE` and `THIRD_PARTY_NOTICES.md` into
  `runtime/model/`. Those terms do not become Apache-2.0 merely because this
  application uses the model. The upstream weight license does not grant a
  blanket license for all model code or adapter artifacts.
- Inference executes the pinned upstream Python model code with
  `trust_remote_code=True`. Review that snapshot before setup/inference if your
  environment requires a source-code audit. Pinning is not a security guarantee.

## Optional downloaded demo audio

`python3 run.py download-sample` fetches the
[“where-is-my-wallet-chord” project demo](https://map-yue2.github.io/assets/covers/where-is-my-wallet-chord/where-is-my-wallet-chord.mp3)
and verifies the SHA-256 recorded in `sources.json`. The audio is not part of
this repository's Apache-2.0 grant. No redistribution permission is asserted;
use your own appropriately licensed audio if its terms do not fit your use.

## Dependencies

Rust dependencies are pinned in `desktop/Cargo.lock`. Python direct dependencies
are pinned in `requirements-model.txt`; their transitive dependencies are not a
complete lockfile. All dependencies retain their respective licenses, including
any FFmpeg executable installed through `imageio-ffmpeg`. Setup uses an existing
FFmpeg when available; the bundled fallback is for convenience, not a claim of
bit-exact reproduction of the paper's audio-decoding environment.
