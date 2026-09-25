import { state } from './state.js';
import { toggleMute, toggleDeafen, setPttHeld } from './voice.js';
import {
  getSetting, onSettingChange, eventToAccelerator, keyFromCode, parseAccelerator, toElectronAccelerator,
} from './settings.js';

// Mute, deafen and push-to-talk shortcuts (bound in the settings page).
//
// - Web: mute/deafen work while the page has focus — a browser can't listen for
//   keys once you're in another window.
// - Desktop app: mute/deafen are registered with the OS (see main.js), so they
//   also work while a game has focus. If the OS refuses one (another program
//   already owns it) that shortcut falls back to the in-page listener below.
// - Push-to-talk is hold-to-talk, which needs key-up events, so it only works
//   while the app window has focus on both.

let paused = false; // while the settings page is recording a new shortcut
let globalActive = { mute: false, deafen: false };

// Lets the settings page show whether a shortcut is system-wide right now.
export function getGlobalHotkeyStatus() {
  return { available: Boolean(window.hotkeys), ...globalActive };
}

export function pauseHotkeys(value) {
  paused = value;
  if (value) setPttHeld(false);
}

function isTypingTarget(target) {
  return target instanceof Element && (target.closest('input, textarea, select') !== null || target.isContentEditable);
}

// A bare key (no Ctrl/Alt/Meta) typed into a text field is text, not a shortcut.
function isPlainTyping(e) {
  return isTypingTarget(e.target) && !e.ctrlKey && !e.altKey && !e.metaKey && !/^F\d/.test(e.code);
}

// A key held down auto-repeats; only the first press toggles. The press is only
// swallowed when something actually happened, so e.g. Ctrl+Shift+Z is still
// "redo" in the chat box while you're not in a call.
function runToggle(e, toggle) {
  if (e.repeat) {
    if (state.isInVoice) e.preventDefault();
    return;
  }
  if (toggle()) e.preventDefault();
}

function onKeyDown(e) {
  if (paused || e.isComposing || isPlainTyping(e)) return;
  const accel = eventToAccelerator(e);
  if (!accel) return;

  if (accel === getSetting('muteKey') && !globalActive.mute) {
    runToggle(e, toggleMute);
  } else if (accel === getSetting('deafenKey') && !globalActive.deafen) {
    runToggle(e, toggleDeafen);
  } else if (getSetting('pttEnabled') && accel === getSetting('pttKey')) {
    if (state.isInVoice) e.preventDefault();
    if (!e.repeat) setPttHeld(true);
  }
}

const MODIFIER_FOR_CODE = {
  ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt',
  ShiftLeft: 'Shift', ShiftRight: 'Shift', MetaLeft: 'Meta', MetaRight: 'Meta',
};

// Let go when the key that completes the shortcut, or one of its modifiers, comes up.
function onKeyUp(e) {
  if (!getSetting('pttEnabled')) return;
  const parsed = parseAccelerator(getSetting('pttKey'));
  if (!parsed) return;
  if (parsed.mods.has(MODIFIER_FOR_CODE[e.code]) || keyFromCode(e.code) === parsed.key) setPttHeld(false);
}

async function syncGlobalHotkeys() {
  if (!window.hotkeys) return;
  const wanted = getSetting('globalHotkeys');
  const result = await window.hotkeys.set({
    mute: wanted ? toElectronAccelerator(getSetting('muteKey')) : null,
    deafen: wanted ? toElectronAccelerator(getSetting('deafenKey')) : null,
  });
  globalActive = { mute: Boolean(result?.mute), deafen: Boolean(result?.deafen) };
  document.dispatchEvent(new CustomEvent('hotkey-status'));
}

export function initHotkeys() {
  // Capture phase, so nothing else on the page can swallow the key first.
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', () => setPttHeld(false));

  if (window.hotkeys) {
    window.hotkeys.onTrigger((action) => {
      if (paused) return;
      if (action === 'mute') toggleMute();
      else if (action === 'deafen') toggleDeafen();
    });
    syncGlobalHotkeys();
    onSettingChange((key) => {
      if (key === 'muteKey' || key === 'deafenKey' || key === 'globalHotkeys') syncGlobalHotkeys();
    });
  }
}
