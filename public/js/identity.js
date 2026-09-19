// Stable per-username color + initial avatar, Discord-style default avatars.
// Keyed by username (not socket id) so a peer's color survives a reconnect.
const PALETTE = ['#f04747', '#faa61a', '#43b581', '#1abc9c', '#3498db', '#9b59b6', '#e91e8c', '#2ecc71', '#e67e22', '#5865f2'];

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function colorForName(name) {
  return PALETTE[hashString(name || '?') % PALETTE.length];
}

export function buildAvatar(name) {
  const el = document.createElement('span');
  el.className = 'avatar';
  el.style.background = colorForName(name);
  el.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return el;
}
