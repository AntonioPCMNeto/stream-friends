import { showToast } from './toast.js';

// Electron only. main.js wires electron-updater and exposes `window.updater`
// through preload.js; on the web build that bridge is absent, so the button
// stays hidden and the web app keeps updating on plain reload.
export function initUpdater() {
  const btn = document.getElementById('checkUpdatesBtn');
  if (!btn || !window.updater) return;

  let mode = 'idle'; // idle | busy | restart

  const showVersionLabel = () =>
    window.updater.version().then((v) => {
      if (mode === 'idle') btn.textContent = `Verificar atualizações · v${v}`;
    });

  btn.classList.remove('hidden');
  showVersionLabel();

  btn.addEventListener('click', async () => {
    if (mode === 'busy') return;
    if (mode === 'restart') {
      window.updater.install();
      return;
    }

    const res = await window.updater.check();
    if (res.state === 'dev') {
      showToast('Atualizações automáticas só funcionam no app instalado.');
      return;
    }
    if (res.state === 'error') {
      showToast(`Falha ao verificar atualizações: ${res.message}`, 'error');
      return;
    }
    mode = 'busy';
    btn.textContent = 'Verificando…';
  });

  window.updater.onStatus((s) => {
    switch (s.state) {
      case 'available':
        btn.textContent = `Baixando v${s.version}…`;
        showToast(`Atualização v${s.version} encontrada. Baixando…`);
        break;
      case 'downloading':
        btn.textContent = `Baixando… ${s.percent}%`;
        break;
      case 'downloaded':
        mode = 'restart';
        btn.textContent = 'Reiniciar para atualizar';
        showToast(`Atualização v${s.version} pronta. Reinicie para aplicar.`);
        break;
      case 'up-to-date':
        mode = 'idle';
        showVersionLabel();
        showToast('Você já está na versão mais recente.');
        break;
      case 'error':
        mode = 'idle';
        showVersionLabel();
        showToast(`Falha na atualização: ${s.message}`, 'error');
        break;
    }
  });
}
