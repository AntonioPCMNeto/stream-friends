// Electron doesn't show a native "choose what to share" dialog — this module
// is the themed replacement. share.js calls pickSource() before it invokes
// getDisplayMedia(); the promise resolves to { sourceId, isScreen, withAudio }
// or null if the user cancels. main.js's display-media handler then applies
// the choice (see screen-picker:choose there).

let overlay = null;
let selectedButton = null;
let selectedSourceId = null;
let selectedIsScreen = false;
let audioEnabled = true;
let onKeyDown = null;

// Set for the lifetime of one picker; called exactly once with the result.
let resolvePick = null;

function finish(result) {
  const done = resolvePick;
  resolvePick = null;
  closeOverlay();
  if (done) done(result);
}

function closeOverlay() {
  if (onKeyDown) {
    document.removeEventListener('keydown', onKeyDown);
    onKeyDown = null;
  }
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
  cancelBtn.addEventListener('click', () => finish(null));

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn btn-primary';
  confirmBtn.textContent = 'Compartilhar';
  confirmBtn.disabled = true;
  confirmBtn.addEventListener('click', () => {
    if (!selectedSourceId) return;
    // Only ever request loopback audio for a screen share, regardless of
    // toggle state — the toggle is hidden (but not reset) on the windows tab.
    finish({
      sourceId: selectedSourceId,
      isScreen: selectedIsScreen,
      withAudio: selectedIsScreen && audioEnabled,
    });
  });

  footerBtns.appendChild(cancelBtn);
  footerBtns.appendChild(confirmBtn);
  footer.appendChild(footerBtns);
  card.appendChild(footer);

  function renderGrid(list) {
    grid.innerHTML = '';
    selectedButton = null;
    selectedSourceId = null;
    selectedIsScreen = false;
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
    if (e.target === overlay) finish(null);
  });
  onKeyDown = (e) => { if (e.key === 'Escape') finish(null); };
  document.addEventListener('keydown', onKeyDown);
}

// Shows the picker and resolves to the user's choice, or null on cancel.
// Only meaningful inside Electron (where window.screenPicker exists).
export async function pickSource() {
  if (!window.screenPicker) return null;
  if (resolvePick) finish(null); // abandon any picker already open

  const sources = await window.screenPicker.listSources();
  return new Promise((resolve) => {
    resolvePick = resolve;
    showPicker(sources);
  });
}
