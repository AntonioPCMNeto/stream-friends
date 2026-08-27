// Electron doesn't show a native "choose what to share" dialog the way a
// browser does — main.js's setDisplayMediaRequestHandler asks us to render
// one instead, over IPC, and waits for our answer before getDisplayMedia()
// in share.js resolves. This module owns that themed replacement dialog.

let overlay = null;
let selectedButton = null;
let selectedSourceId = null;
let selectedIsScreen = false;
let audioEnabled = true;

function respond(result) {
  window.screenPicker.select(result);
  closeOverlay();
}

function closeOverlay() {
  if (overlay) overlay.remove();
  overlay = null;
  selectedButton = null;
  selectedSourceId = null;
  selectedIsScreen = false;
}

function buildSourceButton(source, confirmBtn) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'picker-source';

  const thumb = document.createElement('img');
  thumb.className = 'picker-thumb';
  thumb.src = source.thumbnailDataUrl;
  thumb.alt = '';

  const label = document.createElement('span');
  label.className = 'picker-source-label';
  label.textContent = source.name || (source.isScreen ? 'Tela' : 'Janela');

  btn.appendChild(thumb);
  btn.appendChild(label);

  btn.addEventListener('click', () => {
    if (selectedButton) selectedButton.classList.remove('active');
    btn.classList.add('active');
    selectedButton = btn;
    selectedSourceId = source.id;
    selectedIsScreen = source.isScreen;
    confirmBtn.disabled = false;
  });

  return btn;
}

function buildTabButton(text, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'picker-tab';
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}

function showPicker(sources) {
  const screens = sources.filter((s) => s.isScreen);
  const windows = sources.filter((s) => !s.isScreen);

  overlay = document.createElement('div');
  overlay.className = 'picker-overlay';

  const card = document.createElement('div');
  card.className = 'picker-card';

  const title = document.createElement('h3');
  title.className = 'picker-title';
  title.textContent = 'Escolha o que compartilhar';
  card.appendChild(title);

  const tabs = document.createElement('div');
  tabs.className = 'picker-tabs';
  card.appendChild(tabs);

  const grid = document.createElement('div');
  grid.className = 'picker-grid';
  card.appendChild(grid);

  const footer = document.createElement('div');
  footer.className = 'picker-footer';

  // Electron can only capture whole-system audio (no API isolates a single
  // window/app's sound), so the toggle is only honest when sharing an
  // entire screen — for a window it would silently leak every other app's
  // audio despite the user picking just one window's video.
  const audioToggle = document.createElement('label');
  audioToggle.className = 'picker-audio-toggle';
  const audioCheckbox = document.createElement('input');
  audioCheckbox.type = 'checkbox';
  audioCheckbox.checked = audioEnabled;
  audioCheckbox.addEventListener('change', () => { audioEnabled = audioCheckbox.checked; });
  const audioLabel = document.createElement('span');
  audioLabel.textContent = 'Compartilhar áudio do sistema';
  audioToggle.appendChild(audioCheckbox);
  audioToggle.appendChild(audioLabel);
  footer.appendChild(audioToggle);

  const audioHint = document.createElement('span');
  audioHint.className = 'picker-audio-hint';
  audioHint.textContent = 'Áudio disponível apenas ao compartilhar a tela inteira.';
  footer.appendChild(audioHint);

  function setAudioAvailable(available) {
    audioToggle.classList.toggle('hidden', !available);
    audioHint.classList.toggle('hidden', available);
  }

  const footerBtns = document.createElement('div');
  footerBtns.className = 'picker-footer-btns';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = 'Cancelar';
  cancelBtn.addEventListener('click', () => respond(null));

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn btn-primary';
  confirmBtn.textContent = 'Compartilhar';
  confirmBtn.disabled = true;
  confirmBtn.addEventListener('click', () => {
    if (!selectedSourceId) return;
    // Belt-and-suspenders: only ever request loopback audio for a screen
    // share, regardless of toggle state, since the toggle is hidden (but
    // not necessarily reset) when switching tabs.
    respond({ sourceId: selectedSourceId, withAudio: selectedIsScreen && audioEnabled });
  });

  footerBtns.appendChild(cancelBtn);
  footerBtns.appendChild(confirmBtn);
  footer.appendChild(footerBtns);
  card.appendChild(footer);

  function renderGrid(list) {
    grid.innerHTML = '';
    selectedButton = null;
    selectedSourceId = null;
    confirmBtn.disabled = true;
    list.forEach((source) => grid.appendChild(buildSourceButton(source, confirmBtn)));
  }

  const screenTab = buildTabButton(`Telas (${screens.length})`, () => {
    screenTab.classList.add('active');
    windowTab.classList.remove('active');
    setAudioAvailable(true);
    renderGrid(screens);
  });
  const windowTab = buildTabButton(`Janelas (${windows.length})`, () => {
    windowTab.classList.add('active');
    screenTab.classList.remove('active');
    setAudioAvailable(false);
    renderGrid(windows);
  });
  tabs.appendChild(screenTab);
  tabs.appendChild(windowTab);

  if (screens.length) {
    screenTab.classList.add('active');
    setAudioAvailable(true);
    renderGrid(screens);
  } else {
    windowTab.classList.add('active');
    setAudioAvailable(false);
    renderGrid(windows);
  }

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) respond(null);
  });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape' && overlay) {
      document.removeEventListener('keydown', onKey);
      respond(null);
    }
  });
}

export function initScreenPicker() {
  if (!window.screenPicker) return; // not running inside Electron
  window.screenPicker.onShow(showPicker);
}
