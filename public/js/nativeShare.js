// Desktop only: the screen's video comes from the native capture helper (see
// startNativeShare() in main.js), which publishes it to the SFU itself. Chromium's
// getDisplayMedia copies every frame off the GPU before it is encoded, which is
// where AMD cards lose most of their frames next to a game; the helper keeps the
// whole path on the GPU. Everything here is best-effort: any failure returns null
// and share.js keeps using getDisplayMedia.
import { state } from './state.js';
import { requestNativeToken, autoBitrateKbps } from './sfu.js';

let lostHandler = null;

async function available() {
  try {
    return Boolean(window.nativeShare && await window.nativeShare.available());
  } catch {
    return false;
  }
}

function onHelperEvent(event) {
  if (!state.nativeScreen) return;
  if (event.event === 'stats') {
    state.nativeStats = event;
  } else if (event.event === 'disconnected' || event.event === 'exited' || event.event === 'error') {
    lostHandler?.(event);
  }
}

// A video track that never carries frames. The rest of the page (tiles, stats,
// the share's lifetime) expects a MediaStream with a video track in it; the real
// picture is not in this process.
function placeholderVideoTrack() {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  canvas.getContext('2d').fillRect(0, 0, 2, 2);
  return canvas.captureStream(1).getVideoTracks()[0];
}

// Starts the helper for the picked source. Resolves null when native capture
// isn't usable here (no helper, not on the SFU, helper failed), otherwise a
// MediaStream holding the placeholder video track, with `audioTracks` added.
export async function startNativeVideo({ sourceId, fps, height, kbps, audioTracks, onLost }) {
  if (!(await available())) return null;
  const reply = await requestNativeToken();
  if (!reply) return null;

  const result = await window.nativeShare.start({
    url: reply.url,
    token: reply.token,
    sourceId,
    fps,
    height,
    kbps,
  }).catch(() => ({ ok: false, reason: 'ipc' }));
  if (!result.ok) {
    console.warn('[native] capture helper did not start:', result.reason);
    return null;
  }

  lostHandler = onLost;
  window.nativeShare.onEvent(onHelperEvent);
  state.nativeScreen = true;
  state.nativeSize = { width: result.width, height: result.height };
  state.nativeStats = null;
  console.log(`[native] up: ${result.width}x${result.height} encoder=${result.encoder} fps=${fps}`);
  if (!state.videoBitrateKbps) window.nativeShare.setBitrate(autoBitrateKbps('screen'));
  return new MediaStream([placeholderVideoTrack(), ...audioTracks]);
}

export function stopNativeVideo() {
  if (!state.nativeScreen) return;
  state.nativeScreen = false;
  state.nativeSize = null;
  state.nativeStats = null;
  lostHandler = null;
  window.nativeShare?.stop();
}
