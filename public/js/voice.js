import { iceServers } from './iceServers.js';
import { state } from './state.js';
import { showToast } from './toast.js';
import { playJoinSound, playLeaveSound } from './sounds.js';
import { refreshParticipants, setSpeaking } from './participants.js';

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

// Speaking indicator: one AnalyserNode per live audio stream ('local' plus
// one per remote peer), polled on a shared interval. A disabled track (muted
// mic) outputs silence to every consumer including this analyser, so mute
// suppresses the indicator for free — no extra check needed.
const SPEAKING_THRESHOLD = 0.02; // RMS of time-domain samples, tuned by ear
const SPEAKING_POLL_MS = 150;
let audioCtx = null;
const analysers = new Map(); // id -> { source, analyser, data, speaking }
let monitorHandle = null;

function ensureAudioCtx() {
  // RNNoise (below) is built assuming 48kHz frames — most browsers default
  // there anyway, but this makes it explicit instead of hoping the system
  // default matches. Web Audio resamples from the actual hardware rate as
  // needed, so this doesn't require the audio device itself to run at 48kHz.
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  audioCtx.resume().catch(() => {});
  return audioCtx;
}

// RNNoise (ML-based, real spectral denoising — suppresses noise mixed INTO
// your voice while you're talking, not just between words) via
// @sapphi-red/web-noise-suppressor, vendored under /vendor since this app
// has no bundler to pull an npm package through. Replaces an earlier
// track-enabled/disabled "noise gate" approach: that only muted between
// words and, at any hangover short enough to not be annoying, ended up
// clipping the start of words after a natural speech pause — a structural
// problem with any hard gate, not a tuning issue. Continuous suppression
// doesn't have that failure mode at all.
// Relative to this module, not the site root, so it also resolves under the
// Electron build's file:// origin.
const RNNOISE_BASE = new URL('../vendor/web-noise-suppressor', import.meta.url).href;
let rnnoiseModulePromise = null;
let rnnoiseWasmBinaryPromise = null;
let rnnoiseWorkletModuleLoaded = false;

function loadRnnoiseModule() {
  if (!rnnoiseModulePromise) rnnoiseModulePromise = import(`${RNNOISE_BASE}/index.js`);
  return rnnoiseModulePromise;
}

// The processing graph for the CURRENT raw mic capture — rebuilt on every
// join/leave/device switch, since it's wired to one specific raw stream.
let noiseSuppressionGraph = null; // { rawStream, sourceNode, workletNode, destNode }

// Inserts RNNoise between the raw captured mic and everything else (the
// speaking-ring/analyser, and whatever's sent to peers) — the processed
// stream becomes the new state.micStream, so the rest of this module never
// needs to know suppression is happening. Falls back to the raw stream
// untouched (still has the browser's own noiseSuppression from captureMic)
// if AudioWorklet or the WASM module is unavailable, rather than failing
// voice chat entirely over a denoiser that couldn't load.
async function applyNoiseSuppression(rawStream) {
  try {
    const ctx = ensureAudioCtx();
    const { RnnoiseWorkletNode, loadRnnoise } = await loadRnnoiseModule();

    if (!rnnoiseWorkletModuleLoaded) {
      await ctx.audioWorklet.addModule(`${RNNOISE_BASE}/rnnoiseWorklet.js`);
      rnnoiseWorkletModuleLoaded = true;
    }
    if (!rnnoiseWasmBinaryPromise) {
      rnnoiseWasmBinaryPromise = loadRnnoise({
        url: `${RNNOISE_BASE}/rnnoise.wasm`,
        simdUrl: `${RNNOISE_BASE}/rnnoise_simd.wasm`,
      });
    }
    const wasmBinary = await rnnoiseWasmBinaryPromise;

    const sourceNode = ctx.createMediaStreamSource(rawStream);
    const workletNode = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    const destNode = ctx.createMediaStreamDestination();
    sourceNode.connect(workletNode).connect(destNode);

    noiseSuppressionGraph = { rawStream, sourceNode, workletNode, destNode };
    return destNode.stream;
  } catch (err) {
    console.error('RNNoise unavailable, falling back to unprocessed mic:', err);
    // No graph actually got installed for this stream — make sure a stale
    // reference from a previous (successful) capture doesn't linger and get
    // torn down as if it still belonged to what's now state.micStream.
    noiseSuppressionGraph = null;
    return rawStream;
  }
}

function teardownGraph(graph) {
  if (!graph) return;
  graph.sourceNode.disconnect();
  graph.workletNode.disconnect();
  graph.workletNode.destroy();
  graph.rawStream.getTracks().forEach((t) => t.stop());
}

function teardownNoiseSuppression() {
  teardownGraph(noiseSuppressionGraph);
  noiseSuppressionGraph = null;
}

// captureMic() + applyNoiseSuppression() in one step — what joinVoice and
// switchMicDevice actually call. Keeps the raw getUserMedia call separate
// from the graph-building since the fallback-to-'default'-device retry in
// joinVoice needs the raw capture to potentially fail and be retried before
// any processing graph exists.
async function captureProcessedMic(deviceId) {
  const rawStream = await captureMic(deviceId);
  return applyNoiseSuppression(rawStream);
}

function startMonitorLoop() {
  if (monitorHandle) return;
  monitorHandle = setInterval(() => {
    analysers.forEach((entry, id) => {
      entry.analyser.getByteTimeDomainData(entry.data);
      let sumSquares = 0;
      for (let i = 0; i < entry.data.length; i++) {
        const v = (entry.data[i] - 128) / 128;
        sumSquares += v * v;
      }
      const isSpeaking = Math.sqrt(sumSquares / entry.data.length) > SPEAKING_THRESHOLD;
      if (isSpeaking !== entry.speaking) {
        entry.speaking = isSpeaking;
        setSpeaking(id, isSpeaking);
      }
    });
  }, SPEAKING_POLL_MS);
}

function stopMonitorLoop() {
  clearInterval(monitorHandle);
  monitorHandle = null;
}

function attachAnalyser(id, stream) {
  if (!stream || !stream.getAudioTracks().length || analysers.has(id)) return;
  const ctx = ensureAudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);
  analysers.set(id, { source, analyser, data: new Uint8Array(analyser.frequencyBinCount), speaking: false });
  startMonitorLoop();
}

function detachAnalyser(id) {
  const entry = analysers.get(id);
  if (!entry) return;
  entry.source.disconnect();
  analysers.delete(id);
  if (entry.speaking) setSpeaking(id, false);
  if (analysers.size === 0) stopMonitorLoop();
}

// Temporary field diagnostic for the "I don't see the speaking ring"
// report — run `(await import('/js/voice.js')).debugVoiceState()` from the
// console while talking. Not wired into any UI; safe to leave in, but meant
// to come back out once this is root-caused.
export function debugVoiceState() {
  const local = analysers.get('local');
  let rms = null;
  if (local) {
    local.analyser.getByteTimeDomainData(local.data);
    let sumSquares = 0;
    for (let i = 0; i < local.data.length; i++) {
      const v = (local.data[i] - 128) / 128;
      sumSquares += v * v;
    }
    rms = Math.sqrt(sumSquares / local.data.length);
  }
  return {
    isInVoice: state.isInVoice,
    isMuted: state.isMuted,
    isDeafened: state.isDeafened,
    hasMicStream: Boolean(state.micStream),
    micTrackReadyState: state.micStream?.getAudioTracks()[0]?.readyState,
    micTrackEnabled: state.micStream?.getAudioTracks()[0]?.enabled,
    audioCtxState: audioCtx?.state,
    audioCtxSampleRate: audioCtx?.sampleRate,
    hasLocalAnalyser: Boolean(local),
    currentLocalRms: rms,
    speakingThreshold: SPEAKING_THRESHOLD,
    rnnoiseActive: Boolean(noiseSuppressionGraph),
  };
}

const joinBtn = document.getElementById('voiceJoinBtn');
const activeControls = document.getElementById('voiceActiveControls');
const connectedBar = document.getElementById('voiceConnectedBar');
const micSelect = document.getElementById('voiceMicSelect');
const speakerRow = document.getElementById('userBarSpeakerRow');
const speakerSelect = document.getElementById('voiceSpeakerSelect');
const muteBtn = document.getElementById('voiceMuteBtn');
const deafenBtn = document.getElementById('voiceDeafenBtn');
const leaveBtn = document.getElementById('voiceLeaveBtn');
const statusEl = document.getElementById('userBarStatus');
const settingsBtn = document.getElementById('userBarSettingsBtn');
const settingsPopover = document.getElementById('userBarPopover');

// Restored when un-deafening: deafen forces mute, but un-deafening should
// leave you however you were before, not always unmuted.
let mutedBeforeDeafen = false;

// Remembered across sessions (Discord-style "default input/output device"),
// not just for the lifetime of one voice call — see loadDevicePref below.
const MIC_PREF_KEY = 'scrimaAi.micDeviceId';
const SPEAKER_PREF_KEY = 'scrimaAi.speakerDeviceId';

// 'default' = whatever getUserMedia/the sink hands back unconstrained (the
// OS/browser default) — not a real deviceId, just this module's own sentinel.
function loadDevicePref(key) {
  try { return localStorage.getItem(key) || 'default'; } catch { return 'default'; }
}
function saveDevicePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* best-effort only */ }
}

let currentMicDeviceId = loadDevicePref(MIC_PREF_KEY);
let currentSpeakerDeviceId = loadDevicePref(SPEAKER_PREF_KEY);
let micSwitchInFlight = false;

// setSinkId (choosing which speaker/headset voice plays out of) is
// Chrome/Edge-only — Firefox and Safari have no equivalent API. The row is
// hidden entirely rather than shown-but-broken when it's not supported.
const SPEAKER_SELECTION_SUPPORTED = typeof HTMLMediaElement !== 'undefined'
  && typeof HTMLMediaElement.prototype.setSinkId === 'function';

function setVoiceUI() {
  const inVoice = state.isInVoice;
  joinBtn.classList.toggle('hidden', inVoice);
  activeControls.classList.toggle('hidden', !inVoice);
  connectedBar.classList.toggle('hidden', !inVoice);

  // Discord's own signal is the icon shape itself (crossed-out mic/headset),
  // not just a color tint — color alone reads as "something's different"
  // without saying what. Kept alongside the color tint, not instead of it.
  muteBtn.textContent = state.isMuted ? '🔇' : '🎤';
  muteBtn.classList.toggle('btn-danger', state.isMuted);
  muteBtn.classList.toggle('btn-ghost', !state.isMuted);
  muteBtn.setAttribute('aria-pressed', String(state.isMuted));
  muteBtn.title = state.isMuted ? 'Ativar microfone' : 'Silenciar microfone';

  deafenBtn.textContent = state.isDeafened ? '🔕' : '🎧';
  deafenBtn.classList.toggle('btn-danger', state.isDeafened);
  deafenBtn.classList.toggle('btn-ghost', !state.isDeafened);
  deafenBtn.setAttribute('aria-pressed', String(state.isDeafened));
  deafenBtn.title = state.isDeafened ? 'Desativar surdina' : 'Ensurdecer';

  if (!inVoice) statusEl.textContent = 'Desconectado';
  else if (state.isDeafened) statusEl.textContent = '🔕 Ensurdecido';
  else if (state.isMuted) statusEl.textContent = '🔇 Silenciado';
  else statusEl.textContent = '🎧 Em áudio';
}

function closeSettingsPopover() {
  settingsPopover.classList.add('hidden');
  settingsBtn.setAttribute('aria-expanded', 'false');
}

// Not gated on being in voice — it's also where you pick your default
// devices ahead of joining, and sign out (see lobby.js's wiring of
// #userBarLogoutBtn).
function toggleSettingsPopover() {
  const opening = settingsPopover.classList.contains('hidden');
  if (opening) {
    populateMicSelect();
    populateSpeakerSelect();
  }
  settingsPopover.classList.toggle('hidden', !opening);
  settingsBtn.setAttribute('aria-expanded', String(opening));
}

// track.enabled=false keeps the sender/PC up and just sends silence — no
// renegotiation, instant, cheap.
function applyMicEnabled() {
  const enabled = state.isInVoice && !state.isMuted && !state.isDeafened;
  state.micStream?.getAudioTracks().forEach((t) => { t.enabled = enabled; });
}

// Join/leave cues only play while you're in voice and not deafened, like
// Discord, and follow the speaker picked in settings. The sink is only
// re-applied when it changes: switching it re-inits the context's output.
let cueSinkId = '';
function playCue(play) {
  if (!state.isInVoice || state.isDeafened) return;
  try {
    const ctx = ensureAudioCtx();
    const sinkId = currentSpeakerDeviceId === 'default' ? '' : currentSpeakerDeviceId;
    if (typeof ctx.setSinkId === 'function' && sinkId !== cueSinkId) {
      cueSinkId = sinkId;
      ctx.setSinkId(sinkId).catch(() => {});
    }
    play(ctx);
  } catch { /* a missed cue must never break signalling */ }
}

function applyDeafened() {
  audioSinks.forEach((audio) => { audio.muted = state.isDeafened; });
}

function applySpeakerSink(audio) {
  if (!SPEAKER_SELECTION_SUPPORTED) return;
  audio.setSinkId(currentSpeakerDeviceId).catch(() => {});
}

// Per-user voice volume (right-click a member, see voiceMenu.js). Remembered by
// username — socket ids change on every reconnect — and applied through the
// element's own volume, so deafen (audio.muted) and the speaking indicator
// (which reads the stream, not the element) are untouched.
const USER_VOICE_KEY = 'scrimaAi.userVoiceSettings';

function loadUserVoiceSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(USER_VOICE_KEY));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? new Map(Object.entries(raw)) : new Map();
  } catch { return new Map(); }
}
const userVoiceSettings = loadUserVoiceSettings(); // username -> { volume 0..1, muted }

function clampVolume(v) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

export function getUserVoiceSettings(peerId) {
  const saved = userVoiceSettings.get(state.peerUsernames.get(peerId));
  return { volume: clampVolume(saved?.volume), muted: saved?.muted === true };
}

function applyUserVoice(peerId, audio) {
  const { volume, muted } = getUserVoiceSettings(peerId);
  audio.volume = muted ? 0 : volume;
}

export function setUserVoiceSettings(peerId, patch) {
  const name = state.peerUsernames.get(peerId);
  if (!name) return;
  const next = { ...getUserVoiceSettings(peerId), ...patch };
  next.volume = clampVolume(next.volume);
  next.muted = next.muted === true;
  // Defaults aren't stored, so the map only holds people you actually changed.
  if (next.volume === 1 && !next.muted) userVoiceSettings.delete(name);
  else userVoiceSettings.set(name, next);
  try { localStorage.setItem(USER_VOICE_KEY, JSON.stringify(Object.fromEntries(userVoiceSettings))); } catch { /* best-effort only */ }
  audioSinks.forEach((audio, id) => {
    if (state.peerUsernames.get(id) === name) applyUserVoice(id, audio);
  });
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
      applySpeakerSink(audio);
    }
    audio.srcObject = event.streams[0] || new MediaStream([event.track]);
    audio.muted = state.isDeafened;
    applyUserVoice(peerId, audio);
    audio.play().catch(() => {});
    attachAnalyser(peerId, audio.srcObject);
  };

  voicePcs.set(peerId, pc);
  return pc;
}

function addMicTrack(pc) {
  if (!state.micStream) return;
  if (pc.getSenders().some((s) => s.track && s.track.kind === 'audio')) return;
  pc.addTrack(state.micStream.getAudioTracks()[0]);
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
  detachAnalyser(peerId);
}

function teardownAllPeers() {
  voicePcs.forEach((pc) => pc.close());
  voicePcs.clear();
  audioSinks.forEach((audio) => { audio.srcObject = null; });
  audioSinks.clear();
  // Leaves the local analyser ('local') alone — a disconnect tears down the
  // remote mesh but not the still-live mic capture, and existing-peers
  // rebuilds the remote side on reconnect.
  [...analysers.keys()].forEach((id) => { if (id !== 'local') detachAnalyser(id); });
}

function captureMic(deviceId) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (deviceId && deviceId !== 'default') audio.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio });
}

// Device labels are blank until mic permission has been granted at least
// once in this origin — the list still populates (unlabeled) before that,
// e.g. on initVoice's first call, ahead of ever joining. Re-run on
// 'devicechange' and right after joining, once permission is certainly granted.
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

// Same idea as populateMicSelect, for 'audiooutput' devices — a no-op (empty
// select, left hidden) when the browser can't select an output at all.
async function populateSpeakerSelect() {
  if (!SPEAKER_SELECTION_SUPPORTED) return;
  speakerRow.classList.remove('hidden');

  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
  } catch { /* leave the list at just "Saída padrão" */ }

  speakerSelect.innerHTML = '';
  speakerSelect.appendChild(new Option('Saída padrão', 'default'));
  devices.forEach((d) => {
    if (!d.deviceId || d.deviceId === 'default') return;
    speakerSelect.appendChild(new Option(d.label || `Saída ${d.deviceId.slice(0, 6)}`, d.deviceId));
  });

  const validValues = Array.from(speakerSelect.options).map((o) => o.value);
  speakerSelect.value = validValues.includes(currentSpeakerDeviceId) ? currentSpeakerDeviceId : 'default';
}

// Hot-swaps the outgoing mic track on every live voice connection —
// replaceTrack, no renegotiation, same pattern as switchCamera() in share.js.
async function switchMicDevice(deviceId) {
  if (!state.isInVoice || micSwitchInFlight) return;
  micSwitchInFlight = true;
  const previousStream = state.micStream;
  const previousGraph = noiseSuppressionGraph; // captureProcessedMic overwrites the module-level one below on success

  try {
    const stream = await captureProcessedMic(deviceId);
    const track = stream.getAudioTracks()[0];
    track.enabled = !state.isMuted && !state.isDeafened;

    state.micStream = stream;
    currentMicDeviceId = deviceId;
    detachAnalyser('local');
    attachAnalyser('local', stream);
    voicePcs.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      sender?.replaceTrack(track).catch(() => {});
    });
    teardownGraph(previousGraph);
    previousStream?.getTracks().forEach((t) => t.stop());
  } catch (err) {
    console.error('Failed to switch microphone:', err);
    showToast('Não foi possível trocar o microfone.', 'error');
    micSelect.value = currentMicDeviceId; // revert the dropdown to what's actually active
  } finally {
    micSwitchInFlight = false;
  }
}

// Bound to the select itself — persists the choice as the new default
// (Discord-style) whether or not a call is live, and additionally hot-swaps
// the active track when it is.
function handleMicSelectChange() {
  const deviceId = micSelect.value;
  saveDevicePref(MIC_PREF_KEY, deviceId);
  if (state.isInVoice) switchMicDevice(deviceId);
  else currentMicDeviceId = deviceId;
}

function handleSpeakerSelectChange() {
  currentSpeakerDeviceId = speakerSelect.value;
  saveDevicePref(SPEAKER_PREF_KEY, currentSpeakerDeviceId);
  audioSinks.forEach((audio) => applySpeakerSink(audio));
}

// Exported so lobby.js can auto-connect when a Discord-style voice channel
// row is clicked, the same way clicking joinBtn does below.
export async function joinVoice() {
  if (state.isInVoice) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('Microfone não é suportado neste navegador/dispositivo.', 'error');
    return;
  }

  let stream;
  try {
    stream = await captureMic(currentMicDeviceId);
  } catch (err) {
    // The saved device (e.g. unplugged since last time) may simply no longer
    // exist — retry against whatever the OS considers default before giving
    // up, same as a fresh install would.
    if (currentMicDeviceId !== 'default') {
      try {
        stream = await captureMic('default');
        currentMicDeviceId = 'default';
        saveDevicePref(MIC_PREF_KEY, 'default');
      } catch (err2) {
        console.error('Failed to capture microphone:', err2);
        showToast('Não foi possível acessar o microfone.', 'error');
        return;
      }
    } else {
      console.error('Failed to capture microphone:', err);
      showToast(
        err.name === 'NotAllowedError'
          ? 'Permissão de microfone negada.'
          : 'Não foi possível acessar o microfone.',
        'error'
      );
      return;
    }
  }

  stream = await applyNoiseSuppression(stream); // the raw capture above, now denoised (or unchanged, if unavailable)

  state.micStream = stream;
  state.isInVoice = true;
  state.isMuted = false;
  state.isDeafened = false;
  applyMicEnabled();
  attachAnalyser('local', stream);
  await populateMicSelect();
  populateSpeakerSelect();
  setVoiceUI();
  refreshParticipants();
  showToast('Você entrou no áudio.');
  playCue(playJoinSound);

  socket.emit('share-status', { purpose: 'voice', isSharing: true });
  state.voicePeers.forEach(connectToPeer);
}

function leaveVoice({ silent = false } = {}) {
  const wasInVoice = state.isInVoice;
  if (wasInVoice && !silent) playCue(playLeaveSound);
  state.micStream?.getTracks().forEach((t) => t.stop());
  state.micStream = null;
  detachAnalyser('local');
  teardownNoiseSuppression();
  state.isInVoice = false;
  state.isMuted = false;
  state.isDeafened = false;
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
  closeSettingsPopover();
}

export function initVoice(theSocket) {
  socket = theSocket;
  setVoiceUI();
  populateMicSelect();
  populateSpeakerSelect();

  joinBtn.addEventListener('click', joinVoice);
  leaveBtn.addEventListener('click', () => leaveVoice());
  muteBtn.addEventListener('click', toggleMute);
  deafenBtn.addEventListener('click', toggleDeafen);
  settingsBtn.addEventListener('click', toggleSettingsPopover);
  micSelect.addEventListener('change', handleMicSelectChange);
  speakerSelect.addEventListener('change', handleSpeakerSelectChange);

  document.addEventListener('click', (e) => {
    if (!settingsPopover.classList.contains('hidden') && !e.target.closest('.user-bar-controls') && !e.target.closest('.user-bar-popover')) {
      closeSettingsPopover();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettingsPopover();
  });

  // A device plugged/unplugged — refresh both dropdowns' options (not the
  // active device; switching only ever happens on an explicit user pick).
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    populateMicSelect();
    populateSpeakerSelect();
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
      const isNew = !state.voicePeers.has(id);
      state.voicePeers.add(id);
      if (isNew) playCue(playJoinSound);
      connectToPeer(id);
    } else {
      if (state.voicePeers.delete(id)) playCue(playLeaveSound);
      teardownPeer(id);
    }
    refreshParticipants();
  });

  socket.on('peer-left', (peerId) => {
    if (state.voicePeers.delete(peerId)) playCue(playLeaveSound);
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
