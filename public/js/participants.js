import { state } from './state.js';
import { buildAvatar } from './identity.js';

const control = document.querySelector('.participants-control');
const toggleBtn = document.getElementById('participantsBtn');
const countEl = document.getElementById('participantsCount');
const panel = document.getElementById('participantsPanel');
const listEl = document.getElementById('participantsList');
const memberListItems = document.getElementById('memberListItems');
const userBarAvatar = document.getElementById('userBarAvatar');
const userBarName = document.getElementById('userBarName');

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
    badge.title = 'Conta verificada';
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
// whenever room membership or anyone's sharing status changes. Two DOM
// targets get the same rows: the dropdown (#participantsPanel, kept for
// narrow viewports) and the persistent Discord-style #memberList column
// (see index.html/style.css) — separate nodes since a row can't be in two
// places in the DOM at once.
export function refreshParticipants() {
  listEl.innerHTML = '';
  memberListItems.innerHTML = '';

  const myPurposes = [
    ...(state.isSharingScreen ? ['screen'] : []),
    ...(state.isSharingWebcam ? ['webcam'] : []),
  ];

  if (state.myUsername) {
    listEl.appendChild(buildRow(state.myUsername, myPurposes, true, state.isInVoice, 'local', state.myVerified));
    memberListItems.appendChild(buildRow(state.myUsername, myPurposes, true, state.isInVoice, 'local', state.myVerified));
  }

  state.knownPeers.forEach((id) => {
    const name = state.peerUsernames.get(id) || 'Alguém';
    const purposes = Array.from(state.sharingPeers.get(id) || new Set());
    const inVoice = state.voicePeers.has(id);
    const verified = state.peerVerified.get(id);
    listEl.appendChild(buildRow(name, purposes, false, inVoice, id, verified));
    memberListItems.appendChild(buildRow(name, purposes, false, inVoice, id, verified));
  });

  countEl.textContent = state.knownPeers.size + (state.myUsername ? 1 : 0);

  userBarName.textContent = state.myUsername || '';
  userBarAvatar.innerHTML = '';
  if (state.myUsername) userBarAvatar.appendChild(buildAvatar(state.myUsername));
}

// Toggles the speaking ring on a peer's avatar wherever it's currently
// rendered (the dropdown and/or the persistent member list). Called on
// every analyser volume sample from voice.js — targeted class toggle, not a
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
