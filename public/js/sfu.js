// LiveKit (SFU) transport for screen and webcam video. Presence — who is in the
// room, who is sharing, usernames — stays on the Socket.io layer (peers.js), and
// a client's LiveKit identity is its socket id, so a tile key
// (`${socketId}:${purpose}`) means the same thing in both transports.
//
// The server only hands out a join token when LiveKit is configured (see
// 'livekit-token' in server.js). Without one — or if connecting fails — the
// join resolves to 'mesh' and peers.js keeps doing peer-to-peer as before.
import { state } from './state.js';
import { renderTiles } from './tiles.js';
import { showToast } from './toast.js';

const LIVEKIT_MODULE = '../vendor/livekit-client.esm.mjs';
const TOKEN_TIMEOUT_MS = 3000;
// "Auto" means no cap in the mesh; LiveKit wants a number, so use the highest preset.
const AUTO_BITRATE_KBPS = 50000;

let socket = null;
let hooks = { encodingTarget: () => ({ kbps: null, fps: null }), onDecided: () => {} };

let lk = null; // livekit-client module, imported the first time a join gets a token
let room = null;
let mode = 'mesh'; // 'pending' while a join is deciding, then 'sfu' | 'mesh'
let decision = Promise.resolve('mesh');
let generation = 0; // bumped on every (re)connect / disconnect so a stale attempt can't clobber a newer one

const published = { screen: null, webcam: null }; // purpose -> { video, audio } LocalTrackPublication
// `${peerId}:${purpose}` the viewer hid (or auto-paused): their video publication
// stays unsubscribed, including one that shows up later.
const unwatched = new Set();

export function initSfu(theSocket, options) {
  socket = theSocket;
  hooks = { ...hooks, ...options };
}

export function transportMode() {
  return mode;
}

// Resolves once the latest join has settled on 'sfu' or 'mesh'.
export async function transportDecided() {
  let d;
  do {
    d = decision;
    await d;
  } while (d !== decision);
  return mode;
}

function requestToken() {
  return new Promise((resolve) => {
    // An older server never acks this event, so the timeout is what keeps a
    // join from waiting forever.
    socket.timeout(TOKEN_TIMEOUT_MS).emit('livekit-token', (err, reply) => resolve(err ? null : reply));
  });
}

function purposeOfSource(source) {
  const { Source } = lk.Track;
  if (source === Source.ScreenShare || source === Source.ScreenShareAudio) return 'screen';
  if (source === Source.Camera || source === Source.Microphone) return 'webcam';
  return null;
}

function wireRoom(r) {
  const { RoomEvent, Track } = lk;

  // A subscribed track becomes part of the same per-(peer, purpose) MediaStream
  // that tiles.js already renders from state.streams. Re-subscribing after a
  // hide hands us a fresh track, so any older one of the same kind goes first.
  r.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    const purpose = purposeOfSource(publication.source);
    if (!purpose) return;
    const key = `${participant.identity}:${purpose}`;
    let stream = state.streams.get(key);
    if (!stream) {
      stream = new MediaStream();
      state.streams.set(key, stream);
    }
    stream.getTracks()
      .filter((t) => t.kind === track.mediaStreamTrack.kind)
      .forEach((t) => stream.removeTrack(t));
    stream.addTrack(track.mediaStreamTrack);
    renderTiles();
  });

  // Unsubscribing is also what a hide looks like, so the stream (and its tile,
  // with the "hidden" cover) stays; only the track goes.
  r.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    const purpose = purposeOfSource(publication.source);
    if (purpose) state.streams.get(`${participant.identity}:${purpose}`)?.removeTrack(track.mediaStreamTrack);
  });

  r.on(RoomEvent.TrackPublished, (publication, participant) => {
    const purpose = purposeOfSource(publication.source);
    if (purpose && publication.kind === Track.Kind.Video && unwatched.has(`${participant.identity}:${purpose}`)) {
      publication.setSubscribed(false);
    }
  });

  // The sharer stopped (or dropped that part of the share). The socket's
  // 'peer-share-status' normally beats this to it; this covers a publisher that
  // vanished without saying so.
  r.on(RoomEvent.TrackUnpublished, (publication, participant) => {
    const purpose = purposeOfSource(publication.source);
    if (!purpose) return;
    const stillPublishing = [...participant.trackPublications.values()].some(
      (p) => p.trackSid !== publication.trackSid && purposeOfSource(p.source) === purpose
    );
    if (stillPublishing) return;
    state.streams.delete(`${participant.identity}:${purpose}`);
    renderTiles();
  });

  r.on(RoomEvent.Disconnected, () => {
    if (r !== room) return; // we disconnected it ourselves
    console.error('[sfu] connection to the video server was lost');
    showToast('Conexão com o servidor de vídeo perdida. Reconectando…', 'error');
    beginTransport();
  });
}

async function connect(mine) {
  const stale = () => mine !== generation;
  const settle = (next) => {
    if (!stale()) mode = next;
    return next;
  };

  let candidate = null;
  try {
    const reply = await requestToken();
    if (stale()) return mode;
    if (!reply?.enabled) return settle('mesh');

    lk = lk || await import(LIVEKIT_MODULE);
    if (stale()) return mode;

    candidate = new lk.Room({
      // Tiles are plain <video> elements fed from state.streams, not attach()ed
      // LiveKit elements, so adaptive streaming has nothing to measure.
      adaptiveStream: false,
      // Pauses the encoder while nobody is subscribed to our track.
      dynacast: true,
      stopLocalTrackOnUnpublish: false,
    });
    wireRoom(candidate);
    await candidate.connect(reply.url, reply.token);
    if (stale()) {
      candidate.disconnect();
      return mode;
    }
    room = candidate;
    applyPendingHides();
    return settle('sfu');
  } catch (err) {
    console.error('[sfu] falling back to the peer-to-peer mesh:', err);
    candidate?.disconnect();
    if (!stale()) showToast('Servidor de vídeo indisponível — usando conexão direta (P2P).', 'error');
    return settle('mesh');
  }
}

// Called on every join (including a reconnect after a dropped socket): asks the
// server whether LiveKit is on, connects if so, and reports the outcome to
// onDecided so peers.js can (re)publish or fall back to offering mesh streams.
export function beginTransport() {
  disconnectSfu();
  mode = 'pending';
  const mine = ++generation;
  decision = connect(mine);
  decision.then((result) => {
    if (mine === generation) hooks.onDecided(result);
  });
  return decision;
}

export function disconnectSfu() {
  generation++;
  const r = room;
  room = null;
  published.screen = null;
  published.webcam = null;
  unwatched.clear();
  mode = 'mesh';
  r?.disconnect();
}

function videoPublishOptions(purpose) {
  const isScreen = purpose === 'screen';
  const { kbps, fps } = hooks.encodingTarget(purpose);
  const encoding = { maxBitrate: (kbps || AUTO_BITRATE_KBPS) * 1000, maxFramerate: fps || undefined, priority: 'high' };
  return {
    source: isScreen ? lk.Track.Source.ScreenShare : lk.Track.Source.Camera,
    // Hardware-encodable on every GPU vendor, same reasoning as preferHardwareH264 in peers.js.
    videoCodec: 'h264',
    backupCodec: false,
    // One layer: the point of the SFU is one encode, and a viewer that can't
    // keep up should lower the resolution via 'maintain-framerate', not switch layers.
    simulcast: false,
    degradationPreference: 'maintain-framerate',
    ...(isScreen ? { screenShareEncoding: encoding } : { videoEncoding: encoding }),
  };
}

async function publishAudio(purpose, mediaTrack) {
  const source = purpose === 'screen' ? lk.Track.Source.ScreenShareAudio : lk.Track.Source.Microphone;
  const track = new lk.LocalAudioTrack(mediaTrack, undefined, true);
  return room.localParticipant.publishTrack(track, { source, dtx: purpose === 'webcam' });
}

// Publishes the current local stream for a purpose, once, for every viewer.
export async function publishStream(purpose) {
  const stream = purpose === 'webcam' ? state.webcamStream : state.screenStream;
  if (!room || !stream) return;
  await unpublishStream(purpose);

  const pubs = {};
  const [video] = stream.getVideoTracks();
  const [audio] = stream.getAudioTracks();
  if (video) {
    const track = new lk.LocalVideoTrack(video, undefined, true);
    pubs.video = await room.localParticipant.publishTrack(track, videoPublishOptions(purpose));
  }
  if (audio) pubs.audio = await publishAudio(purpose, audio);
  published[purpose] = pubs;

  // Stopped while the publish was still in flight.
  const current = purpose === 'webcam' ? state.webcamStream : state.screenStream;
  if (current !== stream) await unpublishStream(purpose);
}

export async function unpublishStream(purpose) {
  const pubs = published[purpose];
  published[purpose] = null;
  if (!pubs || !room) return;
  await Promise.all(
    [pubs.video, pubs.audio]
      .filter((pub) => pub?.track)
      .map((pub) => room.localParticipant.unpublishTrack(pub.track, false).catch(() => {}))
  );
}

// Source switch: the new capture goes onto the existing publications, so
// viewers keep the same track and just see the picture change.
export async function replacePublishedStream(purpose, newStream) {
  const pubs = published[purpose];
  if (!room || !pubs) return;
  const [video] = newStream.getVideoTracks();
  const [audio] = newStream.getAudioTracks();

  if (video && pubs.video?.track) await pubs.video.track.replaceTrack(video, { userProvidedTrack: true });

  if (pubs.audio && audio) {
    await pubs.audio.track.replaceTrack(audio, { userProvidedTrack: true });
  } else if (pubs.audio) {
    await room.localParticipant.unpublishTrack(pubs.audio.track, false).catch(() => {});
    pubs.audio = null;
  } else if (audio) {
    pubs.audio = await publishAudio(purpose, audio);
  }
}

export function getPublishedVideoSender(purpose) {
  return published[purpose]?.video?.track?.sender || null;
}

// Whether anything is receiving our video. dynacast switches the sender's
// encoding off when nobody is subscribed (or every viewer hid it) — it fires no
// event for that, so this reads the encoding directly; peers.js re-checks it on
// its stats tick, which is what lets the idle capture throttle follow.
export function hasSfuViewers(purpose) {
  const encoding = getPublishedVideoSender(purpose)?.getParameters().encodings?.[0];
  return encoding ? encoding.active !== false : true;
}

export function sfuViewerCount() {
  return room ? room.remoteParticipants.size : 0;
}

// The viewer's per-tile hide / the window-hidden auto-pause. Unsubscribing the
// video publication is what makes the server stop forwarding it, which is the
// same saving the mesh got by replaceTrack(null). Audio is left alone.
export function setSfuWatching(peerId, purpose, watching) {
  const key = `${peerId}:${purpose}`;
  if (watching) unwatched.delete(key); else unwatched.add(key);
  applySubscription(peerId, purpose, watching);
}

function applySubscription(peerId, purpose, watching) {
  room?.remoteParticipants.get(peerId)?.trackPublications.forEach((pub) => {
    if (pub.kind === lk.Track.Kind.Video && purposeOfSource(pub.source) === purpose) pub.setSubscribed(watching);
  });
}

// Hides asked for while the join was still connecting apply to publications
// that were already there when we arrived.
function applyPendingHides() {
  unwatched.forEach((key) => {
    const split = key.lastIndexOf(':');
    applySubscription(key.slice(0, split), key.slice(split + 1), false);
  });
}

// RTCStatsReports for the stats badge and diagnostics: our outbound video per
// purpose, and each remote video we're receiving keyed like a tile.
export async function collectSfuStats() {
  const result = { outbound: {}, inbound: new Map() };
  if (!room) return result;

  const tasks = [];
  ['screen', 'webcam'].forEach((purpose) => {
    const track = published[purpose]?.video?.track;
    if (track) {
      tasks.push(track.getRTCStatsReport().then((report) => { if (report) result.outbound[purpose] = report; }).catch(() => {}));
    }
  });
  room.remoteParticipants.forEach((participant) => {
    participant.trackPublications.forEach((pub) => {
      const purpose = purposeOfSource(pub.source);
      const receiver = pub.track?.receiver;
      if (!purpose || pub.kind !== lk.Track.Kind.Video || !receiver) return;
      tasks.push(receiver.getStats().then((report) => result.inbound.set(`${participant.identity}:${purpose}`, report)).catch(() => {}));
    });
  });
  await Promise.all(tasks);
  return result;
}
