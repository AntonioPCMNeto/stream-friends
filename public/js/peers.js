import { iceServers } from './iceServers.js';
import { state } from './state.js';
import { addOrUpdateTile, removeTile, updateTileStats } from './tiles.js';
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
    const label = state.peerUsernames.get(peerId) || `Usuário ${peerId.slice(0, 5)}`;
    addOrUpdateTile(peerId, event.streams[0], label, false /* isLocal */);

    event.track.onended = () => removeTile(peerId);
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
  removeTile(peerId);
}

// Tells the server (and, through it, everyone else in the room) whether
// we're currently sharing our screen.
export function announceSharingStatus(isSharing) {
  socket.emit('share-status', { isSharing });
}

export function closeAllPeerConnections() {
  Array.from(peerConnections.keys()).forEach(closePeerConnection);
}

// Caps a video sender's outgoing bitrate at state.videoBitrateKbps
// (falsy = no cap, let the browser/network decide).
function applyBitrateToSender(sender) {
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
  params.encodings[0].maxBitrate = state.videoBitrateKbps ? state.videoBitrateKbps * 1000 : undefined;
  sender.setParameters(params).catch((err) => console.error('Failed to set bitrate:', err));
}

// Re-applies the current bitrate setting to every active video sender —
// used when the user changes the bitrate control while already sharing.
export function updateBitrate() {
  peerConnections.forEach((pc) => {
    pc.getSenders().forEach((sender) => {
      if (sender.track && sender.track.kind === 'video') applyBitrateToSender(sender);
    });
  });
}

// Prefers H.264 over the other offered video codecs. Unlike VP8/VP9, H.264
// has near-universal hardware encode/decode support across GPUs (Intel
// QuickSync, NVENC, AMD VCE), which keeps CPU usage down — important here
// since Chrome runs one independent encoder per peer connection, so sharing
// to several viewers multiplies encode cost per viewer regardless of codec.
// Falls back silently where unsupported.
function preferH264(pc, sender) {
  const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
  if (!transceiver?.setCodecPreferences) return;
  const capabilities = RTCRtpSender.getCapabilities('video');
  if (!capabilities) return;
  const h264 = capabilities.codecs.filter((c) => c.mimeType === 'video/H264');
  const others = capabilities.codecs.filter((c) => c.mimeType !== 'video/H264');
  transceiver.setCodecPreferences([...h264, ...others]);
}

// key ('local' or a remote peer id) -> { bytes, ts } from the last sample,
// used to turn cumulative byte counters into an instantaneous kbps figure.
const lastStatsSample = new Map();

// Turns a getStats() report into a "1280x720 · 30fps · 850kbps" tile badge.
// The first sample for a key only seeds the baseline (no delta yet to show).
// A negative byte delta means the underlying sender/receiver changed between
// samples (e.g. share stopped and restarted) — skip that tick rather than
// show a bogus spike, and let the next sample re-seed cleanly.
function applyStatsSample(key, report, bytesField) {
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
  updateTileStats(key, `${report.frameWidth}×${report.frameHeight} · ${fps}fps · ${kbps}kbps`);
}

// Polls every connection's real send/receive stats and updates each tile's
// badge. For the local tile (we may be sending to several viewers at once)
// this picks one representative outbound stream — whichever currently has
// the most bytes sent, which naturally avoids a stale/ended sender left
// behind by a previous share session.
async function pollStats() {
  let bestOutbound = null;
  const inboundByPeer = new Map();

  for (const [peerId, pc] of peerConnections) {
    const statsReport = await pc.getStats();
    statsReport.forEach((report) => {
      if (report.type === 'outbound-rtp' && report.kind === 'video') {
        if (!bestOutbound || report.bytesSent > bestOutbound.bytesSent) bestOutbound = report;
      } else if (report.type === 'inbound-rtp' && report.kind === 'video') {
        inboundByPeer.set(peerId, report);
      }
    });
  }

  if (bestOutbound) applyStatsSample('local', bestOutbound, 'bytesSent');
  inboundByPeer.forEach((report, peerId) => applyStatsSample(peerId, report, 'bytesReceived'));
}

// HOST SIDE: open a connection to a peer and offer our screen stream
export async function callPeer(peerId) {
  if (!state.localStream) return;
  const pc = getOrCreatePeerConnection(peerId);
  state.localStream.getTracks().forEach((track) => {
    const sender = pc.addTrack(track, state.localStream);
    if (track.kind === 'video') {
      applyBitrateToSender(sender);
      preferH264(pc, sender);
    }
  });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: peerId, data: { type: 'offer', sdp: offer } });
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
    if (state.isSharing) peers.forEach(({ id }) => callPeer(id));
    refreshParticipants();
  });

  // A peer joined after us — call them if we're already sharing
  socket.on('viewer-joined', ({ id, username }) => {
    state.knownPeers.add(id);
    state.peerUsernames.set(id, username);
    if (state.isSharing) callPeer(id);
    showToast(`${username} entrou na sala`);
    refreshParticipants();
  });

  socket.on('peer-left', (peerId) => {
    const username = state.peerUsernames.get(peerId) || 'Alguém';
    state.knownPeers.delete(peerId);
    state.peerUsernames.delete(peerId);
    state.sharingPeers.delete(peerId);
    closePeerConnection(peerId);
    showToast(`${username} saiu da sala`);
    refreshParticipants();
  });

  // Someone else started or stopped sharing their screen.
  socket.on('peer-share-status', ({ id, isSharing }) => {
    if (isSharing) state.sharingPeers.add(id); else state.sharingPeers.delete(id);
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
