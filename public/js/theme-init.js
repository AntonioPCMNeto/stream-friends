// Classic (non-module) script loaded from <head> so the saved theme is on <html>
// before the first paint — a module would run after it and flash the dark theme
// at someone who chose light. Reads the same localStorage entry as settings.js.
(function () {
  var theme = 'dark';
  try {
    var saved = JSON.parse(localStorage.getItem('scrimaAi.settings') || '{}').theme;
    if (saved === 'system') saved = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    if (saved === 'light') theme = 'light';
  } catch (e) { /* unreadable storage: stay dark */ }
  document.documentElement.setAttribute('data-theme', theme);
})();
