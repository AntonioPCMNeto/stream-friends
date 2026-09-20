import { state } from './state.js';
import { getUserVoiceSettings, setUserVoiceSettings } from './voice.js';

// Right-click a member (persistent list or the narrow-viewport dropdown) for a
// local volume slider and mute for their voice. It only changes how loud they
// are for you — see setUserVoiceSettings in voice.js.

const MENU_MARGIN = 8;

let menu = null;
let titleEl = null;
let slider = null;
let valueEl = null;
let muteBox = null;
let currentPeerId = null;

function buildMenu() {
  menu = document.createElement('div');
  menu.className = 'voice-menu hidden';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Volume do usuário');

  titleEl = document.createElement('div');
  titleEl.className = 'voice-menu-title';
  menu.appendChild(titleEl);

  const label = document.createElement('div');
  label.className = 'field-label';
  label.textContent = 'Volume do usuário';
  menu.appendChild(label);

  const volumeRow = document.createElement('div');
  volumeRow.className = 'voice-menu-volume';
  slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '5';
  slider.setAttribute('aria-label', 'Volume do usuário');
  valueEl = document.createElement('span');
  valueEl.className = 'voice-menu-value';
  volumeRow.append(slider, valueEl);
  menu.appendChild(volumeRow);

  const muteLabel = document.createElement('label');
  muteLabel.className = 'voice-menu-mute';
  muteBox = document.createElement('input');
  muteBox.type = 'checkbox';
  muteLabel.append(muteBox, document.createTextNode('Mutar'));
  menu.appendChild(muteLabel);

  slider.addEventListener('input', () => {
    valueEl.textContent = `${slider.value}%`;
    // Moving the slider while muted means "I want to hear them" — unmute.
    const patch = { volume: Number(slider.value) / 100 };
    if (muteBox.checked) {
      muteBox.checked = false;
      patch.muted = false;
    }
    setUserVoiceSettings(currentPeerId, patch);
  });
  muteBox.addEventListener('change', () => {
    setUserVoiceSettings(currentPeerId, { muted: muteBox.checked });
  });

  document.body.appendChild(menu);
}

function isOpen() {
  return menu !== null && !menu.classList.contains('hidden');
}

function closeMenu() {
  if (menu) menu.classList.add('hidden');
  currentPeerId = null;
}

function openMenu(peerId, x, y) {
  if (!menu) buildMenu();
  currentPeerId = peerId;

  const { volume, muted } = getUserVoiceSettings(peerId);
  titleEl.textContent = state.peerUsernames.get(peerId) || 'Alguém';
  slider.value = String(Math.round(volume * 100));
  valueEl.textContent = `${slider.value}%`;
  muteBox.checked = muted;

  menu.classList.remove('hidden');
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(MENU_MARGIN, Math.min(x, window.innerWidth - width - MENU_MARGIN))}px`;
  menu.style.top = `${Math.max(MENU_MARGIN, Math.min(y, window.innerHeight - height - MENU_MARGIN))}px`;
  slider.focus();
}

export function initVoiceMenu() {
  ['memberListItems', 'participantsList'].forEach((id) => {
    document.getElementById(id).addEventListener('contextmenu', (e) => {
      const peerId = e.target.closest('.participant-row')?.dataset.peerId;
      if (!peerId || peerId === 'local') return;
      e.preventDefault();
      openMenu(peerId, e.clientX, e.clientY);
    });
  });

  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
}
