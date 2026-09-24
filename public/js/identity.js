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

// username -> profile picture URL, fed by whatever the server tells us about
// peers (and our own account). Only for people — a server's icon in the rail
// goes through buildAvatar directly so a server can't pick up a user's photo
// just by sharing their name.
const avatarUrls = new Map();

export function setAvatarUrl(name, url) {
  if (!name) return;
  if (url) avatarUrls.set(name, url);
  else avatarUrls.delete(name);
}

// The initial-on-color avatar shows until the picture has actually loaded, so
// a slow or broken image just leaves the default in place.
export function buildAvatar(name, url) {
  const el = document.createElement('span');
  el.className = 'avatar';
  el.style.background = colorForName(name);
  el.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
  if (url) {
    const img = new Image();
    img.onload = () => {
      el.style.backgroundImage = `url(${JSON.stringify(url)})`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.textContent = '';
    };
    img.src = url;
  }
  return el;
}

export function buildUserAvatar(name) {
  return buildAvatar(name, avatarUrls.get(name));
}
