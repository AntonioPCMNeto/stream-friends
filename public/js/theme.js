import { getSetting, onSettingChange } from './settings.js';

// Applies the theme (data-theme on <html>, which style.css keys its light
// palette off) and, in the desktop app, the interface zoom. theme-init.js has
// already set the theme before the first paint; this keeps it in step with the
// setting and with the OS when "Sistema" is chosen.

const lightQuery = window.matchMedia?.('(prefers-color-scheme: light)');

function resolvedTheme() {
  const theme = getSetting('theme');
  if (theme === 'system') return lightQuery?.matches ? 'light' : 'dark';
  return theme;
}

function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
}

function applyZoom() {
  window.desktop?.setZoom(getSetting('uiZoom'));
}

export function initTheme() {
  applyTheme();
  applyZoom();
  onSettingChange((key) => {
    if (key === 'theme') applyTheme();
    else if (key === 'uiZoom') applyZoom();
  });
  lightQuery?.addEventListener?.('change', () => {
    if (getSetting('theme') === 'system') applyTheme();
  });
}
