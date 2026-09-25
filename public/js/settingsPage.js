import {
  DEFAULTS, getSetting, setSetting, resetSetting, eventToAccelerator, isSafeGlobalAccelerator, parseAccelerator,
  formatAccelerator,
} from './settings.js';
import { getIdentity, updateUsername, updatePassword } from './auth.js';
import { buildAvatar } from './identity.js';
import { showToast } from './toast.js';
import { startMicTest, stopMicTest, refreshAudioDevices } from './voice.js';
import { pauseHotkeys, getGlobalHotkeyStatus } from './hotkeys.js';
import { openProfileModal } from './profile.js';

// The full-screen settings page (Discord-style: sections on the left, controls
// on the right). Opened from the ⚙️ in the lobby card and from the gear menu in
// a room. Every control writes straight to settings.js, which is what
// voice.js/hotkeys.js/theme.js react to, so nothing here needs an "apply".

const KEYBINDS = [
  { key: 'muteKey', label: 'Silenciar / ativar microfone', global: true },
  { key: 'deafenKey', label: 'Ensurdecer / desativar surdina', global: true },
  { key: 'pttKey', label: 'Apertar para falar', global: false },
];

export function initSettingsPage() {
  const $ = (id) => document.getElementById(id);
  const page = $('settingsPage');
  const sections = [...page.querySelectorAll('.settings-section')];
  const navItems = [...page.querySelectorAll('.settings-nav-item[data-section]')];
  const syncers = []; // each re-reads its setting into its control
  let recording = null; // { key, button, onKeyDown }
  let testing = false;

  // ---------- open / close ----------

  function showSection(name) {
    if (name !== 'voice') stopTest();
    if (name !== 'keybinds') cancelRecording();
    sections.forEach((section) => section.classList.toggle('hidden', section.dataset.section !== name));
    navItems.forEach((item) => item.classList.toggle('active', item.dataset.section === name));
  }

  async function open(section = 'account') {
    // From a room, the gear menu is still open behind the page.
    if (!$('userBarPopover').classList.contains('hidden')) $('userBarSettingsBtn').click();
    page.classList.remove('hidden');
    syncers.forEach((sync) => sync());
    refreshHotkeyStatus();
    refreshAudioDevices();
    showSection(section);
    refreshAccount();
    refreshDesktop();
    navItems.find((item) => item.dataset.section === section)?.focus();
  }

  function close() {
    stopTest();
    cancelRecording();
    page.classList.add('hidden');
  }

  navItems.forEach((item) => item.addEventListener('click', () => showSection(item.dataset.section)));
  $('settingsCloseBtn').addEventListener('click', close);
  $('settingsBackBtn').addEventListener('click', close);

  // Clicking the dimmed area closes it — but only when the press started there
  // too, so dragging a text selection out of the panel doesn't dismiss it.
  let pressedOnBackdrop = false;
  page.addEventListener('mousedown', (e) => { pressedOnBackdrop = e.target === page; });
  page.addEventListener('click', (e) => {
    if (e.target === page && pressedOnBackdrop) close();
  });

  // Keep Tab inside the panel while it's open (the page behind it is not reachable).
  page.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = [...page.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !page.classList.contains('hidden') && !recording) close();
  });
  [$('lobbySettingsBtn'), $('userBarSettingsPageBtn')].forEach((btn) => btn?.addEventListener('click', () => open()));

  // ---------- generic bindings ----------

  function bindCheck(id, key, onChange) {
    const el = $(id);
    const sync = () => { el.checked = getSetting(key); };
    el.addEventListener('change', () => {
      setSetting(key, el.checked);
      onChange?.(el.checked);
    });
    syncers.push(sync);
  }

  function bindRange(id, key) {
    const el = $(id);
    const out = $(`${id}Value`);
    const sync = () => {
      el.value = String(getSetting(key));
      out.textContent = `${getSetting(key)}%`;
    };
    el.addEventListener('input', () => {
      setSetting(key, Number(el.value));
      out.textContent = `${getSetting(key)}%`;
    });
    syncers.push(sync);
  }

  function bindSelect(id, key, parse = (v) => v) {
    const el = $(id);
    const sync = () => { el.value = String(getSetting(key)); };
    el.addEventListener('change', () => setSetting(key, parse(el.value)));
    syncers.push(sync);
  }

  // ---------- voice ----------

  bindRange('settingsInputVolume', 'inputVolume');
  bindRange('settingsOutputVolume', 'outputVolume');
  bindCheck('settingsNoiseSuppression', 'noiseSuppression');
  bindCheck('settingsEchoCancellation', 'echoCancellation');
  bindCheck('settingsAutoGainControl', 'autoGainControl');
  bindCheck('settingsPttEnabled', 'pttEnabled');

  const testBtn = $('settingsMicTestBtn');
  const meterFill = $('settingsMicMeterFill');
  const testHint = $('settingsMicTestHint');

  function stopTest() {
    stopMicTest();
    testing = false;
    testBtn.textContent = 'Testar microfone';
    meterFill.style.width = '0%';
    testHint.textContent = '';
  }

  async function toggleTest() {
    if (testing) {
      stopTest();
      return;
    }
    testBtn.disabled = true;
    testHint.textContent = 'Abrindo o microfone…';
    try {
      const { live } = await startMicTest((level) => { meterFill.style.width = `${Math.round(level * 100)}%`; });
      testing = true;
      testBtn.textContent = 'Parar teste';
      testHint.textContent = live
        ? 'Lendo o microfone da chamada atual — se você estiver silenciado, a barra fica parada.'
        : 'Fale algo: a barra mostra o que os outros ouviriam.';
    } catch (err) {
      if (err.name === 'AbortError') testHint.textContent = '';
      else if (err.name === 'NotAllowedError') testHint.textContent = 'Permissão de microfone negada.';
      else testHint.textContent = 'Nenhum microfone disponível.';
    } finally {
      testBtn.disabled = false;
    }
  }
  testBtn.addEventListener('click', toggleTest);

  // ---------- keyboard shortcuts ----------

  const keybindRows = [...page.querySelectorAll('.settings-keybind')];
  const keybindError = $('settingsKeybindError');

  function refreshKeybinds() {
    keybindRows.forEach((row) => {
      const button = row.querySelector('.keybind-btn');
      button.classList.remove('recording');
      button.textContent = formatAccelerator(getSetting(row.dataset.key));
    });
  }

  function refreshHotkeyStatus() {
    const status = getGlobalHotkeyStatus();
    $('settingsGlobalRow').classList.toggle('hidden', !status.available);
    KEYBINDS.filter((b) => b.global).forEach(({ key }) => {
      const row = keybindRows.find((r) => r.dataset.key === key);
      const badge = row.querySelector('.keybind-status');
      const action = key === 'muteKey' ? 'mute' : 'deafen';
      if (!status.available) badge.textContent = 'Só funciona com o app em foco';
      else if (!getSetting('globalHotkeys')) badge.textContent = 'Global desligado — só com o app em foco';
      else badge.textContent = status[action] ? 'Global: funciona em qualquer janela' : '⚠ Outro programa já usa este atalho — só funciona com o app em foco';
    });
    const ptt = keybindRows.find((r) => r.dataset.key === 'pttKey');
    ptt.querySelector('.keybind-status').textContent = 'Só funciona com o app em foco';
  }
  document.addEventListener('hotkey-status', refreshHotkeyStatus);

  function conflictFor(key, accel) {
    return KEYBINDS.find((b) => b.key !== key && getSetting(b.key) === accel);
  }

  function assignKeybind(key, accel) {
    const isGlobal = KEYBINDS.find((b) => b.key === key).global;
    if (isGlobal && !isSafeGlobalAccelerator(accel)) {
      keybindError.textContent = 'Use Ctrl, Alt ou Win junto com uma tecla, ou uma tecla F1–F24.';
      return false;
    }
    if (!isGlobal && !parseAccelerator(accel)) {
      keybindError.textContent = 'Essa tecla não pode ser usada como atalho.';
      return false;
    }
    const other = conflictFor(key, accel);
    if (other) {
      keybindError.textContent = `${formatAccelerator(accel)} já é usado por "${other.label}".`;
      return false;
    }
    keybindError.textContent = '';
    return setSetting(key, accel);
  }

  function cancelRecording() {
    if (!recording) return;
    document.removeEventListener('keydown', recording.onKeyDown, true);
    recording = null;
    pauseHotkeys(false);
    refreshKeybinds();
  }

  function startRecording(row) {
    cancelRecording();
    keybindError.textContent = '';
    const button = row.querySelector('.keybind-btn');
    button.classList.add('recording');
    button.textContent = 'Pressione as teclas… (Esc cancela)';
    pauseHotkeys(true);

    const onKeyDown = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'Escape') {
        cancelRecording();
        return;
      }
      const accel = eventToAccelerator(e);
      if (!accel) return; // a modifier on its own — wait for the key that completes it
      if (assignKeybind(row.dataset.key, accel)) cancelRecording();
    };
    recording = { key: row.dataset.key, button, onKeyDown };
    document.addEventListener('keydown', onKeyDown, true);
  }

  keybindRows.forEach((row) => {
    row.querySelector('.keybind-btn').addEventListener('click', () => startRecording(row));
    row.querySelector('.keybind-reset').addEventListener('click', () => {
      cancelRecording();
      const key = row.dataset.key;
      assignKeybind(key, DEFAULTS[key]);
      refreshKeybinds();
    });
  });
  syncers.push(refreshKeybinds);
  bindCheck('settingsGlobalHotkeys', 'globalHotkeys', refreshHotkeyStatus);

  // ---------- sounds and notifications ----------

  bindCheck('settingsSoundsJoinLeave', 'soundsJoinLeave');
  bindCheck('settingsSoundsMute', 'soundsMute');
  bindRange('settingsSoundsVolume', 'soundsVolume');

  const notifBox = $('settingsNotifications');
  const notifHint = $('settingsNotifHint');
  const syncNotifications = () => {
    const supported = typeof Notification !== 'undefined';
    const allowed = supported && Notification.permission === 'granted';
    notifBox.checked = getSetting('notifications') && allowed;
    notifBox.disabled = !supported;
    notifHint.textContent = !supported
      ? 'Este navegador não suporta notificações.'
      : Notification.permission === 'denied'
        ? 'As notificações estão bloqueadas — libere-as nas configurações do navegador ou do sistema.'
        : '';
  };
  notifBox.addEventListener('change', async () => {
    if (!notifBox.checked) {
      setSetting('notifications', false);
      return;
    }
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    setSetting('notifications', permission === 'granted');
    syncNotifications();
  });
  syncers.push(syncNotifications);

  // ---------- appearance ----------

  bindSelect('settingsTheme', 'theme');
  bindSelect('settingsZoom', 'uiZoom', Number);
  $('settingsZoomRow').classList.toggle('hidden', !window.desktop);

  // ---------- desktop app ----------

  const openAtLogin = $('settingsOpenAtLogin');
  const startMinimized = $('settingsStartMinimized');
  const closeToTray = $('settingsCloseToTray');
  const desktopHint = $('settingsDesktopHint');
  $('settingsNavApp').classList.toggle('hidden', !window.desktop);

  async function refreshDesktop() {
    if (!window.desktop) return;
    const prefs = await window.desktop.getPrefs();
    openAtLogin.checked = prefs.openAtLogin;
    startMinimized.checked = prefs.startMinimized;
    closeToTray.checked = prefs.closeToTray;
    openAtLogin.disabled = !prefs.packaged;
    startMinimized.disabled = !prefs.packaged || !prefs.openAtLogin;
    desktopHint.textContent = prefs.packaged ? '' : 'Iniciar com o Windows só funciona no aplicativo instalado.';
  }
  [[openAtLogin, 'openAtLogin'], [startMinimized, 'startMinimized'], [closeToTray, 'closeToTray']].forEach(([el, key]) => {
    el.addEventListener('change', async () => {
      await window.desktop.setPrefs({ [key]: el.checked });
      refreshDesktop();
    });
  });

  // ---------- account ----------

  const accountError = $('settingsAccountError');
  let identity = null;

  async function refreshAccount() {
    identity = await getIdentity();
    $('settingsGuestNote').classList.toggle('hidden', Boolean(identity));
    $('settingsAccount').classList.toggle('hidden', !identity);
    $('settingsLogoutBtn').classList.toggle('hidden', !identity);
    accountError.textContent = '';
    if (!identity) return;

    const avatar = buildAvatar(identity.username, identity.avatarUrl);
    $('settingsAvatar').replaceChildren(avatar);
    $('settingsProfileName').textContent = identity.username;
    $('settingsProfileEmail').textContent = identity.email || '';
    $('settingsUsernameInput').value = identity.username || '';
    $('settingsEmail').textContent = identity.email || '—';
    $('settingsUserId').textContent = identity.userId || '—';
  }

  $('settingsPhotoBtn').addEventListener('click', openProfileModal);

  $('settingsUsernameBtn').addEventListener('click', async () => {
    const name = $('settingsUsernameInput').value.trim();
    accountError.textContent = '';
    if (name.length < 2 || name.length > 30) {
      accountError.textContent = 'O nome precisa ter entre 2 e 30 caracteres.';
      return;
    }
    if (name === identity?.username) return;
    $('settingsUsernameBtn').disabled = true;
    const { error } = await updateUsername(name);
    $('settingsUsernameBtn').disabled = false;
    if (error) {
      accountError.textContent = error;
      return;
    }
    showToast('Nome atualizado!');
    refreshAccount();
  });

  $('settingsPasswordBtn').addEventListener('click', async () => {
    const password = $('settingsPasswordInput').value;
    accountError.textContent = '';
    if (password.length < 6) {
      accountError.textContent = 'A senha deve ter pelo menos 6 caracteres.';
      return;
    }
    if (password !== $('settingsPasswordConfirmInput').value) {
      accountError.textContent = 'As senhas não são iguais.';
      return;
    }
    $('settingsPasswordBtn').disabled = true;
    const { error } = await updatePassword(password);
    $('settingsPasswordBtn').disabled = false;
    if (error) {
      accountError.textContent = error;
      return;
    }
    $('settingsPasswordInput').value = '';
    $('settingsPasswordConfirmInput').value = '';
    showToast('Senha alterada!');
  });

  $('settingsCopyIdBtn').addEventListener('click', () => {
    if (!identity?.userId) return;
    navigator.clipboard.writeText(identity.userId).then(
      () => showToast('ID copiado.'),
      () => showToast('Não foi possível copiar.', 'error')
    );
  });

  $('settingsLogoutBtn').addEventListener('click', () => {
    close();
    $('userBarLogoutBtn').click();
  });

  // The profile dialog changes the photo/name from outside this page.
  document.addEventListener('profile-changed', () => {
    if (!page.classList.contains('hidden')) refreshAccount();
  });
}
