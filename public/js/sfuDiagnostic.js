// When the SFU can't be reached, collect what a remote person's browser can tell
// us about why (the real net::ERR_ code isn't visible to JS), and offer it as a
// one-click copy from the toast. Also kept on window.scrimaSfuDiagnostic.
import { showToast } from './toast.js';

const PROBE_TIMEOUT_MS = 6000;

function describeError(err) {
  return {
    name: err?.name,
    message: err?.message,
    reason: err?.reasonName ?? err?.reason,
    status: err?.status,
    context: err?.context === undefined ? undefined : String(err.context),
  };
}

async function probeHttps(origin) {
  const started = performance.now();
  try {
    const res = await fetch(`${origin}/rtc/v1/validate`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return { ok: true, status: res.status, ms: Math.round(performance.now() - started) };
  } catch (err) {
    return { ok: false, error: `${err?.name}: ${err?.message}`, ms: Math.round(performance.now() - started) };
  }
}

// No token, so a healthy server answers 401 and the browser reports a failed
// handshake either way; the useful signals are how fast it failed and the close code.
function probeWebSocket(wsUrl) {
  return new Promise((resolve) => {
    const started = performance.now();
    const result = { opened: false };
    let ws;
    const finish = (extra) => {
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve({ ...result, ...extra, ms: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => finish({ timedOut: true }), PROBE_TIMEOUT_MS);
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      finish({ constructorError: `${err?.name}: ${err?.message}` });
      return;
    }
    ws.onopen = () => { result.opened = true; };
    ws.onclose = (e) => finish({ closeCode: e.code, wasClean: e.wasClean });
  });
}

async function collect(err, socket, sfuUrl) {
  const host = sfuUrl ? new URL(sfuUrl).host : null;
  const [https, websocket] = host
    ? await Promise.all([probeHttps(`https://${host}`), probeWebSocket(`wss://${host}/rtc/v1`)])
    : [null, null];
  const conn = navigator.connection;
  return {
    time: new Date().toISOString(),
    page: location.origin,
    userAgent: navigator.userAgent,
    online: navigator.onLine,
    network: conn ? { type: conn.type, effectiveType: conn.effectiveType, rtt: conn.rtt } : undefined,
    appSocket: { connected: socket?.connected, transport: socket?.io?.engine?.transport?.name },
    sfuHost: host,
    error: describeError(err),
    probes: { https, websocket },
  };
}

export function reportSfuFailure(err, socket, sfuUrl) {
  let copied = null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(await copied, null, 2));
      showToast('Diagnóstico copiado — cole e envie.');
    } catch {
      showToast('Não foi possível copiar. Use o console: scrimaSfuDiagnostic', 'error', { duration: 6000 });
    }
  };
  copied = collect(err, socket, sfuUrl).then((d) => {
    window.scrimaSfuDiagnostic = d;
    console.error('[sfu] diagnostic', d);
    return d;
  });
  showToast('Servidor de vídeo indisponível — usando conexão direta (P2P). Clique aqui para copiar o diagnóstico.', 'error', {
    onClick: copy,
    duration: 12000,
  });
}
