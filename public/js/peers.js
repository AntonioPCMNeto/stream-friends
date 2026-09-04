import { iceServers } from './iceServers.js';
import { state } from './state.js';
import { renderTiles, updateTileStats } from './tiles.js';
import { showToast } from './toast.js';
import { refreshParticipants } from './participants.js';

const PURPOSES = ['screen', 'webcam'];

// Fixed encoding target for webcam sends — unlike screen sharing there's no
// quality panel for it (a facecam doesn't benefit from screen-share-grade
// resolution/bitrate controls), so these just need to be reasonable.
const WEBCAM_BITRATE_KBPS = 2500;
const WEBCAM_FRAMERATE_FPS = 30;

// Screen and webcam are sent over two independent RTCPeerConnections per
// peer (one per purpose), keyed by `${peerId}:${purpose}`. This keeps every
// connection carrying at most one video (+ optional audio) track, so the
// existing single-stream-per-kind logic below (senderForKind, encoding
// params, the hide toggle) needs no track-purpose disambiguation — at the
// cost of a second ICE/DTLS handshake (and, when relayed, a second TURN
// allocation) for peers sharing both at once.
const peerConnections = new Map(); // connKey -> RTCPeerConnection
let socket = null;

function connKey(peerId, purpose) {
  return `${peerId}:${purpose}`;
}
function peerIdOfKey(key) {
  return key.slice(0, key.lastIndexOf(':'));
}
function purposeOfKey(key) {
  return key.slice(key.lastIndexOf(':') + 1);
}
function localStreamFor(purpose) {
  return purpose === 'webcam' ? state.webcamStream : state.screenStream;
}

// HOST SIDE: viewers who used their "hide this stream" toggle. We keep their
// video sender but replaceTrack(null) it, so we stop encoding/uploading that
// stream to them entirely until they un-hide. Keyed same as peerConnections
// (per peer AND purpose) since a viewer can hide our webcam while still
// watching our screen, or vice versa. Survives source switches and
// re-offers; cleared when we stop that stream or the peer leaves.
const pausedViewers = new Set(); // connKey

// The sender carrying a given media kind on a connection. Matches on
// receiver.track too, since after replaceTrack(null) the sender's own track
// is null and no longer identifies it. Each connection here only ever
// carries one purpose, so matching by kind alone is unambiguous.
function senderForKind(pc, kind) {
  const tx = pc?.getTransceivers().find(
    (t) => ((t.sender.track || t.receiver.track)?.kind) === kind
  );
  return tx?.sender || null;
}

function getOrCreatePeerConnection(peerId, purpose) {
  const key = connKey(peerId, purpose);
  let pc = peerConnections.get(key);
  if (pc) return pc;

  pc = new RTCPeerConnection({ iceServers });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { to: peerId, purpose, data: { type: 'candidate', candidate: event.candidate } });
    }
  };

  // 'disconnected' is often transient (brief network hiccup, ICE re-checks
  // on its own) — only 'failed' is terminal enough to be worth surfacing.
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      const label = state.peerUsernames.get(peerId) || `Usuário ${peerId.slice(0, 5)}`;
      const purposeLabel = purpose === 'webcam' ? 'webcam' : 'tela';
      showToast(`Falha na conexão de ${purposeLabel} com ${label}.`, 'error');
    }
  };

  // RECEIVER SIDE: a remote track means someone is sending us this stream.
  // Merge every track from this connection into one MediaStream we own,
  // keyed by connKey, rather than trusting event.streams[0] — a track added
  // by a later renegotiation (e.g. the sharer's source switch adds an audio
  // track) comes in under a different stream id and would otherwise orphan
  // the video tile.
  pc.ontrack = (event) => {
    let stream = state.streams.get(key);
    if (!stream) {
      stream = new MediaStream();
      state.streams.set(key, stream);
    }
    if (!stream.getTrackById(event.track.id)) stream.addTrack(event.track);
    renderTiles();

    // Only the video track ending means the stream is gone — an audio track
    // stopping on its own shouldn't drop the tile. (In practice the
    // authoritative signal is 'peer-share-status'; this is the fallback.)
    if (event.track.kind === 'video') {
      event.track.onended = () => {
        state.streams.delete(key);
        renderTiles();
      };
    }
  };

  peerConnections.set(key, pc);
  return pc;
}

function closePeerConnection(peerId, purpose) {
  const key = connKey(peerId, purpose);
  const pc = peerConnections.get(key);
  if (pc) {
    pc.close();
    peerConnections.delete(key);
  }
  pausedViewers.delete(key);
  lastStatsSample.delete(key);
  state.streams.delete(key);
  renderTiles();
}

function closeConnectionsForPeer(peerId) {
  PURPOSES.forEach((purpose) => closePeerConnection(peerId, purpose));
}

// Tells the server (and, through it, everyone else in the room) whether
// we're currently sending a given stream (screen or webcam).
export function announceSharingStatus(purpose, isSharing) {
  socket.emit('share-status', { purpose, isSharing });
}

// VIEWER SIDE: ask one sharer to start or stop sending us a given stream
// (the per-tile "hide this stream" toggle). They stop encoding it for us
// entirely while hidden — see the 'watch-status' handler in
// initPeerSignaling.
export function setWatching(peerId, purpose, watching) {
  socket.emit('watch-status', { to: peerId, purpose, watching });
}

export function closeAllPeerConnections() {
  const peerIds = new Set(Array.from(peerConnections.keys()).map(peerIdOfKey));
  peerIds.forEach(closeConnectionsForPeer);
}

// Configures a video sender. The sent resolution is exactly what was
// captured (`scaleResolutionDownBy = 1`) — no proactive downscaling, so the
// picture doesn't silently shrink when another viewer joins. Under genuine
// encoder overload 'maintain-framerate' still lets WebRTC shed resolution,
// but only then, and it sheds resolution rather than frames: screen content
// (games, video, scrolling) is motion-heavy, so a steady framerate reads as
// smoother than a sharper but stuttering picture. For screen, maxFramerate /
// maxBitrate are the user's share-panel choices (falsy bitrate = no cap);
// webcam has no panel and always uses the fixed defaults above.
function applyEncodingParams(sender, purpose) {
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
  const enc = params.encodings[0];
  const bitrateKbps = purpose === 'webcam' ? WEBCAM_BITRATE_KBPS : state.videoBitrateKbps;
  const framerateFps = purpose === 'webcam' ? WEBCAM_FRAMERATE_FPS : state.videoFramerateFps;
  enc.maxBitrate = bitrateKbps ? bitrateKbps * 1000 : undefined;
  enc.maxFramerate = framerateFps || undefined;
  enc.scaleResolutionDownBy = 1;
  enc.networkPriority = 'high';
  enc.priority = 'high';
  params.degradationPreference = 'maintain-framerate';
  sender.setParameters(params).catch((err) => console.error('Failed to set encoding params:', err));
}

// Re-applies the current bitrate/framerate settings to every active video
// sender for one purpose — used when the user changes a share-panel control
// while already sharing (screen only; webcam has no such controls).
export function updateEncodingParams(purpose) {
  peerConnections.forEach((pc, key) => {
    if (purposeOfKey(key) !== purpose) return;
    pc.getSenders().forEach((sender) => {
      if (sender.track && sender.track.kind === 'video') applyEncodingParams(sender, purpose);
    });
  });
}

// Reorders the offered video codecs so a hardware-friendly H.264 variant is
// negotiated first. H.264 has near-universal hardware encode/decode (Intel
// QuickSync, NVENC, AMD VCE); Chrome runs one encoder per outgoing track, so
// a software codec (VP8/VP9/AV1) multiplies CPU per track while a hardware
// one stays roughly flat. Within H.264 we rank packetization-mode=1 and
// Constrained Baseline (profile-level-id 42e01f / 42001f) highest — that's
// the profile every hardware encoder implements, so it's least likely to
// silently fall back to the software encoder. No-op (keeps the default
// order) where H.264 isn't offered at all.
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

// key (`local:${purpose}` or a connKey) -> { bytes, ts } from the last
// sample, used to turn cumulative byte counters into an instantaneous kbps
// figure.
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

// Pulls the active ICE path off a getStats() map: whether media is going
// direct or **relayed through a TURN server** (the free Open Relay one in
// iceServers.js is shared and bandwidth-throttled — a relayed path caps
// throughput hard regardless of the user's real uplink), plus WebRTC's own
// send-bandwidth estimate and the round-trip time.
function activePathInfo(statsMap) {
  let pair = null;
  statsMap.forEach((r) => {
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
  });
  if (!pair) return null;
  const local = statsMap.get(pair.localCandidateId);
  const remote = statsMap.get(pair.remoteCandidateId);
  const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
  return {
    relayed,
    kind: relayed ? `relay(${local?.relayProtocol || '?'})` : `${local?.candidateType || '?'}/${remote?.candidateType || '?'}`,
    abrKbps: pair.availableOutgoingBitrate ? Math.round(pair.availableOutgoingBitrate / 1000) : null,
    rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
  };
}

// Stream diagnostics, tracked independently per purpose. `streamUpLogged`
// fires one line the first time an outbound encode for that purpose
// appears (codec, encoder, ICE path). `lastLimitLog` then drives a line
// whenever that encoder's quality-limitation state changes and every ~10s
// it persists, plus once when it clears — so a single console line answers
// whether a framerate/resolution drop is cpu, bandwidth (and if so, a
// throttled TURN relay vs a genuinely thin uplink), or just static content.
// Reset when that purpose's share stops.
const streamUpLogged = { screen: false, webcam: false };
const lastLimitLog = {
  screen: { reason: 'none', at: 0 },
  webcam: { reason: 'none', at: 0 },
};

function countConnectionsForPurpose(purpose) {
  let count = 0;
  peerConnections.forEach((_, key) => { if (purposeOfKey(key) === purpose) count++; });
  return count;
}

function logStreamDiag(purpose, report, codecName, path) {
  if (!report.frameWidth) return; // stats snapshot arrived before the encoder populated resolution
  const reason = report.qualityLimitationReason || 'none';
  const now = performance.now();
  const last = lastLimitLog[purpose];
  const changed = reason !== last.reason;
  const persisted = reason !== 'none' && now - last.at > 10000;
  if (!changed && !persisted) return;
  lastLimitLog[purpose] = { reason, at: now };

  const fps = Math.round(report.framesPerSecond || 0);
  const msPerFrame = report.framesEncoded && report.totalEncodeTime
    ? (report.totalEncodeTime * 1000 / report.framesEncoded).toFixed(1)
    : '?';
  const targetKbps = report.targetBitrate ? Math.round(report.targetBitrate / 1000) : '?';
  const pathStr = path
    ? `path=${path.kind} estBW=${path.abrKbps ?? '?'}kbps rtt=${path.rttMs ?? '?'}ms`
    : 'path=?';
  console.log(
    `[stream:${purpose}] ${report.frameWidth}x${report.frameHeight} ${fps}fps limit=${reason} ` +
    `encode=${msPerFrame}ms/frame target=${targetKbps}kbps ${pathStr} codec=${codecName} ` +
    `encoder=${report.encoderImplementation || '?'} viewers=${countConnectionsForPurpose(purpose)}`
  );
}

// Live capture-framerate measurement for a solo-sharer tile (no viewer =
// no outbound RTP to read framesPerSecond from), tracked independently per
// purpose since screen and webcam can each be un-viewed at different times.
// Counts frames straight off a clone of the capture track via
// MediaStreamTrackProcessor — unlike a <video> element's frame counter,
// this keeps running at the true capture rate even when the tab/window is
// backgrounded and rendering is throttled. Screen capture is content-driven,
// so it reads well below the nominal rate on a static screen — the honest
// number. Chromium-only; elsewhere the badge falls back to the track's
// nominal frameRate.
const frameCounters = { screen: null, webcam: null }; // { track (clone), reader, count, source (original) }
const localFrameSamples = { screen: null, webcam: null }; // { frames, ts }

function ensureFrameCounter(purpose) {
  const source = localStreamFor(purpose)?.getVideoTracks()[0];
  if (!source) return stopFrameCounter(purpose);
  if (frameCounters[purpose]?.source === source) return;
  stopFrameCounter(purpose);
  if (typeof MediaStreamTrackProcessor === 'undefined') return;

  try {
    const track = source.clone();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const fc = { track, reader, count: 0, source };
    frameCounters[purpose] = fc;
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

function stopFrameCounter(purpose) {
  const fc = frameCounters[purpose];
  if (fc) {
    fc.reader.cancel().catch(() => {});
    fc.track.stop();
    frameCounters[purpose] = null;
  }
  localFrameSamples[purpose] = null;
}

function measureLocalCaptureFps(purpose) {
  ensureFrameCounter(purpose);
  const fc = frameCounters[purpose];
  if (!fc) return null;
  const frames = fc.count;
  const ts = performance.now();
  const prev = localFrameSamples[purpose];
  localFrameSamples[purpose] = { frames, ts };
  if (!prev) return null;
  const df = frames - prev.frames;
  const dt = ts - prev.ts;
  if (df < 0 || dt <= 0) return null;
  return Math.round((df * 1000) / dt);
}

// Polls every connection's real send/receive stats and updates each tile's
// badge, per purpose. For each purpose we may be sending to several viewers
// at once — this picks one representative outbound stream per purpose
// (whichever currently has the most bytes sent), which naturally avoids a
// stale/ended sender left behind by a previous share session.
async function pollStats() {
  const bestOutbound = { screen: null, webcam: null };
  const bestOutboundReport = { screen: null, webcam: null }; // the full getStats() map bestOutbound came from
  const inboundByKey = new Map();

  // Fetched concurrently — each pc.getStats() round trip is independent, so
  // awaiting them one at a time only added up latency without buying
  // anything (the shared bestOutbound/bestOutboundReport objects are only
  // mutated inside each report's own synchronous forEach, so concurrent
  // resolution order can't race). Matters most for a host with several
  // viewer connections, where this was serializing N stats fetches every tick.
  await Promise.all(Array.from(peerConnections, async ([key, pc]) => {
    const purpose = purposeOfKey(key);
    const statsReport = await pc.getStats();
    statsReport.forEach((report) => {
      if (report.type === 'outbound-rtp' && report.kind === 'video') {
        if (!bestOutbound[purpose] || report.bytesSent > bestOutbound[purpose].bytesSent) {
          bestOutbound[purpose] = report;
          bestOutboundReport[purpose] = statsReport;
        }
      } else if (report.type === 'inbound-rtp' && report.kind === 'video') {
        inboundByKey.set(key, report);
      }
    });
  }));

  for (const purpose of PURPOSES) {
    const outbound = bestOutbound[purpose];
    if (outbound) {
      stopFrameCounter(purpose); // RTP path reports real fps now — drop the frame-counter clone
      const report = bestOutboundReport[purpose];
      const codecName = report.get(outbound.codecId)?.mimeType?.split('/')[1];
      const reason = outbound.qualityLimitationReason;
      const path = activePathInfo(report);
      let note = codecName ? ` · ${codecName}` : '';
      if (reason && reason !== 'none') note += ` · ⚠${reason}`; // 'cpu' or 'bandwidth'
      if (path?.relayed) note += ' · relay';
      applyStatsSample(`local:${purpose}`, outbound, 'bytesSent', note);

      if (!streamUpLogged[purpose] && outbound.encoderImplementation && outbound.frameWidth) {
        streamUpLogged[purpose] = true;
        console.log(`[stream:${purpose}] up: ${outbound.frameWidth}x${outbound.frameHeight} codec=${codecName} encoder=${outbound.encoderImplementation} path=${path?.kind || '?'} viewers=${countConnectionsForPurpose(purpose)}`);
      }
      logStreamDiag(purpose, outbound, codecName, path);
    } else if (localStreamFor(purpose)) {
      // No viewer connected for this purpose — no outbound RTP. Read
      // resolution off the capture track and the live framerate off the
      // frame counter (nominal rate for the first tick, before there's a
      // delta to measure).
      const settings = localStreamFor(purpose).getVideoTracks()[0]?.getSettings();
      if (settings?.width) {
        const liveFps = measureLocalCaptureFps(purpose);
        const fps = liveFps != null ? liveFps : Math.round(settings.frameRate || 0);
        updateTileStats(`local:${purpose}`, `${settings.width}×${settings.height} · ${fps}fps`);
      }
    } else {
      stopFrameCounter(purpose); // not sharing this purpose — release the clone if one lingered
    }
  }
  inboundByKey.forEach((report, key) => applyStatsSample(key, report, 'bytesReceived'));
}

async function sendOffer(pc, peerId, purpose) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: peerId, purpose, data: { type: 'offer', sdp: offer } });
}

// HOST SIDE: open a connection to a peer and offer one of our streams
// (screen or webcam).
export async function callPeer(peerId, purpose) {
  const stream = localStreamFor(purpose);
  if (!stream) return;
  const key = connKey(peerId, purpose);
  const pc = getOrCreatePeerConnection(peerId, purpose);
  stream.getTracks().forEach((track) => {
    const sender = pc.addTrack(track, stream);
    if (track.kind === 'video') {
      applyEncodingParams(sender, purpose);
      preferHardwareH264(pc, sender);
    }
  });
  // Peer hid this stream before we (re)connected — offer the m-line but
  // send no video until they un-hide.
  if (pausedViewers.has(key)) {
    await senderForKind(pc, 'video')?.replaceTrack(null);
  }
  await sendOffer(pc, peerId, purpose);
}

// HOST SIDE: swap the shared screen source (window/tab/monitor) on every
// live viewer connection for that purpose, without tearing anything down.
// sender.replaceTrack() changes the media in place — no offer/answer — so
// viewers just see the picture change. A renegotiation only happens in the
// uncommon case where the new source adds or drops an audio track relative
// to the old one. (Only screen sharing offers source switching today.)
export async function replaceOutgoingStream(purpose, newStream) {
  const next = {
    video: newStream.getVideoTracks()[0] || null,
    audio: newStream.getAudioTracks()[0] || null,
  };

  const entries = Array.from(peerConnections.entries()).filter(([key]) => purposeOfKey(key) === purpose);

  await Promise.all(
    entries.map(async ([key, pc]) => {
      const peerId = peerIdOfKey(key);
      let renegotiate = false;

      for (const kind of ['video', 'audio']) {
        // A viewer who hid this stream still gets the new m-line but no video.
        const track = kind === 'video' && pausedViewers.has(key) ? null : next[kind];
        const sender = senderForKind(pc, kind);
        if (sender) {
          await sender.replaceTrack(track); // null is valid — stops that kind
          if (kind === 'video' && track) applyEncodingParams(sender, purpose);
        } else if (track) {
          const added = pc.addTrack(track, newStream);
          if (kind === 'video') {
            applyEncodingParams(added, purpose);
            preferHardwareH264(pc, added);
          }
          renegotiate = true;
        }
      }

      if (renegotiate) await sendOffer(pc, peerId, purpose);
    })
  );
}

// Called when we stop sending a given stream (screen or webcam). Just
// calling track.stop() on the local stream (which share.js already does)
// only stops capture on our end — it doesn't tell the peer connection
// anything, so the remote side never learns the track is gone and its
// <video> just keeps showing the last decoded frame forever. Explicitly
// removing our senders and renegotiating is what actually signals "this
// track is gone" at the WebRTC level, and it also prevents dead senders
// from piling up on the same connection if we start that stream again
// later (addTrack would otherwise add a second, parallel m-line on top of
// the still-registered old one).
export function removeOutgoingTracks(purpose) {
  streamUpLogged[purpose] = false; // re-log codec/encoder on the next share
  lastLimitLog[purpose] = { reason: 'none', at: 0 };
  stopFrameCounter(purpose);
  // A fresh share of this purpose is visible to everyone again.
  Array.from(pausedViewers).forEach((key) => {
    if (purposeOfKey(key) === purpose) pausedViewers.delete(key);
  });
  peerConnections.forEach((pc, key) => {
    if (purposeOfKey(key) !== purpose) return;
    const peerId = peerIdOfKey(key);
    const activeSenders = pc.getSenders().filter((sender) => sender.track);
    if (activeSenders.length === 0) return;

    activeSenders.forEach((sender) => pc.removeTrack(sender));
    sendOffer(pc, peerId, purpose).catch((err) => console.error(`Failed to renegotiate after stopping ${purpose} share:`, err));
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
      const purposes = new Set(PURPOSES.filter((p) => sharing?.[p]));
      if (purposes.size > 0) state.sharingPeers.set(id, purposes);
    });
    peers.forEach(({ id }) => {
      if (state.isSharingScreen) callPeer(id, 'screen');
      if (state.isSharingWebcam) callPeer(id, 'webcam');
    });
    refreshParticipants();
  });

  // A peer joined after us — open a connection and offer whichever of our
  // streams (screen/webcam) are currently active. Encoding params are the
  // same regardless of viewer count, so callPeer configuring the new
  // sender is all that's needed.
  socket.on('viewer-joined', ({ id, username }) => {
    state.knownPeers.add(id);
    state.peerUsernames.set(id, username);
    if (state.isSharingScreen) callPeer(id, 'screen');
    if (state.isSharingWebcam) callPeer(id, 'webcam');
    showToast(`${username} entrou na sala`);
    refreshParticipants();
  });

  socket.on('peer-left', (peerId) => {
    const username = state.peerUsernames.get(peerId) || 'Alguém';
    state.knownPeers.delete(peerId);
    state.peerUsernames.delete(peerId);
    state.sharingPeers.delete(peerId);
    closeConnectionsForPeer(peerId);
    showToast(`${username} saiu da sala`);
    refreshParticipants();
  });

  // Someone else started or stopped sending a stream. This is the
  // authoritative, immediate signal that a stop happened — we don't wait on
  // the renegotiation triggered by removeOutgoingTracks() (which the peer
  // who stopped sends separately) since that's slower and, unlike this
  // app-level event, not guaranteed to arrive at all if something goes
  // wrong mid-renegotiation.
  socket.on('peer-share-status', ({ id, purpose, isSharing }) => {
    const purposes = state.sharingPeers.get(id) || new Set();
    if (isSharing) {
      purposes.add(purpose);
      state.sharingPeers.set(id, purposes);
    } else {
      purposes.delete(purpose);
      if (purposes.size === 0) state.sharingPeers.delete(id); else state.sharingPeers.set(id, purposes);
      const key = connKey(id, purpose);
      state.streams.delete(key);
      renderTiles();
      lastStatsSample.delete(key);
    }
    refreshParticipants();
  });

  // HOST SIDE: a viewer hid (watching:false) or un-hid (watching:true) one
  // of our streams. Drop / restore the video track on just that connection
  // — no renegotiation, and while hidden the encoder has nothing to do for
  // them.
  socket.on('watch-status', ({ from, purpose, watching }) => {
    const key = connKey(from, purpose);
    if (watching) pausedViewers.delete(key);
    else pausedViewers.add(key);

    const sender = senderForKind(peerConnections.get(key), 'video');
    if (!sender) return; // not connected yet — callPeer() will honor pausedViewers
    const want = watching ? localStreamFor(purpose)?.getVideoTracks()[0] || null : null;
    if ((sender.track || null) !== want) sender.replaceTrack(want).catch(() => {});
  });

  // Handle incoming offer/answer/ICE-candidate messages relayed by the
  // server, routed to the connection for the signaled purpose.
  socket.on('signal', async ({ from, purpose, data }) => {
    const pc = getOrCreatePeerConnection(from, purpose);

    if (data.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, purpose, data: { type: 'answer', sdp: answer } });
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
