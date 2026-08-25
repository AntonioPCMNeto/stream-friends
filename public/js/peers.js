import { iceServers } from './iceServers.js';
import { state } from './state.js';
import { addOrUpdateTile, removeTile } from './tiles.js';

const statusText = document.getElementById('status');

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

  // RECEIVER SIDE: a remote track means someone is sending us their screen
  pc.ontrack = (event) => {
    const label = state.peerUsernames.get(peerId) || `Usuário ${peerId.slice(0, 5)}`;
    addOrUpdateTile(peerId, event.streams[0], label, false /* isLocal */);
    statusText.innerText = 'Visualizando tela(s) remota(s).';

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
  removeTile(peerId);
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

// HOST SIDE: open a connection to a peer and offer our screen stream
export async function callPeer(peerId) {
  if (!state.localStream) return;
  const pc = getOrCreatePeerConnection(peerId);
  state.localStream.getTracks().forEach((track) => {
    const sender = pc.addTrack(track, state.localStream);
    if (track.kind === 'video') applyBitrateToSender(sender);
  });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: peerId, data: { type: 'offer', sdp: offer } });
}

// Wires the room-presence and WebRTC signaling events relayed by the server.
export function initPeerSignaling(theSocket) {
  socket = theSocket;

  // Peers already in the room when we joined
  socket.on('existing-peers', (peers) => {
    peers.forEach(({ id, username }) => {
      state.knownPeers.add(id);
      state.peerUsernames.set(id, username);
    });
    if (state.isSharing) peers.forEach(({ id }) => callPeer(id));
  });

  // A peer joined after us — call them if we're already sharing
  socket.on('viewer-joined', ({ id, username }) => {
    state.knownPeers.add(id);
    state.peerUsernames.set(id, username);
    if (state.isSharing) callPeer(id);
  });

  socket.on('peer-left', (peerId) => {
    state.knownPeers.delete(peerId);
    state.peerUsernames.delete(peerId);
    closePeerConnection(peerId);
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
