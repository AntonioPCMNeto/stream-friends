import { state } from './state.js';
import { buildAvatar } from './identity.js';

const control = document.querySelector('.participants-control');
const toggleBtn = document.getElementById('participantsBtn');
const countEl = document.getElementById('participantsCount');
const panel = document.getElementById('participantsPanel');
const listEl = document.getElementById('participantsList');
const voiceSidebar = document.getElementById('voiceSidebar');
const voiceSidebarList = document.getElementById('voiceSidebarList');

function openPanel() { panel.classList.remove('hidden'); }
function closePanel() { panel.classList.add('hidden'); }

const PURPOSE_BADGE = { screen: '🔴 Tela', webcam: '📷 Webcam' };

function buildRow(name, purposes, isMe, inVoice, peerId, verified) {
  const row = document.createElement('div');
  row.className = 'participant-row';
  row.dataset.peerId = peerId;

  row.appendChild(buildAvatar(name));

  const nameEl = document.createElement('span');
  nameEl.className = 'participant-name';
  nameEl.textContent = isMe ? `${name} (Você)` : name;
  row.appendChild(nameEl);

  if (verified) {
    const badge = document.createElement('span');
    badge.className = 'verified-badge';
    badge.textContent = '✓';
    badge.title = 'Conta verificada (Discord)';
    row.appendChild(badge);
  }

  if (inVoice) {
    const badge = document.createElement('span');
    badge.className = 'voice-badge';
    badge.textContent = '🎧';
    badge.title = 'No áudio';
    row.appendChild(badge);
  }

  purposes.forEach((purpose) => {
    const badge = document.createElement('span');
    badge.className = 'sharing-badge';
    badge.textContent = PURPOSE_BADGE[purpose] || purpose;
    row.appendChild(badge);
  });

  return row;
}

// Re-renders the participant list and count from current state. Called
// whenever room membership or anyone's sharing status changes.
export function refreshParticipants() {
  listEl.innerHTML = '';
  voiceSidebarList.innerHTML = '';

  const myPurposes = [
    ...(state.isSharingScreen ? ['screen'] : []),
    ...(state.isSharingWebcam ? ['webcam'] : []),
  ];

  if (state.myUsername) {
    listEl.appendChild(buildRow(state.myUsername, myPurposes, true, state.isInVoice, 'local', state.myVerified));
  }
  if (state.isInVoice) {
    voiceSidebarList.appendChild(buildRow(state.myUsername, myPurposes, true, false, 'local', state.myVerified));
  }

  state.knownPeers.forEach((id) => {
    const name = state.peerUsernames.get(id) || 'Alguém';
    const purposes = Array.from(state.sharingPeers.get(id) || new Set());
    const inVoice = state.voicePeers.has(id);
    const verified = state.peerVerified.get(id);
    listEl.appendChild(buildRow(name, purposes, false, inVoice, id, verified));
    if (inVoice) voiceSidebarList.appendChild(buildRow(name, purposes, false, false, id, verified));
  });

  countEl.textContent = state.knownPeers.size + (state.myUsername ? 1 : 0);
  voiceSidebar.classList.toggle('hidden', !state.isInVoice);
}

// Toggles the speaking ring on a peer's avatar wherever it's currently
// rendered (participants panel and/or voice sidebar). Called on every
// analyser volume sample from voice.js — targeted class toggle, not a
// re-render, so it doesn't fight the DOM churn every 150ms.
export function setSpeaking(peerId, isSpeaking) {
  document.querySelectorAll(`.participant-row[data-peer-id="${peerId}"] .avatar`).forEach((el) => {
    el.classList.toggle('speaking', isSpeaking);
  });
}

export function initParticipants() {
  toggleBtn.addEventListener('click', () => {
    if (panel.classList.contains('hidden')) openPanel(); else closePanel();
  });

  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') && !control.contains(e.target)) {
      closePanel();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });

  refreshParticipants();
}
