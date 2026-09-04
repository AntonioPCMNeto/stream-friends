import { state } from './state.js';
import { renderTiles } from './tiles.js';
import { callPeer, updateEncodingParams, announceSharingStatus, removeOutgoingTracks, replaceOutgoingStream } from './peers.js';
import { showToast } from './toast.js';
import { refreshParticipants } from './participants.js';
import { pickSource } from './screenPicker.js';

const startBtn = document.getElementById('startShareBtn');
const switchBtn = document.getElementById('switchSourceBtn');
const shareControl = document.querySelector('.share-control');
const sharePanel = document.getElementById('sharePanel');
const confirmShareBtn = document.getElementById('confirmShareBtn');
const resolutionGroup = document.getElementById('resolutionGroup');
const framerateGroup = document.getElementById('framerateGroup');
const bitrateGroup = document.getElementById('bitrateGroup');
const webcamBtn = document.getElementById('startWebcamBtn');

// Webcam has no quality panel — a facecam doesn't need screen-share-grade
// resolution controls, so it always captures at this fixed target.
// peers.js applies the matching fixed bitrate/framerate to the sender.
const WEBCAM_CONSTRAINTS = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  audio: true,
};

// Guards startSharing/switchSource/startWebcam against a rapid double-click
// firing a second concurrent getDisplayMedia/getUserMedia call before the
// first has resolved — the native permission prompt doesn't block a second
// JS call, so without this a double-click could orphan a MediaStream that
// never gets stopped. Screen actions share one flag since starting and
// switching can't overlap either.
let screenCaptureInFlight = false;
let webcamCaptureInFlight = false;

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

function setScreenShareUI(sharing) {
  startBtn.textContent = sharing ? '⏹ Parar Compartilhamento' : '🖥️ Iniciar Compartilhamento';
  startBtn.classList.toggle('btn-danger', sharing);
  startBtn.classList.toggle('btn-primary', !sharing);
  switchBtn.classList.toggle('hidden', !sharing);
}

function setWebcamUI(sharing) {
  webcamBtn.textContent = sharing ? '⏹ Parar Webcam' : '📷 Compartilhar Webcam';
  webcamBtn.classList.toggle('btn-danger', sharing);
  webcamBtn.classList.toggle('btn-ghost', !sharing);
}

function openPanel() { sharePanel.classList.remove('hidden'); }
function closePanel() { sharePanel.classList.add('hidden'); }

// Stops our outgoing screen share. Stopping the local tracks alone doesn't
// tell any peer connection anything — announceSharingStatus(false) is what
// actually makes everyone's tile disappear immediately (peers.js acts on it
// directly), while removeOutgoingTracks() cleans up the WebRTC side
// (removes our senders and renegotiates) so restarting a share later
// doesn't pile a new track on top of a stale one.
// Safe to call even when not currently sharing (e.g. on room exit).
export function stopSharing() {
  const wasSharing = !!state.screenStream;
  if (state.screenStream) {
    state.screenStream.getTracks().forEach((track) => track.stop());
  }
  state.isSharingScreen = false;
  state.screenStream = null;
  renderTiles();
  setScreenShareUI(false);
  if (wasSharing) {
    removeOutgoingTracks('screen');
    showToast('Compartilhamento de tela interrompido.');
    announceSharingStatus('screen', false);
    refreshParticipants();
  }
}

// Same as stopSharing() but for the webcam stream. Safe to call even when
// not currently sharing (e.g. on room exit).
export function stopWebcam() {
  const wasSharing = !!state.webcamStream;
  if (state.webcamStream) {
    state.webcamStream.getTracks().forEach((track) => track.stop());
  }
  state.isSharingWebcam = false;
  state.webcamStream = null;
  renderTiles();
  setWebcamUI(false);
  if (wasSharing) {
    removeOutgoingTracks('webcam');
    showToast('Webcam desligada.');
    announceSharingStatus('webcam', false);
    refreshParticipants();
  }
}

// Runs the source picker + getDisplayMedia with the panel's current
// resolution/framerate. Returns the MediaStream ready to send (contentHint
// set, native-stop wired), or null if the user cancelled the picker. Throws
// on a real capture failure.
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
    // Unconstrained, Chrome/Electron usually hand back a downscaled buffer
    // (often 1920×1080). Requesting the physical pixel size as `ideal` gets
    // the native panel resolution for a full-screen share without forcing
    // an upscale of a smaller source (a single window or tab).
    videoConstraints.width = { ideal: Math.round(screen.width * devicePixelRatio) };
    videoConstraints.height = { ideal: Math.round(screen.height * devicePixelRatio) };
  } else {
    const [width, height] = resolutionGroup.dataset.value.split('x').map(Number);
    videoConstraints.width = { ideal: width };
    videoConstraints.height = { ideal: height };
  }

  // echoCancellation/noiseSuppression/autoGainControl default to browser
  // mic-processing behavior, which can audibly mangle captured system/tab
  // audio (music, game sound). This is display audio, not a microphone.
  const audioProcessing = {
    systemAudio: 'include',
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  let audioConstraint;
  if (window.screenPicker) {
    // Electron: run our themed picker first, then request audio only for a
    // full-screen share. Electron can't capture a single window's audio, and
    // asking for any audio on a window share aborts the whole getDisplayMedia
    // call with "Invalid capture constraints".
    const pick = await pickSource();
    if (!pick) return null; // user cancelled — no toast, matches native behavior
    await window.screenPicker.choose({ sourceId: pick.sourceId, withAudio: pick.withAudio });
    audioConstraint = pick.withAudio ? audioProcessing : false;
  } else {
    audioConstraint = audioProcessing;
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: videoConstraints,
    audio: audioConstraint,
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

function reportCaptureError(err, isWebcam = false) {
  console.error(`Failed to capture ${isWebcam ? 'webcam' : 'screen'}:`, err);
  // getDisplayMedia/getUserMedia don't distinguish "user clicked Cancel"
  // from "user denied permission" — both surface as NotAllowedError.
  if (err.name === 'NotAllowedError') {
    showToast('Permissão negada ou compartilhamento cancelado.', 'error');
  } else if (err.name === 'NotSupportedError' || err.name === 'NotFoundError') {
    showToast(
      isWebcam ? 'Nenhuma webcam encontrada ou não suportada.' : 'Compartilhamento de tela não é suportado neste navegador/dispositivo.',
      'error'
    );
  } else {
    showToast(`Erro ao capturar ${isWebcam ? 'a webcam' : 'a tela'}: ${err.name} — ${err.message}`, 'error');
  }
}

// HOST SIDE: capture screen and call everyone in the room
async function startSharing() {
  if (screenCaptureInFlight) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showToast('Compartilhamento de tela não é suportado neste navegador/dispositivo.', 'error');
    return;
  }

  screenCaptureInFlight = true;
  try {
    const stream = await captureDisplay();
    if (!stream) return; // picker cancelled

    state.screenStream = stream;
    state.isSharingScreen = true;
    renderTiles();
    showToast('Você começou a compartilhar sua tela.');
    setScreenShareUI(true);
    announceSharingStatus('screen', true);
    refreshParticipants();

    state.knownPeers.forEach((id) => callPeer(id, 'screen'));
  } catch (err) {
    reportCaptureError(err);
  } finally {
    screenCaptureInFlight = false;
  }
}

// HOST SIDE: turn the webcam on and call everyone in the room. Independent
// of screen sharing — either, both, or neither can be active.
async function startWebcam() {
  if (webcamCaptureInFlight) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('Câmera não é suportada neste navegador/dispositivo.', 'error');
    return;
  }

  webcamCaptureInFlight = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia(WEBCAM_CONSTRAINTS);
    // Device unplugged / permission revoked mid-call.
    stream.getVideoTracks()[0].onended = () => stopWebcam();

    state.webcamStream = stream;
    state.isSharingWebcam = true;
    renderTiles();
    showToast('Webcam ligada.');
    setWebcamUI(true);
    announceSharingStatus('webcam', true);
    refreshParticipants();

    state.knownPeers.forEach((id) => callPeer(id, 'webcam'));
  } catch (err) {
    reportCaptureError(err, true);
  } finally {
    webcamCaptureInFlight = false;
  }
}

// HOST SIDE: pick a different screen/window and swap it in live — viewers
// keep watching, the picture just changes (see replaceOutgoingStream).
async function switchSource() {
  if (!state.isSharingScreen || screenCaptureInFlight) return;
  screenCaptureInFlight = true;
  const previous = state.screenStream;
  try {
    const stream = await captureDisplay();
    if (!stream) return; // picker cancelled — current share untouched

    await replaceOutgoingStream('screen', stream);
    state.screenStream = stream;
    renderTiles(); // repoints the local preview

    previous.getVideoTracks().forEach((t) => { t.onended = null; });
    previous.getTracks().forEach((t) => t.stop());
    showToast('Fonte de compartilhamento trocada.');
  } catch (err) {
    // captureDisplay threw — the previous stream is still live and still
    // wired to every viewer, so there's nothing to roll back.
    reportCaptureError(err);
  } finally {
    screenCaptureInFlight = false;
  }
}

export function initSharing() {
  initSegmented(resolutionGroup);
  initSegmented(framerateGroup);
  initSegmented(bitrateGroup);

  // Bitrate/framerate can change on the fly: push them to active senders
  // immediately instead of waiting for the next share to pick them up.
  // (Framerate here only caps the outgoing encode — it can't raise the
  // capture rate above what getDisplayMedia was started with.) Screen only
  // — webcam has no quality panel.
  bitrateGroup.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    state.videoBitrateKbps = Number(bitrateGroup.dataset.value) || null;
    if (state.isSharingScreen) updateEncodingParams('screen');
  });

  framerateGroup.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    state.videoFramerateFps = Number(framerateGroup.dataset.value) || null;
    if (state.isSharingScreen) updateEncodingParams('screen');
  });

  startBtn.addEventListener('click', () => {
    if (state.isSharingScreen) {
      stopSharing();
    } else if (sharePanel.classList.contains('hidden')) {
      openPanel();
    } else {
      closePanel();
    }
  });

  switchBtn.addEventListener('click', switchSource);

  webcamBtn.addEventListener('click', () => {
    if (state.isSharingWebcam) stopWebcam(); else startWebcam();
  });

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
