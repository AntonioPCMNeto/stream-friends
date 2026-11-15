# scrima-capture

Native Windows screen-capture helper for the desktop app. Chromium's `getDisplayMedia` copies every
frame off the GPU before encoding, which costs most of the frames on AMD cards next to a game. This
captures with Windows Graphics Capture, converts BGRA -> NV12 and encodes H.264 on the GPU
(hardware Media Foundation encoder), and publishes the result straight to the LiveKit SFU as a
pre-encoded track.

- `publish --url wss://... --token ... [--fps 60 --kbps 8000 --height 1080] [--hwnd N | --point x,y]`
  is what `main.js` runs. One JSON object per line on stdout (`connected`, `started`, `stats`,
  `disconnected`, `error`, `stopped`); stdin takes `kbps N` or `stop` (closing stdin also stops it).
- `bench [--seconds N --fps 60 --kbps 8000 --height H --window TITLE | --hwnd N | --point x,y --out f.h264]`
  captures and encodes without publishing and prints a per-second table. Use it while a game is
  running to see what the machine can actually deliver.

Build: `npm run build:native` (needs Rust and the MSVC C++ build tools). The static CRT in
The repo-root `.cargo/config.toml` (cargo reads it from the working directory upward, so it must not live inside the crate) is required because LiveKit's prebuilt libwebrtc is built with `/MT`. The
installer picks the exe up from `target/release` (see `extraResources` in package.json).

AMD quirk handled in `pipeline.rs`: the encoder sizes frames as if the stream ran at 30 fps, so above
30 fps the bitrate parameter is scaled by 30/fps.
