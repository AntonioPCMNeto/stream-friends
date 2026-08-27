import { iceServers } from './iceServers.js';
import { state } from './state.js';
import { renderTiles, updateTileStats } from './tiles.js';
import { showToast } from './toast.js';
import { refreshParticipants } from './participants.js';

const peerConnections = new Map(); // socket id -> RTCPeerConnection
let socket = null;

function getOrCreatePeerConnection(peerId) {
  let pc = peerConnections.get(peerId);
  if (pc) return pc;

  pc = new RTCPeerConnection({ iceServers });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { to: peerId, data: { type: 'candidate', candidate: event.candidate } });
    }
  };

  // 'disconnected' is often transient (brief network hiccup, ICE re-checks
  // on its own) — only 'failed' is terminal enough to be worth surfacing.
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      const label = state.peerUsernames.get(peerId) || `Usuário ${peerId.slice(0, 5)}`;
      showToast(`Falha na conexão com ${label}.`, 'error');
    }
  };

  // RECEIVER SIDE: a remote track means someone is sending us their screen
  pc.ontrack = (event) => {
    state.streams.set(peerId, event.streams[0]);
    renderTiles();

    // Only the video track ending means the share is gone — an audio track
    // stopping on its own shouldn't drop the tile. (In practice the
    // authoritative signal is 'peer-share-status'; this is the fallback.)
    if (event.track.kind === 'video') {
      event.track.onended = () => {
        state.streams.delete(peerId);
        renderTiles();
      };
    }
  };

  peerConnections.set(peerId, pc);
  return pc;
}

function closePeerConnection(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) {
    pc.close();
    peerConnections.delete(peerId);
  }
  lastStatsSample.delete(peerId);
  state.streams.delete(peerId);
  renderTiles();
}

// Tells the server (and, through it, everyone else in the room) whether
// we're currently sharing our screen.
export function announceSharingStatus(isSharing) {
  socket.emit('share-status', { isSharing });
}

export function closeAllPeerConnections() {
  Array.from(peerConnections.keys()).forEach(closePeerConnection);
}

// In a mesh each viewer gets an independent encode of the same screen, so
// total encode cost scales with viewer count. Past a few viewers, dropping
// the sent resolution keeps every stream's framerate alive instead of the
// encoder thrashing on all of them. Small sessions stay at full resolution.
function viewerResolutionScale() {
  const n = peerConnections.size;
  if (n <= 2) return 1;
  if (n <= 4) return 1.5;
  return 2;
}

// Closed-loop quality adaptation. viewerResolutionScale() above is a static
// guess from peer count; this reacts to what the encoder actually reports
// through qualityLimitationReason on the representative outbound stream (see
// pollStats). On a sustained 'cpu'/'bandwidth' limit we step down — first an
// extra resolution downscale, then a framerate cut — and step back up once
// the encoder has run unconstrained for a while.
//   level 0 = no extra limiting
//   level 1 = extra 1.5x resolution downscale
//   level 2 = level 1 + outgoing framerate capped at 20fps
// pollStats runs every 2s, so these thresholds are ~4s to back off and ~16s
// clean to recover — slow enough not to oscillate on a momentary spike.
const MAX_ADAPT_LEVEL = 2;
const ADAPT_DOWN_AFTER = 2;
const ADAPT_UP_AFTER = 8;
let adaptLevel = 0;
let limitedStreak = 0;
let cleanStreak = 0;

function adaptResolutionScale() {
  return adaptLevel >= 1 ? 1.5 : 1;
}

function adaptFramerateCap() {
  return adaptLevel >= 2 ? 20 : null;
}

function resetAdaptation() {
  adaptLevel = 0;
  limitedStreak = 0;
  cleanStreak = 0;
}

// Feeds the encoder's own limitation signal back into adaptLevel. Returns
// true when the level changed, so the caller re-applies encoding params.
function updateAdaptation(limitationReason) {
  const limited = limitationReason === 'cpu' || limitationReason === 'bandwidth';
  limitedStreak = limited ? limitedStreak + 1 : 0;
  cleanStreak = limited ? 0 : cleanStreak + 1;

  let next = adaptLevel;
  if (limitedStreak >= ADAPT_DOWN_AFTER && adaptLevel < MAX_ADAPT_LEVEL) next = adaptLevel + 1;
  else if (cleanStreak >= ADAPT_UP_AFTER && adaptLevel > 0) next = adaptLevel - 1;
  if (next === adaptLevel) return false;

  adaptLevel = next;
  limitedStreak = 0;
  cleanStreak = 0;
  return true;
}

// Configures a video sender: bitrate cap (state.videoBitrateKbps — falsy
// means no cap), the effective framerate cap (the lower of the user's
// setting and any adaptation cap), a resolution scale combining the
// viewer-count guess with the adaptation downscale, high network priority so
// the screen stream wins contention, and 'maintain-framerate' degradation.
// Screen-share content (games, video, scrolling) is motion-heavy, so a
// steady framerate reads as smoother than a sharper but stuttery picture —
// the default preference can sacrifice framerate to hold resolution, the
// wrong tradeoff here.
function applyEncodingParams(sender) {
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
  const enc = params.encodings[0];
  const fpsCaps = [state.videoFramerateFps, adaptFramerateCap()].filter(Boolean);
  enc.maxBitrate = state.videoBitrateKbps ? state.videoBitrateKbps * 1000 : undefined;
  enc.maxFramerate = fpsCaps.length ? Math.min(...fpsCaps) : undefined;
  enc.scaleResolutionDownBy = viewerResolutionScale() * adaptResolutionScale();
  enc.networkPriority = 'high';
  enc.priority = 'high';
  params.degradationPreference = 'maintain-framerate';
  sender.setParameters(params).catch((err) => console.error('Failed to set encoding params:', err));
}

// Re-applies the current bitrate/framerate settings to every active video
// sender — used when the user changes a share-panel control while already
// sharing.
export function updateEncodingParams() {
  peerConnections.forEach((pc) => {
    pc.getSenders().forEach((sender) => {
      if (sender.track && sender.track.kind === 'video') applyEncodingParams(sender);
    });
  });
}

// Reorders the offered video codecs so a hardware-friendly H.264 variant is
// negotiated first. H.264 has near-universal hardware encode/decode (Intel
// QuickSync, NVENC, AMD VCE); Chrome runs one encoder per peer connection,
// so a software codec (VP8/VP9/AV1) multiplies CPU per viewer while a
// hardware one stays roughly flat. Within H.264 we rank packetization-mode=1
// and Constrained Baseline (profile-level-id 42e01f / 42001f) highest —
// that's the profile every hardware encoder implements, so it's least
// likely to silently fall back to the software encoder. No-op (keeps the
// default order) where H.264 isn't offered at all.
function preferHardwareH264(pc, sender) {
  const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
  if (!transceiver?.setCodecPreferences) return;
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps) return;

  const h264Score = (c) => {
    const fmtp = (c.sdpFmtpLine || '').toLowerCase();
    let s = 0;
    if (fmtp.includes('packetization-mode=1')) s += 2;
    if (fmtp.includes('profile-level-id=42e01f') || fmtp.includes('profile-level-id=42001f')) s += 1;
    return s;
  };

  const h264 = caps.codecs
    .filter((c) => c.mimeType === 'video/H264')
    .sort((a, b) => h264Score(b) - h264Score(a));
  if (h264.length === 0) return;

  const rest = caps.codecs.filter((c) => c.mimeType !== 'video/H264');
  transceiver.setCodecPreferences([...h264, ...rest]);
}

// key ('local' or a remote peer id) -> { bytes, ts } from the last sample,
// used to turn cumulative byte counters into an instantaneous kbps figure.
const lastStatsSample = new Map();

// Turns a getStats() report into a "1280×720 · 30fps · 850kbps" tile badge,
// with an optional trailing note (codec, quality-limitation reason).
// The first sample for a key only seeds the baseline (no delta yet to show).
// A negative byte delta means the underlying sender/receiver changed between
// samples (e.g. share stopped and restarted) — skip that tick rather than
// show a bogus spike, and let the next sample re-seed cleanly.
function applyStatsSample(key, report, bytesField, note = '') {
  const bytes = report[bytesField];
  const ts = report.timestamp;
  const prev = lastStatsSample.get(key);
  lastStatsSample.set(key, { bytes, ts });

  if (!prev || !report.frameWidth || !report.frameHeight) return;
  const deltaBytes = bytes - prev.bytes;
  const deltaMs = ts - prev.ts;
  if (deltaBytes < 0 || deltaMs <= 0) return;

  const kbps = Math.round((deltaBytes * 8) / deltaMs);
  const fps = Math.round(report.framesPerSecond || 0);
  updateTileStats(key, `${report.frameWidth}×${report.frameHeight} · ${fps}fps · ${kbps}kbps${note}`);
}

// Logged once, the first time we see an outbound video encode — confirms
// which codec and encoder (hardware vs software) actually got negotiated.
let encoderLogged = false;

// Live capture-framerate measurement for the solo-sharer tile (no viewer =
// no outbound RTP to read framesPerSecond from). Counts frames straight off
// a clone of the capture track via MediaStreamTrackProcessor — unlike a
// <video> element's frame counter, this keeps running at the true capture
// rate even when the tab/window is backgrounded and rendering is throttled.
// Screen capture is content-driven, so it reads well below the nominal rate
// on a static screen — the honest number. Chromium-only; elsewhere the badge
// falls back to the track's nominal frameRate.
let frameCounter = null;   // { track (clone), reader, count, source (original) }
let localFrameSample = null; // { frames, ts }

function ensureFrameCounter() {
  const source = state.localStream?.getVideoTracks()[0];
  if (!source) return stopFrameCounter();
  if (frameCounter?.source === source) return;
  stopFrameCounter();
  if (typeof MediaStreamTrackProcessor === 'undefined') return;

  try {
    const track = source.clone();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const fc = { track, reader, count: 0, source };
    frameCounter = fc;
    (async () => {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        fc.count++;
        frame.close();
      }
    })().catch(() => {});
  } catch { /* not supported / track already ended */ }
}

function stopFrameCounter() {
  if (frameCounter) {
    frameCounter.reader.cancel().catch(() => {});
    frameCounter.track.stop();
    frameCounter = null;
  }
  localFrameSample = null;
}

function measureLocalCaptureFps() {
  ensureFrameCounter();
  if (!frameCounter) return null;
  const frames = frameCounter.count;
  const ts = performance.now();
  const prev = localFrameSample;
  localFrameSample = { frames, ts };
  if (!prev) return null;
  const df = frames - prev.frames;
  const dt = ts - prev.ts;
  if (df < 0 || dt <= 0) return null;
  return Math.round((df * 1000) / dt);
}

// Polls every connection's real send/receive stats and updates each tile's
// badge. For the local tile (we may be sending to several viewers at once)
// this picks one representative outbound stream — whichever currently has
// the most bytes sent, which naturally avoids a stale/ended sender left
// behind by a previous share session.
async function pollStats() {
  let bestOutbound = null;
  let bestOutboundReport = null; // the full getStats() map bestOutbound came from
  const inboundByPeer = new Map();

  for (const [peerId, pc] of peerConnections) {
    const statsReport = await pc.getStats();
    statsReport.forEach((report) => {
      if (report.type === 'outbound-rtp' && report.kind === 'video') {
        if (!bestOutbound || report.bytesSent > bestOutbound.bytesSent) {
          bestOutbound = report;
          bestOutboundReport = statsReport;
        }
      } else if (report.type === 'inbound-rtp' && report.kind === 'video') {
        inboundByPeer.set(peerId, report);
      }
    });
  }

  if (bestOutbound) {
    stopFrameCounter(); // RTP path reports real fps now — drop the frame-counter clone
    const codecName = bestOutboundReport.get(bestOutbound.codecId)?.mimeType?.split('/')[1];
    const reason = bestOutbound.qualityLimitationReason;
    let note = codecName ? ` · ${codecName}` : '';
    if (reason && reason !== 'none') note += ` · ⚠${reason}`; // 'cpu' or 'bandwidth'
    if (adaptLevel > 0) note += ` · adapt L${adaptLevel}`;
    applyStatsSample('local', bestOutbound, 'bytesSent', note);

    // React to the encoder's own limitation signal: back the resolution /
    // framerate down when it's sustained-limited, restore when it clears.
    if (updateAdaptation(reason)) updateEncodingParams();

    if (!encoderLogged && bestOutbound.encoderImplementation) {
      encoderLogged = true;
      console.log(`[stream] codec=${codecName} encoder=${bestOutbound.encoderImplementation} scale=${bestOutbound.scalabilityMode || viewerResolutionScale() + 'x'}`);
    }
  } else if (state.localStream) {
    // No viewer connected — no outbound RTP. Read resolution off the capture
    // track and the live framerate off the frame counter (nominal rate for
    // the first tick, before there's a delta to measure).
    const settings = state.localStream.getVideoTracks()[0]?.getSettings();
    if (settings?.width) {
      const liveFps = measureLocalCaptureFps();
      const fps = liveFps != null ? liveFps : Math.round(settings.frameRate || 0);
      updateTileStats('local', `${settings.width}×${settings.height} · ${fps}fps`);
    }
  } else {
    stopFrameCounter(); // not sharing — release the clone if one lingered
  }
  inboundByPeer.forEach((report, peerId) => applyStatsSample(peerId, report, 'bytesReceived'));
}

async function sendOffer(pc, peerId) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: peerId, data: { type: 'offer', sdp: offer } });
}

// HOST SIDE: open a connection to a peer and offer our screen stream
export async function callPeer(peerId) {
  if (!state.localStream) return;
  const pc = getOrCreatePeerConnection(peerId);
  state.localStream.getTracks().forEach((track) => {
    const sender = pc.addTrack(track, state.localStream);
    if (track.kind === 'video') {
      applyEncodingParams(sender);
      preferHardwareH264(pc, sender);
    }
  });
  await sendOffer(pc, peerId);
}

// Called when we stop sharing. Just calling track.stop() on our local
// stream (which share.js already does) only stops capture on our end — it
// doesn't tell the peer connection anything, so the remote side never
// learns the track is gone and its <video> just keeps showing the last
// decoded frame forever. Explicitly removing our senders and renegotiating
// is what actually signals "this track is gone" at the WebRTC level, and
// it also prevents dead senders from piling up on the same connection if
// we start sharing again later (addTrack would otherwise add a second,
// parallel m-line on top of the still-registered old one).
export function removeOutgoingTracks() {
  encoderLogged = false; // re-log codec/encoder on the next share
  resetAdaptation(); // next share starts unthrottled
  stopFrameCounter();
  peerConnections.forEach((pc, peerId) => {
    const activeSenders = pc.getSenders().filter((sender) => sender.track);
    if (activeSenders.length === 0) return;

    activeSenders.forEach((sender) => pc.removeTrack(sender));
    sendOffer(pc, peerId).catch((err) => console.error('Failed to renegotiate after stopping share:', err));
  });
}

// Wires the room-presence and WebRTC signaling events relayed by the server.
export function initPeerSignaling(theSocket) {
  socket = theSocket;
  setInterval(pollStats, 2000);

  // Peers already in the room when we joined. Deliberately silent (no
  // toasts) — this is a one-time dump of everyone already present, not
  // someone actively joining.
  socket.on('existing-peers', (peers) => {
    peers.forEach(({ id, username, sharing }) => {
      state.knownPeers.add(id);
      state.peerUsernames.set(id, username);
      if (sharing) state.sharingPeers.add(id);
    });
    if (state.isSharing) {
      Promise.all(peers.map(({ id }) => callPeer(id))).then(updateEncodingParams);
    }
    refreshParticipants();
  });

  // A peer joined after us — call them if we're already sharing, then
  // re-apply encoding params everywhere (the higher viewer count may lower
  // the sent resolution for every stream).
  socket.on('viewer-joined', ({ id, username }) => {
    state.knownPeers.add(id);
    state.peerUsernames.set(id, username);
    if (state.isSharing) callPeer(id).then(updateEncodingParams);
    showToast(`${username} entrou na sala`);
    refreshParticipants();
  });

  socket.on('peer-left', (peerId) => {
    const username = state.peerUsernames.get(peerId) || 'Alguém';
    state.knownPeers.delete(peerId);
    state.peerUsernames.delete(peerId);
    state.sharingPeers.delete(peerId);
    closePeerConnection(peerId);
    updateEncodingParams(); // fewer viewers — resolution can scale back up
    showToast(`${username} saiu da sala`);
    refreshParticipants();
  });

  // Someone else started or stopped sharing their screen. This is the
  // authoritative, immediate signal that a stop happened — we don't wait on
  // the renegotiation triggered by removeOutgoingTracks() (which the peer
  // who stopped sharing sends separately) since that's slower and, unlike
  // this app-level event, not guaranteed to arrive at all if something
  // goes wrong mid-renegotiation.
  socket.on('peer-share-status', ({ id, isSharing }) => {
    if (isSharing) {
      state.sharingPeers.add(id);
    } else {
      state.sharingPeers.delete(id);
      state.streams.delete(id);
      renderTiles();
      lastStatsSample.delete(id);
    }
    refreshParticipants();
  });

  // Handle incoming offer/answer/ICE-candidate messages relayed by the server
  socket.on('signal', async ({ from, data }) => {
    const pc = getOrCreatePeerConnection(from);

    if (data.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { type: 'answer', sdp: answer } });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === 'candidate') {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('Failed to add ICE candidate:', err);
      }
    }
  });
}
