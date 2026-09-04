import { state } from './state.js';

const control = document.querySelector('.participants-control');
const toggleBtn = document.getElementById('participantsBtn');
const countEl = document.getElementById('participantsCount');
const panel = document.getElementById('participantsPanel');
const listEl = document.getElementById('participantsList');

function openPanel() { panel.classList.remove('hidden'); }
function closePanel() { panel.classList.add('hidden'); }

const PURPOSE_BADGE = { screen: '🔴 Tela', webcam: '📷 Webcam' };

function buildRow(name, purposes, isMe) {
  const row = document.createElement('div');
  row.className = 'participant-row';

  const nameEl = document.createElement('span');
  nameEl.className = 'participant-name';
  nameEl.textContent = isMe ? `${name} (Você)` : name;
  row.appendChild(nameEl);

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

  if (state.myUsername) {
    const myPurposes = [
      ...(state.isSharingScreen ? ['screen'] : []),
      ...(state.isSharingWebcam ? ['webcam'] : []),
    ];
    listEl.appendChild(buildRow(state.myUsername, myPurposes, true));
  }

  state.knownPeers.forEach((id) => {
    const name = state.peerUsernames.get(id) || 'Alguém';
    const purposes = state.sharingPeers.get(id) || new Set();
    listEl.appendChild(buildRow(name, Array.from(purposes), false));
  });

  countEl.textContent = state.knownPeers.size + (state.myUsername ? 1 : 0);
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
