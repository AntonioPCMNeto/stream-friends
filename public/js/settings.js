// User preferences, persisted in localStorage as one JSON object. Everything
// reads through getSetting() and reacts through onSettingChange(), so the
// settings page, voice.js, sounds and the hotkeys never hold their own copy.
//
// Keyboard shortcuts are stored as accelerator strings such as "Ctrl+Shift+Z":
// modifiers in the fixed order Ctrl, Alt, Shift, Meta, then one key named after
// its physical position (KeyboardEvent.code), so a shortcut means the same key
// on every keyboard layout.

const STORAGE_KEY = 'scrimaAi.settings';

export const DEFAULTS = {
  inputVolume: 100, // % of the microphone level, 0-200
  outputVolume: 100, // % applied on top of each person's own volume, 0-100
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  pttEnabled: false,
  pttKey: 'V',
  muteKey: 'Ctrl+Shift+Z',
  deafenKey: 'Ctrl+Shift+D',
  globalHotkeys: true, // desktop app only: mute/deafen work while another app has focus
  soundsJoinLeave: true,
  soundsMute: true,
  soundsVolume: 100, // 0-100
  notifications: false,
  theme: 'dark', // 'dark' | 'light' | 'system'
  uiZoom: 100, // desktop app only, percent
};

const RANGES = {
  inputVolume: [0, 200],
  outputVolume: [0, 100],
  soundsVolume: [0, 100],
  uiZoom: [50, 200],
};
const BOOLEANS = [
  'noiseSuppression', 'echoCancellation', 'autoGainControl', 'pttEnabled', 'globalHotkeys',
  'soundsJoinLeave', 'soundsMute', 'notifications',
];
const THEMES = ['dark', 'light', 'system'];

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);
const NAMED_KEYS = {
  Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete',
  Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const ALLOWED_KEYS = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Object.values(NAMED_KEYS),
]);

export function keyFromCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED_KEYS[code] || null;
}

export function isModifierCode(code) {
  return MODIFIER_CODES.has(code);
}

// null for a bare modifier press or a key that can't be bound (numpad, media keys...).
export function eventToAccelerator(e) {
  const key = keyFromCode(e.code);
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  return [...mods, key].join('+');
}

export function parseAccelerator(accel) {
  if (typeof accel !== 'string' || !accel) return null;
  const parts = accel.split('+');
  // A binding on "+" itself is not offered, so every "+" is a separator.
  const key = parts.pop();
  if (!ALLOWED_KEYS.has(key)) return null;
  const mods = new Set(parts);
  if (mods.size !== parts.length || parts.some((m) => !MODIFIER_ORDER.includes(m))) return null;
  const canonical = [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
  return canonical === accel ? { mods, key } : null;
}

export function isFunctionKey(key) {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
}

// A binding that is safe to grab system-wide: a bare letter or Shift+letter
// would break typing in every other app, so it needs Ctrl/Alt/Meta or an F-key.
export function isSafeGlobalAccelerator(accel) {
  const parsed = parseAccelerator(accel);
  if (!parsed) return false;
  return parsed.mods.has('Ctrl') || parsed.mods.has('Alt') || parsed.mods.has('Meta') || isFunctionKey(parsed.key);
}

export function formatAccelerator(accel) {
  return accel ? accel.replace(/\+/g, ' + ') : 'Não definido';
}

// The spelling Electron's globalShortcut expects.
export function toElectronAccelerator(accel) {
  return accel.replace('Ctrl', 'Control').replace('Meta', 'Super');
}

function clean(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  Object.entries(RANGES).forEach(([key, [min, max]]) => {
    if (Number.isFinite(raw[key])) out[key] = Math.min(max, Math.max(min, Math.round(raw[key])));
  });
  BOOLEANS.forEach((key) => {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  });
  if (THEMES.includes(raw.theme)) out.theme = raw.theme;
  if (parseAccelerator(raw.pttKey)) out.pttKey = raw.pttKey;
  ['muteKey', 'deafenKey'].forEach((key) => {
    if (isSafeGlobalAccelerator(raw[key])) out[key] = raw[key];
  });
  return out;
}

function load() {
  try {
    return clean(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return { ...DEFAULTS };
  }
}

let values = load();
const listeners = new Set();

export function getSetting(key) {
  return values[key];
}

// Returns false (and changes nothing) for a value the setting can't hold, e.g.
// an unbindable shortcut; numbers are clamped into range instead.
export function setSetting(key, value) {
  if (!(key in DEFAULTS)) return false;
  const next = clean({ ...values, [key]: value });
  if (!(key in RANGES) && next[key] !== value) return false;
  if (next[key] === values[key]) return true;
  values = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(values)); } catch { /* best-effort only */ }
  listeners.forEach((callback) => callback(key, values[key]));
  return true;
}

export function resetSetting(key) {
  setSetting(key, DEFAULTS[key]);
}

export function onSettingChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
