const socket = io();

// STUN handles most NATs; TURN relays traffic when a direct connection
// can't be established (symmetric NATs, restrictive firewalls).
// Using the free Open Relay Project (metered.ca) — public demo credentials,
// no signup required. Swap for a private TURN provider or self-hosted
// coturn if you outgrow its shared bandwidth limits.
const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:openrelay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

const lobby = document.getElementById('lobby');
const appScreen = document.getElementById('appScreen');
const usernameInput = document.getElementById('usernameInput');
const roomCodeInput = document.getElementById('roomCodeInput');
const lobbyError = document.getElementById('lobbyError');
const enterBtn = document.getElementById('enterBtn');

const videosContainer = document.getElementById('videos');
const startBtn = document.getElementById('startShareBtn');
const resolutionSelect = document.getElementById('resolutionSelect');
const framerateSelect = document.getElementById('framerateSelect');
const statusText = document.getElementById('status');
const copyLinkBtn = document.getElementById('copyLinkBtn');

let localStream = null;
let isSharing = false;
let roomId = null;
let myUsername = null;
let hasEntered = false;
let currentRoomUrl = null;
const knownPeers = new Set(); // remote socket ids
const peerUsernames = new Map(); // socket id -> username
const peerConnections = new Map(); // socket id -> RTCPeerConnection
const tiles = new Map(); // tile key ('local' or socket id) -> tile <div>

function toggleFullscreen(video) {
  if (document.fullscreenElement === video) {
    document.exitFullscreen();
  } else {
    video.requestFullscreen();
  }
}

// One video tile per stream (your own preview plus one per remote streamer).
// Tiles always start muted — Chrome blocks unmuted autoplay without a prior
// user gesture, which a friend just opening the room link won't have given
// yet. Remote tiles get an Unmute button; the click itself is the gesture.
function addOrUpdateTile(key, stream, label, isLocal) {
  let tile = tiles.get(key);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile';

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.ondblclick = () => toggleFullscreen(video);

    const overlay = document.createElement('div');
    overlay.className = 'tile-overlay';

    const labelEl = document.createElement('span');
    labelEl.className = 'tile-label';

    const actions = document.createElement('div');
    actions.className = 'tile-actions';

    if (!isLocal) {
      const unmuteBtn = document.createElement('button');
      unmuteBtn.className = 'icon-btn';
      unmuteBtn.title = 'Unmute';
      unmuteBtn.textContent = '🔊';
      unmuteBtn.onclick = () => {
        video.muted = false;
        unmuteBtn.remove();
      };
      actions.appendChild(unmuteBtn);
    }

    const fullscreenBtn = document.createElement('button');
    fullscreenBtn.className = 'icon-btn';
    fullscreenBtn.title = 'Fullscreen';
    fullscreenBtn.textContent = '⛶';
    fullscreenBtn.onclick = () => toggleFullscreen(video);
    actions.appendChild(fullscreenBtn);

    overlay.appendChild(labelEl);
    overlay.appendChild(actions);
    tile.appendChild(video);
    tile.appendChild(overlay);

    videosContainer.appendChild(tile);
    tiles.set(key, tile);
  }

  tile.querySelector('video').srcObject = stream;
  tile.querySelector('.tile-label').textContent = label;
}

function removeTile(key) {
  const tile = tiles.get(key);
  if (tile) {
    tile.remove();
    tiles.delete(key);
  }
}

// Prefill the room code from a shared link, so a friend opening it only
// has to type a name.
const prefilledRoom = new URL(window.location.href).searchParams.get('room');
if (prefilledRoom) roomCodeInput.value = prefilledRoom;

function enterRoom() {
  const username = usernameInput.value.trim();
  if (!username) {
    lobbyError.textContent = 'Please enter a name.';
    return;
  }

  roomId = roomCodeInput.value.trim() || crypto.randomUUID().slice(0, 8);
  myUsername = username;
  hasEntered = true;

  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  window.history.replaceState({}, '', url);
  currentRoomUrl = url.href;

  lobby.style.display = 'none';
  appScreen.style.display = '';

  if (socket.connected) {
    socket.emit('join-room', { roomId, username: myUsername });
  }
}

enterBtn.addEventListener('click', enterRoom);
usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterRoom(); });
roomCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterRoom(); });

copyLinkBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(currentRoomUrl);
  const original = copyLinkBtn.textContent;
  copyLinkBtn.textContent = '✅ Copied!';
  setTimeout(() => { copyLinkBtn.textContent = original; }, 1500);
});

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
    const label = peerUsernames.get(peerId) || `Peer ${peerId.slice(0, 5)}`;
    addOrUpdateTile(peerId, event.streams[0], label, false /* isLocal */);
    statusText.innerText = 'Viewing remote screen(s).';

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

// HOST SIDE: open a connection to a peer and offer our screen stream
async function callPeer(peerId) {
  if (!localStream) return;
  const pc = getOrCreatePeerConnection(peerId);
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: peerId, data: { type: 'offer', sdp: offer } });
}

socket.on('connect', () => {
  statusText.innerText = 'Connected. Share the room link to invite others.';
  if (hasEntered) {
    socket.emit('join-room', { roomId, username: myUsername });
  }
});

// Peers already in the room when we joined
socket.on('existing-peers', (peers) => {
  peers.forEach(({ id, username }) => {
    knownPeers.add(id);
    peerUsernames.set(id, username);
  });
  if (isSharing) peers.forEach(({ id }) => callPeer(id));
});

// A peer joined after us — call them if we're already sharing
socket.on('viewer-joined', ({ id, username }) => {
  knownPeers.add(id);
  peerUsernames.set(id, username);
  if (isSharing) callPeer(id);
});

socket.on('peer-left', (peerId) => {
  knownPeers.delete(peerId);
  peerUsernames.delete(peerId);
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

// HOST SIDE: capture screen and call everyone in the room
startBtn.addEventListener('click', async () => {
  try {
    const framerate = Number(framerateSelect.value);
    const videoConstraints = { frameRate: { ideal: framerate, max: framerate } };

    if (resolutionSelect.value !== 'auto') {
      const [width, height] = resolutionSelect.value.split('x').map(Number);
      videoConstraints.width = { ideal: width };
      videoConstraints.height = { ideal: height };
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: true
    });

    localStream = stream;
    isSharing = true;
    addOrUpdateTile('local', stream, `You (${myUsername})`, true /* isLocal */);
    statusText.innerText = 'Sharing your screen...';

    // Call everyone already known in the room
    knownPeers.forEach(callPeer);

    // Handle user stopping stream via browser UI
    stream.getVideoTracks()[0].onended = () => {
      isSharing = false;
      localStream = null;
      removeTile('local');
      statusText.innerText = 'Screen sharing stopped.';
    };
  } catch (err) {
    console.error('Failed to capture screen:', err);
    statusText.innerText = 'Error capturing screen.';
  }
});
