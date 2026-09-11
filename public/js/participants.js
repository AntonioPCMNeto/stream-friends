import { state } from './state.js';

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

function buildRow(name, purposes, isMe, inVoice) {
  const row = document.createElement('div');
  row.className = 'participant-row';

  const nameEl = document.createElement('span');
  nameEl.className = 'participant-name';
  nameEl.textContent = isMe ? `${name} (Você)` : name;
  row.appendChild(nameEl);

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
    listEl.appendChild(buildRow(state.myUsername, myPurposes, true, state.isInVoice));
  }
  if (state.isInVoice) {
    voiceSidebarList.appendChild(buildRow(state.myUsername, myPurposes, true, false));
  }

  state.knownPeers.forEach((id) => {
    const name = state.peerUsernames.get(id) || 'Alguém';
    const purposes = Array.from(state.sharingPeers.get(id) || new Set());
    const inVoice = state.voicePeers.has(id);
    listEl.appendChild(buildRow(name, purposes, false, inVoice));
    if (inVoice) voiceSidebarList.appendChild(buildRow(name, purposes, false, false));
  });

  countEl.textContent = state.knownPeers.size + (state.myUsername ? 1 : 0);
  voiceSidebar.classList.toggle('hidden', !state.isInVoice);
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
