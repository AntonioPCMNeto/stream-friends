import { state } from './state.js';
import { renderTiles } from './tiles.js';
import { callPeer, updateEncodingParams, announceSharingStatus, removeOutgoingTracks, replaceOutgoingStream } from './peers.js';
import { showToast } from './toast.js';
import { refreshParticipants } from './participants.js';

const startBtn = document.getElementById('startShareBtn');
const switchBtn = document.getElementById('switchSourceBtn');
const shareControl = document.querySelector('.share-control');
const sharePanel = document.getElementById('sharePanel');
const confirmShareBtn = document.getElementById('confirmShareBtn');
const resolutionGroup = document.getElementById('resolutionGroup');
const framerateGroup = document.getElementById('framerateGroup');
const bitrateGroup = document.getElementById('bitrateGroup');

// Wires a row of segmented buttons: clicking one marks it active and
// updates the group's data-value, which the Start button reads later.
function initSegmented(group) {
  group.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('button').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      group.dataset.value = btn.dataset.value;
    });
  });
}

function setSharingUI(sharing) {
  startBtn.textContent = sharing ? '⏹ Parar Compartilhamento' : '🖥️ Iniciar Compartilhamento';
  startBtn.classList.toggle('btn-danger', sharing);
  startBtn.classList.toggle('btn-primary', !sharing);
  switchBtn.classList.toggle('hidden', !sharing);
}

function openPanel() { sharePanel.classList.remove('hidden'); }
function closePanel() { sharePanel.classList.add('hidden'); }

// Stops our outgoing tracks. Stopping the local tracks alone doesn't tell
// any peer connection anything — announceSharingStatus(false) is what
// actually makes everyone's tile disappear immediately (peers.js acts on
// it directly), while removeOutgoingTracks() cleans up the WebRTC side
// (removes our senders and renegotiates) so restarting a share later
// doesn't pile a new track on top of a stale one.
// Safe to call even when not currently sharing (e.g. on room exit).
export function stopSharing() {
  const wasSharing = !!state.localStream;
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
  }
  state.isSharing = false;
  state.localStream = null;
  renderTiles();
  setSharingUI(false);
  if (wasSharing) {
    removeOutgoingTracks();
    showToast('Compartilhamento de tela interrompido.');
    announceSharingStatus(false);
    refreshParticipants();
  }
}

// Runs getDisplayMedia with the panel's current resolution/framerate.
// Returns the MediaStream ready to send (contentHint set, native-stop
// wired), or null if the user cancelled the picker. Throws on a real
// capture failure.
async function captureDisplay() {
  const framerate = Number(framerateGroup.dataset.value);
  // `ideal` only. A hard `max` makes the OS screen-capturer do its own
  // frame-rate limiting, which delivers frames unevenly; the encoder's
  // maxFramerate (peers.js) is a smoother ceiling. `min`/`exact` throw and
  // abort the capture, and a floor is meaningless anyway — screen capture
  // is content-driven, so a static screen legitimately produces fewer
  // frames than requested and no constraint can conjure the missing ones.
  const videoConstraints = { frameRate: { ideal: framerate } };

  if (resolutionGroup.dataset.value === 'auto') {
    // "Origem": capture at the streamer's real display resolution.
    // Unconstrained, Chrome usually hands back a downscaled buffer (often
    // 1920×1080). Requesting the physical pixel size as `ideal` gets the
    // native panel resolution for a full-screen share without forcing an
    // upscale of a smaller source (a single window or tab).
    videoConstraints.width = { ideal: Math.round(screen.width * devicePixelRatio) };
    videoConstraints.height = { ideal: Math.round(screen.height * devicePixelRatio) };
  } else {
    const [width, height] = resolutionGroup.dataset.value.split('x').map(Number);
    videoConstraints.width = { ideal: width };
    videoConstraints.height = { ideal: height };
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: videoConstraints,
    audio: {
      // Sharing a tab or a single app window always captures just that
      // source's audio; systemAudio only affects the "Entire Screen" case
      // — 'include' (the default) lets it fall back to whole-system audio there.
      systemAudio: 'include',
      // echoCancellation/noiseSuppression/autoGainControl default to browser
      // mic-processing behavior, which can audibly mangle captured system/tab
      // audio (music, game sound). This is display audio, not a microphone.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });

  // Tells the encoder to favor smooth frame delivery over per-frame
  // sharpness — the default ('detail') optimizes for static content and
  // will drop frames under bandwidth pressure instead of losing quality.
  stream.getVideoTracks()[0].contentHint = 'motion';
  // User stopping capture from the browser's native share bar.
  stream.getVideoTracks()[0].onended = () => stopSharing();
  state.videoFramerateFps = framerate;
  return stream;
}

function reportCaptureError(err) {
  console.error('Failed to capture screen:', err);
  // getDisplayMedia doesn't distinguish "user clicked Cancel" from "user
  // denied permission" — both surface as NotAllowedError.
  if (err.name === 'NotAllowedError') {
    showToast('Permissão negada ou compartilhamento cancelado.', 'error');
  } else if (err.name === 'NotSupportedError' || err.name === 'NotFoundError') {
    showToast('Compartilhamento de tela não é suportado neste navegador/dispositivo.', 'error');
  } else {
    showToast('Erro ao capturar a tela.', 'error');
  }
}

// HOST SIDE: capture screen and call everyone in the room
async function startSharing() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showToast('Compartilhamento de tela não é suportado neste navegador/dispositivo.', 'error');
    return;
  }

  try {
    const stream = await captureDisplay();
    if (!stream) return; // picker cancelled

    state.localStream = stream;
    state.isSharing = true;
    renderTiles();
    showToast('Você começou a compartilhar sua tela.');
    setSharingUI(true);
    announceSharingStatus(true);
    refreshParticipants();

    state.knownPeers.forEach(callPeer);
  } catch (err) {
    reportCaptureError(err);
  }
}

// HOST SIDE: pick a different screen/window and swap it in live — viewers
// keep watching, the picture just changes (see replaceOutgoingStream).
async function switchSource() {
  if (!state.isSharing) return;
  const previous = state.localStream;
  try {
    const stream = await captureDisplay();
    if (!stream) return; // picker cancelled — current share untouched

    await replaceOutgoingStream(stream);
    state.localStream = stream;
    renderTiles(); // repoints the local preview

    previous.getVideoTracks().forEach((t) => { t.onended = null; });
    previous.getTracks().forEach((t) => t.stop());
    showToast('Fonte de compartilhamento trocada.');
  } catch (err) {
    // captureDisplay threw — the previous stream is still live and still
    // wired to every viewer, so there's nothing to roll back.
    reportCaptureError(err);
  }
}

export function initSharing() {
  initSegmented(resolutionGroup);
  initSegmented(framerateGroup);
  initSegmented(bitrateGroup);

  // Bitrate/framerate can change on the fly: push them to active senders
  // immediately instead of waiting for the next share to pick them up.
  // (Framerate here only caps the outgoing encode — it can't raise the
  // capture rate above what getDisplayMedia was started with.)
  bitrateGroup.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    state.videoBitrateKbps = Number(bitrateGroup.dataset.value) || null;
    if (state.isSharing) updateEncodingParams();
  });

  framerateGroup.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    state.videoFramerateFps = Number(framerateGroup.dataset.value) || null;
    if (state.isSharing) updateEncodingParams();
  });

  startBtn.addEventListener('click', () => {
    if (state.isSharing) {
      stopSharing();
    } else if (sharePanel.classList.contains('hidden')) {
      openPanel();
    } else {
      closePanel();
    }
  });

  switchBtn.addEventListener('click', switchSource);

  confirmShareBtn.addEventListener('click', () => {
    closePanel();
    startSharing();
  });

  // Close the panel on an outside click or Escape, without swallowing the
  // click that opened it (startBtn's own listener runs first via bubbling).
  document.addEventListener('click', (e) => {
    if (!sharePanel.classList.contains('hidden') && !shareControl.contains(e.target)) {
      closePanel();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });
}
