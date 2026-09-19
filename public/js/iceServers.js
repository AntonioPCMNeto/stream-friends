// STUN handles most NATs; TURN relays traffic when a direct connection
// can't be established (symmetric NATs, restrictive firewalls, CGNAT).
// TURN credentials come from our own server's /api/ice-servers, which
// proxies Cloudflare Realtime TURN via Hugging Face's free relay
// (https://huggingface.co/blog/fastrtc-cloudflare) — keeps the HF token off
// the client. If the server has no HF_TOKEN configured, or the fetch fails,
// we fall back to STUN-only: direct P2P still works, relayed connections
// (the ones that actually need TURN) won't.
const FALLBACK_STUN = [{ urls: 'stun:stun.l.google.com:19302' }];

// A live-binding export: peers.js/voice.js read this value each time they
// open a new RTCPeerConnection, so reassigning it here (on the initial load
// or a periodic refresh) is picked up by every connection created after
// that point, with no changes needed on the import side.
export let iceServers = FALLBACK_STUN;

// The server requests a matching TTL from Cloudflare — refresh a bit before
// credentials would expire so a long-running room doesn't quietly fall back
// to STUN-only for newly-created connections.
const REFRESH_MS = 50 * 60 * 1000;

async function loadIceServers() {
  try {
    const res = await fetch('/api/ice-servers');
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      iceServers = data.iceServers;
    }
  } catch (err) {
    // Leave `iceServers` as whatever last worked (or the STUN fallback on
    // the very first load) rather than clobbering a good value on a
    // transient refresh failure.
    console.warn('[iceServers] using STUN-only fallback:', err.message);
  }
}

// Called once at startup. The first fetch is fire-and-forget rather than
// awaited by callers — by the time anyone actually joins a room and opens a
// peer connection, it's essentially always already resolved; the small
// window where it hasn't just means that one connection is STUN-only, same
// as the fallback path.
export function startIceServersRefresh() {
  loadIceServers();
  setInterval(loadIceServers, REFRESH_MS);
}
