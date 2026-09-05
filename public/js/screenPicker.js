// Electron doesn't show a native "choose what to share" dialog — this module
// is the themed replacement. share.js calls pickSource() before it invokes
// getDisplayMedia(); the promise resolves to
// { sourceId, isScreen, audioMode, deviceId } or null if the user cancels.
// audioMode 'system' is applied via main.js's display-media handler (see
// screen-picker:choose there); 'device' is a plain getUserMedia capture that
// share.js merges into the outgoing stream itself.

let overlay = null;
let selectedButton = null;
let selectedSourceId = null;
let selectedIsScreen = false;
// 'none' | 'system' (whole-system loopback, screen-only) | 'device' (a
// specific input, e.g. a virtual audio cable — see populateAudioOptions).
// Persisted across picker opens, same as the old audioEnabled checkbox was.
let audioMode = 'none';
let selectedDeviceId = null;
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

// Labels are blank until the app has been granted mic permission at least
// once — probe with a throwaway getUserMedia so the dropdown shows real
// device names (e.g. "CABLE Output (VB-Audio Virtual Cable)") instead of
// blank entries. Electron auto-grants this (main.js registers no
// setPermissionRequestHandler), so it's silent beyond a one-time OS prompt.
async function listAudioInputDevices() {
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.some((d) => d.kind === 'audioinput' && !d.label)) {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    }
    return devices.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}

function showPicker(sources, audioDevices) {
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

  // Electron's built-in loopback can only capture whole-system audio (no API
  // isolates a single window/app's sound), so it's only offered when sharing
  // an entire screen — for a window it would silently leak every other app's
  // audio despite the user picking just one window's video. The device
  // option is the workaround: route the game/app's output to a virtual audio
  // cable (VB-Cable, VoiceMeeter, ...) and pick that cable's input here —
  // it's a normal getUserMedia capture (share.js), so it works for a window
  // pick too and carries only that routed audio.
  const audioField = document.createElement('label');
  audioField.className = 'picker-audio-field';
  const audioFieldLabel = document.createElement('span');
  audioFieldLabel.textContent = 'Áudio';
  const audioSelect = document.createElement('select');
  audioSelect.className = 'picker-audio-select';
  audioField.appendChild(audioFieldLabel);
  audioField.appendChild(audioSelect);
  footer.appendChild(audioField);

  const audioHint = document.createElement('span');
  audioHint.className = 'picker-audio-hint';
  audioHint.textContent = 'Para isolar o áudio de um app/jogo específico, roteie a saída dele para um cabo de áudio virtual (ex.: VB-Cable) e selecione-o aqui.';
  footer.appendChild(audioHint);

  function populateAudioOptions(systemAvailable) {
    audioSelect.innerHTML = '';
    audioSelect.appendChild(new Option('Nenhum', 'none'));
    if (systemAvailable) audioSelect.appendChild(new Option('Áudio do sistema', 'system'));
    audioDevices.forEach((d) => {
      audioSelect.appendChild(new Option(d.label || `Entrada ${d.deviceId.slice(0, 6)}`, d.deviceId));
    });

    // Restore the previous choice if it's still valid for this tab; otherwise
    // fall back to 'none' instead of silently keeping a stale pick (e.g.
    // 'system' selected, then switching to the Janelas tab).
    const validValues = Array.from(audioSelect.options).map((o) => o.value);
    let restore = 'none';
    if (audioMode === 'system' && systemAvailable) restore = 'system';
    else if (audioMode === 'device' && validValues.includes(selectedDeviceId)) restore = selectedDeviceId;
    audioSelect.value = restore;

    if (restore === 'none') { audioMode = 'none'; selectedDeviceId = null; }
    else if (restore === 'system') { audioMode = 'system'; selectedDeviceId = null; }
    else { audioMode = 'device'; selectedDeviceId = restore; }
  }

  audioSelect.addEventListener('change', () => {
    if (audioSelect.value === 'none') { audioMode = 'none'; selectedDeviceId = null; }
    else if (audioSelect.value === 'system') { audioMode = 'system'; selectedDeviceId = null; }
    else { audioMode = 'device'; selectedDeviceId = audioSelect.value; }
  });

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
      deviceId: selectedDeviceId,
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
    populateAudioOptions(true);
    renderGrid(screens);
  });
  const windowTab = buildTabButton(`Janelas (${windows.length})`, () => {
    windowTab.classList.add('active');
    screenTab.classList.remove('active');
    populateAudioOptions(false);
    renderGrid(windows);
  });
  tabs.appendChild(screenTab);
  tabs.appendChild(windowTab);

  if (screens.length) {
    screenTab.classList.add('active');
    populateAudioOptions(true);
    renderGrid(screens);
  } else {
    windowTab.classList.add('active');
    populateAudioOptions(false);
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

  const [sources, audioDevices] = await Promise.all([
    window.screenPicker.listSources(),
    listAudioInputDevices(),
  ]);
  return new Promise((resolve) => {
    resolvePick = resolve;
    showPicker(sources, audioDevices);
  });
}
