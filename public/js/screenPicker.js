// Electron doesn't show a native "choose what to share" dialog — this module
// is the themed replacement. share.js calls pickSource() before it invokes
// getDisplayMedia(); the promise resolves to
// { sourceId, isScreen, audioMode } or null if the user cancels. audioMode
// 'system' (default-output loopback, screen or window) is applied via main.js's
// display-media handler (see screen-picker:choose there).

let overlay = null;
let selectedButton = null;
let selectedSourceId = null;
let selectedIsScreen = false;
// 'none' | 'system' (default). Persisted across picker opens, same as the old
// audioEnabled checkbox was.
let audioMode = 'system';
let onKeyDown = null;

// Which tab opens first. A window capture only copies that window's pixels,
// where a screen capture copies the whole display (every monitor's worth of
// GPU work, for a game on one), so Janelas is the default and the last tab the
// user chose is remembered — an exclusive-fullscreen game can capture black as
// a window, and picking Telas once should stick.
const TAB_STORAGE_KEY = 'scrimaAi.pickerTab';
function loadTab() {
  try { return localStorage.getItem(TAB_STORAGE_KEY); } catch { return null; }
}
function saveTab(tab) {
  try { localStorage.setItem(TAB_STORAGE_KEY, tab); } catch { /* the choice just isn't remembered */ }
}

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

  const hint = document.createElement('p');
  hint.className = 'picker-hint';
  card.appendChild(hint);

  const footer = document.createElement('div');
  footer.className = 'picker-footer';

  // Electron's built-in loopback captures whatever plays on the Windows
  // default output — no API isolates a single window/app's sound, nor picks
  // another output device or an input. Offered for screens and windows alike;
  // with a virtual default output such as Sonar's "Gaming" it's effectively
  // just the game.
  const audioField = document.createElement('label');
  audioField.className = 'picker-audio-field';
  const audioFieldLabel = document.createElement('span');
  audioFieldLabel.textContent = 'Áudio';
  const audioSelect = document.createElement('select');
  audioSelect.className = 'picker-audio-select';
  audioSelect.appendChild(new Option('Áudio do sistema (sem o Discord)', 'system'));
  audioSelect.appendChild(new Option('Sem áudio', 'none'));
  audioSelect.value = audioMode;
  audioSelect.addEventListener('change', () => { audioMode = audioSelect.value; });
  audioField.appendChild(audioFieldLabel);
  audioField.appendChild(audioSelect);
  footer.appendChild(audioField);

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
    finish({
      sourceId: selectedSourceId,
      isScreen: selectedIsScreen,
      audioMode,
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

  const showTab = (tab) => {
    const isWindows = tab === 'windows';
    windowTab.classList.toggle('active', isWindows);
    screenTab.classList.toggle('active', !isWindows);
    hint.textContent = isWindows
      ? 'Janela: captura só o conteúdo dela, o que pesa menos na GPU. Um jogo em tela cheia exclusiva pode aparecer preto — nesse caso use Telas.'
      : 'Tela: captura o monitor inteiro, incluindo tudo que estiver nele.';
    renderGrid(isWindows ? windows : screens);
  };
  const screenTab = buildTabButton(`Telas (${screens.length})`, () => { saveTab('screens'); showTab('screens'); });
  const windowTab = buildTabButton(`Janelas (${windows.length})`, () => { saveTab('windows'); showTab('windows'); });
  tabs.appendChild(screenTab);
  tabs.appendChild(windowTab);

  const saved = loadTab();
  const wantWindows = saved === 'screens' ? !screens.length : (windows.length > 0 || !screens.length);
  showTab(wantWindows ? 'windows' : 'screens');

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
