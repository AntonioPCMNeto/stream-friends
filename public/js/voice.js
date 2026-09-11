import { iceServers } from './iceServers.js';
import { state } from './state.js';
import { showToast } from './toast.js';
import { refreshParticipants } from './participants.js';

// Voice chat is a full mesh, unlike screen/webcam (one sender -> many
// viewers): every participant in voice holds one audio-only
// RTCPeerConnection to every other participant in voice. Fine for a handful
// of people — uplink and CPU grow linearly per participant, which is the
// wall that would eventually force an SFU, but far later than video would.
//
// Signaling piggybacks on the existing 'signal' / 'share-status' relays with
// purpose 'voice'. peers.js ignores that purpose (its PURPOSES guard), so
// the two meshes share one socket without colliding.

let socket = null;
const voicePcs = new Map();   // peerId -> RTCPeerConnection
const audioSinks = new Map(); // peerId -> detached autoplay <audio>

const joinBtn = document.getElementById('voiceJoinBtn');
const micSelect = document.getElementById('voiceMicSelect');
const muteBtn = document.getElementById('voiceMuteBtn');
const deafenBtn = document.getElementById('voiceDeafenBtn');
const leaveBtn = document.getElementById('voiceLeaveBtn');

// Restored when un-deafening: deafen forces mute, but un-deafening should
// leave you however you were before, not always unmuted.
let mutedBeforeDeafen = false;

// 'default' = whatever getUserMedia hands back unconstrained (the OS/browser
// default input) — not a real deviceId, just this module's own sentinel.
let currentMicDeviceId = 'default';
let micSwitchInFlight = false;

function setVoiceUI() {
  const inVoice = state.isInVoice;
  joinBtn.classList.toggle('hidden', inVoice);
  micSelect.classList.toggle('hidden', !inVoice);
  muteBtn.classList.toggle('hidden', !inVoice);
  deafenBtn.classList.toggle('hidden', !inVoice);
  leaveBtn.classList.toggle('hidden', !inVoice);

  // Colour is the whole signal — btn-danger when active — so the icon can
  // stay put instead of swapping to a hard-to-read "slashed" emoji.
  muteBtn.classList.toggle('btn-danger', state.isMuted);
  muteBtn.classList.toggle('btn-ghost', !state.isMuted);
  muteBtn.setAttribute('aria-pressed', String(state.isMuted));
  muteBtn.title = state.isMuted ? 'Ativar microfone' : 'Silenciar microfone';

  deafenBtn.classList.toggle('btn-danger', state.isDeafened);
  deafenBtn.classList.toggle('btn-ghost', !state.isDeafened);
  deafenBtn.setAttribute('aria-pressed', String(state.isDeafened));
  deafenBtn.title = state.isDeafened ? 'Desativar surdina' : 'Ensurdecer';
}

// track.enabled=false keeps the sender/PC up and just sends silence — no
// renegotiation, instant, cheap.
function applyMicEnabled() {
  const enabled = state.isInVoice && !state.isMuted && !state.isDeafened;
  state.micStream?.getAudioTracks().forEach((t) => { t.enabled = enabled; });
}

function applyDeafened() {
  audioSinks.forEach((audio) => { audio.muted = state.isDeafened; });
}

function peerLabel(peerId) {
  return state.peerUsernames.get(peerId) || `Usuário ${peerId.slice(0, 5)}`;
}

function createVoicePc(peerId) {
  const pc = new RTCPeerConnection({ iceServers });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { to: peerId, purpose: 'voice', data: { type: 'candidate', candidate: event.candidate } });
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      showToast(`Falha na conexão de áudio com ${peerLabel(peerId)}.`, 'error');
    }
  };

  pc.ontrack = (event) => {
    let audio = audioSinks.get(peerId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      audioSinks.set(peerId, audio);
    }
    audio.srcObject = event.streams[0] || new MediaStream([event.track]);
    audio.muted = state.isDeafened;
    audio.play().catch(() => {});
  };

  voicePcs.set(peerId, pc);
  return pc;
}

function addMicTrack(pc) {
  if (!state.micStream) return;
  if (pc.getSenders().some((s) => s.track && s.track.kind === 'audio')) return;
  state.micStream.getAudioTracks().forEach((t) => pc.addTrack(t, state.micStream));
}

// Glare-free: of any two peers, only the one with the lexicographically
// lower socket id sends the offer; the other builds its PC and waits for it.
async function connectToPeer(peerId) {
  if (!state.isInVoice || voicePcs.has(peerId)) return;
  const pc = createVoicePc(peerId);
  addMicTrack(pc);
  if (socket.id < peerId) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: peerId, purpose: 'voice', data: { type: 'offer', sdp: offer } });
    } catch (err) {
      console.error('Failed to create voice offer:', err);
    }
  }
}

function teardownPeer(peerId) {
  const pc = voicePcs.get(peerId);
  if (pc) { pc.close(); voicePcs.delete(peerId); }
  const audio = audioSinks.get(peerId);
  if (audio) { audio.srcObject = null; audioSinks.delete(peerId); }
}

function teardownAllPeers() {
  voicePcs.forEach((pc) => pc.close());
  voicePcs.clear();
  audioSinks.forEach((audio) => { audio.srcObject = null; });
  audioSinks.clear();
}

function captureMic(deviceId) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (deviceId && deviceId !== 'default') audio.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio });
}

// Device labels are blank until the mic permission has been granted at least
// once — fine here, since this only runs after joinVoice's own getUserMedia
// already prompted. Re-run on 'devicechange' (plug/unplug mid-call) and right
// after joining.
async function populateMicSelect() {
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  } catch { /* leave the list at just "Microfone padrão" */ }

  micSelect.innerHTML = '';
  micSelect.appendChild(new Option('Microfone padrão', 'default'));
  devices.forEach((d) => {
    if (!d.deviceId || d.deviceId === 'default') return; // browsers that list their own synthetic "default" entry
    micSelect.appendChild(new Option(d.label || `Entrada ${d.deviceId.slice(0, 6)}`, d.deviceId));
  });

  const validValues = Array.from(micSelect.options).map((o) => o.value);
  micSelect.value = validValues.includes(currentMicDeviceId) ? currentMicDeviceId : 'default';
}

// Hot-swaps the outgoing mic track on every live voice connection —
// replaceTrack, no renegotiation, same pattern as switchCamera() in share.js.
async function switchMicDevice(deviceId) {
  if (!state.isInVoice || micSwitchInFlight) return;
  micSwitchInFlight = true;
  const previous = state.micStream;

  try {
    const stream = await captureMic(deviceId);
    const track = stream.getAudioTracks()[0];
    track.enabled = !state.isMuted && !state.isDeafened;

    state.micStream = stream;
    currentMicDeviceId = deviceId;
    voicePcs.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      sender?.replaceTrack(track);
    });
    previous?.getTracks().forEach((t) => t.stop());
  } catch (err) {
    console.error('Failed to switch microphone:', err);
    showToast('Não foi possível trocar o microfone.', 'error');
    micSelect.value = currentMicDeviceId; // revert the dropdown to what's actually active
  } finally {
    micSwitchInFlight = false;
  }
}

async function joinVoice() {
  if (state.isInVoice) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('Microfone não é suportado neste navegador/dispositivo.', 'error');
    return;
  }

  let stream;
  try {
    currentMicDeviceId = 'default';
    stream = await captureMic('default');
  } catch (err) {
    console.error('Failed to capture microphone:', err);
    showToast(
      err.name === 'NotAllowedError'
        ? 'Permissão de microfone negada.'
        : 'Não foi possível acessar o microfone.',
      'error'
    );
    return;
  }

  state.micStream = stream;
  state.isInVoice = true;
  state.isMuted = false;
  state.isDeafened = false;
  applyMicEnabled();
  await populateMicSelect();
  setVoiceUI();
  refreshParticipants();
  showToast('Você entrou no áudio.');

  socket.emit('share-status', { purpose: 'voice', isSharing: true });
  state.voicePeers.forEach(connectToPeer);
}

function leaveVoice({ silent = false } = {}) {
  const wasInVoice = state.isInVoice;
  state.micStream?.getTracks().forEach((t) => t.stop());
  state.micStream = null;
  state.isInVoice = false;
  state.isMuted = false;
  state.isDeafened = false;
  currentMicDeviceId = 'default';
  teardownAllPeers();
  setVoiceUI();
  refreshParticipants();
  if (wasInVoice && !silent) {
    socket.emit('share-status', { purpose: 'voice', isSharing: false });
    showToast('Você saiu do áudio.');
  }
}

function toggleMute() {
  if (!state.isInVoice) return;
  state.isMuted = !state.isMuted;
  if (!state.isMuted && state.isDeafened) state.isDeafened = false; // unmuting lifts deafen, like Discord
  applyMicEnabled();
  applyDeafened();
  setVoiceUI();
}

function toggleDeafen() {
  if (!state.isInVoice) return;
  state.isDeafened = !state.isDeafened;
  if (state.isDeafened) {
    mutedBeforeDeafen = state.isMuted;
    state.isMuted = true; // can't talk to a room you can't hear
  } else {
    state.isMuted = mutedBeforeDeafen;
  }
  applyMicEnabled();
  applyDeafened();
  setVoiceUI();
}

// Called on leaving the room (lobby.js) — full silent teardown.
export function resetVoice() {
  leaveVoice({ silent: true });
}

export function initVoice(theSocket) {
  socket = theSocket;
  setVoiceUI();

  joinBtn.addEventListener('click', joinVoice);
  leaveBtn.addEventListener('click', () => leaveVoice());
  muteBtn.addEventListener('click', toggleMute);
  deafenBtn.addEventListener('click', toggleDeafen);
  micSelect.addEventListener('change', () => switchMicDevice(micSelect.value));

  // Mic plugged/unplugged mid-call — refresh the dropdown's options (not the
  // active device; switchMicDevice only runs on an explicit user pick).
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (state.isInVoice) populateMicSelect();
  });

  socket.on('existing-peers', (peers) => {
    state.voicePeers.clear();
    peers.forEach((p) => { if (p.sharing?.voice) state.voicePeers.add(p.id); });
    // A reconnect gave us a new socket id and killed the old mesh — rebuild
    // it if we were in voice (micStream survived the network blip).
    if (state.isInVoice) {
      socket.emit('share-status', { purpose: 'voice', isSharing: true });
      state.voicePeers.forEach(connectToPeer);
    }
    refreshParticipants();
  });

  socket.on('peer-share-status', ({ id, purpose, isSharing }) => {
    if (purpose !== 'voice') return;
    if (isSharing) {
      state.voicePeers.add(id);
      connectToPeer(id);
    } else {
      state.voicePeers.delete(id);
      teardownPeer(id);
    }
    refreshParticipants();
  });

  socket.on('peer-left', (peerId) => {
    state.voicePeers.delete(peerId);
    teardownPeer(peerId);
  });

  socket.on('disconnect', () => {
    // Keep micStream + isInVoice so existing-peers can rebuild on reconnect.
    teardownAllPeers();
  });

  socket.on('signal', async ({ from, purpose, data }) => {
    if (purpose !== 'voice' || !state.isInVoice) return;
    let pc = voicePcs.get(from);

    try {
      if (data.type === 'offer') {
        if (!pc) pc = createVoicePc(from);
        addMicTrack(pc);
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { to: from, purpose: 'voice', data: { type: 'answer', sdp: answer } });
      } else if (data.type === 'answer') {
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } else if (data.type === 'candidate') {
        if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (err) {
      console.error('Voice signaling error:', err);
    }
  });
}
