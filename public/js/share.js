import { state } from './state.js';
import { addOrUpdateTile, removeTile } from './tiles.js';
import { room } from './livekit.js';
import { Track, RoomEvent } from '../vendor/livekit-client.esm.js';
import { showToast } from './toast.js';
import { refreshParticipants } from './participants.js';

const startBtn = document.getElementById('startShareBtn');
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
}

function openPanel() { sharePanel.classList.remove('hidden'); }
function closePanel() { sharePanel.classList.add('hidden'); }

function findScreenSharePublication() {
  return [...room.localParticipant.trackPublications.values()].find(
    (pub) => pub.source === Track.Source.ScreenShare
  );
}

// Re-applies the current bitrate/framerate to the single outgoing sender —
// used when the user changes a share-panel control while already sharing.
// Unlike the old mesh version, there's only ever one sender to update here:
// LiveKit's SFU fans this one encode out to every viewer server-side,
// instead of this app encoding a separate copy per viewer.
function updateLiveEncodingParams() {
  const sender = findScreenSharePublication()?.track?.sender;
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
  params.encodings[0].maxBitrate = state.videoBitrateKbps ? state.videoBitrateKbps * 1000 : undefined;
  params.encodings[0].maxFramerate = state.videoFramerateFps || undefined;
  sender.setParameters(params).catch((err) => console.error('Failed to update encoding params:', err));
}

// Central cleanup for when our screen-share track goes away — whether we
// clicked "stop" (stopSharing below unpublishes it) or the browser's
// native share-bar Stop button ended the MediaStreamTrack directly.
// LiveKit notices either way and unpublishes, firing this same event, so
// there's exactly one cleanup path instead of two.
room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
  if (publication.source !== Track.Source.ScreenShare) return;
  if (!state.isSharing) return;
  state.isSharing = false;
  removeTile('local');
  setSharingUI(false);
  showToast('Compartilhamento de tela interrompido.');
  refreshParticipants();
});

// Unpublishing (rather than the old track.stop() + manual renegotiation)
// is what actually signals "this track is gone" to every viewer — LiveKit
// tells the SFU, which tells every subscriber, instead of the remote side
// just going quiet with a frozen last frame.
export function stopSharing() {
  if (!state.isSharing) return;
  room.localParticipant.trackPublications.forEach((publication) => {
    if (publication.source === Track.Source.ScreenShare || publication.source === Track.Source.ScreenShareAudio) {
      room.localParticipant.unpublishTrack(publication.track, true);
    }
  });
}

// HOST SIDE: capture the screen and publish it once — LiveKit's SFU
// forwards it to every viewer, so this is the only encode that ever runs
// on this machine regardless of how many people are watching.
async function startSharing() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showToast('Compartilhamento de tela não é suportado neste navegador/dispositivo.', 'error');
    return;
  }

  try {
    const framerate = Number(framerateGroup.dataset.value);
    // Screen capture is content-driven, not clock-driven — a static desktop
    // legitimately produces far fewer than `framerate` new frames, and no
    // constraint can force frames that were never captured. `min` is mostly
    // advisory here (Chrome doesn't strictly enforce it for display capture
    // the way it does for cameras), but it's honest about intent and costs
    // nothing to set.
    const videoConstraints = { frameRate: { min: framerate, ideal: framerate, max: framerate } };

    if (resolutionGroup.dataset.value !== 'auto') {
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

    const videoTrack = stream.getVideoTracks()[0];
    // Tells the encoder to favor smooth frame delivery over per-frame
    // sharpness — the default ('detail') optimizes for static content and
    // will drop frames under bandwidth pressure instead of losing quality.
    videoTrack.contentHint = 'motion';

    state.videoFramerateFps = framerate;

    const publication = await room.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.ScreenShare,
      videoCodec: 'h264',
      screenShareEncoding: {
        maxBitrate: state.videoBitrateKbps ? state.videoBitrateKbps * 1000 : undefined,
        maxFramerate: framerate,
      },
    });
    // Protects framerate over resolution/sharpness when bandwidth gets
    // tight — screen-share content (games, video, scrolling) is usually
    // motion-heavy, so a steady framerate reads as smoother than a sharper
    // but stuttery picture.
    await publication.track.setDegradationPreference('maintain-framerate');

    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      await room.localParticipant.publishTrack(audioTrack, { source: Track.Source.ScreenShareAudio });
    }

    state.isSharing = true;
    addOrUpdateTile('local', stream, `Você (${state.myUsername})`, true /* isLocal */);
    showToast('Você começou a compartilhar sua tela.');
    setSharingUI(true);
    refreshParticipants();
  } catch (err) {
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
}

export function initSharing() {
  initSegmented(resolutionGroup);
  initSegmented(framerateGroup);
  initSegmented(bitrateGroup);

  // Bitrate/framerate can change on the fly: push them to the active
  // sender immediately instead of waiting for the next share to pick them up.
  bitrateGroup.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    state.videoBitrateKbps = Number(bitrateGroup.dataset.value) || null;
    if (state.isSharing) updateLiveEncodingParams();
  });

  framerateGroup.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    state.videoFramerateFps = Number(framerateGroup.dataset.value) || null;
    if (state.isSharing) updateLiveEncodingParams();
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
