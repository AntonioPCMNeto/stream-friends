import { state } from './state.js';
import { addOrUpdateTile, removeTile } from './tiles.js';
import { callPeer, updateBitrate } from './peers.js';

const startBtn = document.getElementById('startShareBtn');
const shareControl = document.querySelector('.share-control');
const sharePanel = document.getElementById('sharePanel');
const confirmShareBtn = document.getElementById('confirmShareBtn');
const resolutionGroup = document.getElementById('resolutionGroup');
const framerateGroup = document.getElementById('framerateGroup');
const bitrateGroup = document.getElementById('bitrateGroup');
const statusText = document.getElementById('status');

// Wires a row of segmented buttons: clicking one marks it active and
// updates the group's data-value, which the Start button reads later.
function initSegmented(group) {
  group.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
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

// Stops our outgoing tracks. This also ends the corresponding remote track
// on every peer's connection, so their tile disappears without extra signaling.
// Safe to call even when not currently sharing (e.g. on room exit).
export function stopSharing() {
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
  }
  state.isSharing = false;
  state.localStream = null;
  removeTile('local');
  statusText.innerText = 'Compartilhamento de tela interrompido.';
  setSharingUI(false);
}

// HOST SIDE: capture screen and call everyone in the room
async function startSharing() {
  try {
    const framerate = Number(framerateGroup.dataset.value);
    const videoConstraints = { frameRate: { ideal: framerate, max: framerate } };

    if (resolutionGroup.dataset.value !== 'auto') {
      const [width, height] = resolutionGroup.dataset.value.split('x').map(Number);
      videoConstraints.width = { ideal: width };
      videoConstraints.height = { ideal: height };
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      // Sharing a tab or a single app window always captures just that
      // source's audio; systemAudio only affects the "Entire Screen" case
      // — 'include' (the default) lets it fall back to whole-system audio there.
      audio: { systemAudio: 'include' }
    });

    // Tells the encoder to favor smooth frame delivery over per-frame
    // sharpness — the default ('detail') optimizes for static content and
    // will drop frames under bandwidth pressure instead of losing quality.
    stream.getVideoTracks()[0].contentHint = 'motion';

    state.localStream = stream;
    state.isSharing = true;
    addOrUpdateTile('local', stream, `Você (${state.myUsername})`, true /* isLocal */);
    statusText.innerText = 'Compartilhando sua tela...';
    setSharingUI(true);

    // Call everyone already known in the room
    state.knownPeers.forEach(callPeer);

    // Handle user stopping the stream via the browser's native share bar
    stream.getVideoTracks()[0].onended = () => stopSharing();
  } catch (err) {
    console.error('Failed to capture screen:', err);
    statusText.innerText = 'Erro ao capturar a tela.';
  }
}

export function initSharing() {
  initSegmented(resolutionGroup);
  initSegmented(framerateGroup);
  initSegmented(bitrateGroup);

  // Bitrate can change on the fly: push it to active senders immediately
  // instead of waiting for the next share to pick it up.
  bitrateGroup.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    state.videoBitrateKbps = Number(bitrateGroup.dataset.value) || null;
    if (state.isSharing) updateBitrate();
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
