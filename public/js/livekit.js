// Replaces peers.js's manual mesh of RTCPeerConnections with a single
// LiveKit Room connection. LiveKit runs an SFU: we publish our screen once
// and it fans the stream out to every viewer server-side, instead of this
// app independently encoding a separate copy per viewer. Presence
// (who's here, who's sharing) comes from the Room's own participant/track
// events instead of a hand-rolled Socket.io protocol.
import { Room, RoomEvent, Track, ConnectionState } from '../vendor/livekit-client.esm.js';
import { state } from './state.js';
import { addOrUpdateTile, removeTile, updateTileStats } from './tiles.js';
import { showToast } from './toast.js';
import { refreshParticipants } from './participants.js';

// Points at `livekit-server --dev` running locally. Swap for a deployed
// LiveKit URL (wss://...) to actually use this outside local testing.
const LIVEKIT_URL = 'ws://localhost:7880';

export const room = new Room();

function labelFor(participant) {
  return participant.name || `Usuário ${participant.identity.slice(0, 5)}`;
}

function isScreenShare(publication) {
  return publication.source === Track.Source.ScreenShare;
}

room.on(RoomEvent.ParticipantConnected, (participant) => {
  state.knownPeers.add(participant.identity);
  state.peerUsernames.set(participant.identity, labelFor(participant));
  showToast(`${labelFor(participant)} entrou na sala`);
  refreshParticipants();
});

room.on(RoomEvent.ParticipantDisconnected, (participant) => {
  const label = state.peerUsernames.get(participant.identity) || 'Alguém';
  state.knownPeers.delete(participant.identity);
  state.peerUsernames.delete(participant.identity);
  state.sharingPeers.delete(participant.identity);
  lastStatsSample.delete(participant.identity);
  removeTile(participant.identity);
  showToast(`${label} saiu da sala`);
  refreshParticipants();
});

// A remote participant's screen-share track became available to render.
room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
  if (track.kind !== Track.Kind.Video) return;
  addOrUpdateTile(participant.identity, new MediaStream([track.mediaStreamTrack]), labelFor(participant), false);
});

room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
  if (track.kind !== Track.Kind.Video) return;
  removeTile(participant.identity);
  lastStatsSample.delete(participant.identity);
});

// Source of truth for the "🔴 Compartilhando" badge — derived directly
// from whether a screen-share track exists, no separate status broadcast
// needed the way the old share-status/peer-share-status socket events were.
room.on(RoomEvent.TrackPublished, (publication, participant) => {
  if (!isScreenShare(publication)) return;
  state.sharingPeers.add(participant.identity);
  refreshParticipants();
});

room.on(RoomEvent.TrackUnpublished, (publication, participant) => {
  if (!isScreenShare(publication)) return;
  // Unpublishing is what setScreenShareEnabled(false) does — this is the
  // real fix for the old "frozen tile" bug: LiveKit tells every subscriber
  // the track is gone, instead of the remote side just going quiet.
  state.sharingPeers.delete(participant.identity);
  removeTile(participant.identity);
  refreshParticipants();
});

let connectionStateListener = null;
export function onConnectionStateChanged(callback) {
  connectionStateListener = callback;
}
room.on(RoomEvent.ConnectionStateChanged, (connectionState) => {
  connectionStateListener?.(connectionState);
});

export { ConnectionState };

async function fetchToken(roomId, identity, name) {
  const url = `/token?room=${encodeURIComponent(roomId)}&identity=${encodeURIComponent(identity)}&name=${encodeURIComponent(name)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const { token } = await res.json();
  return token;
}

// Each tab/session gets its own identity even if two people share a name —
// LiveKit requires unique identities per room, the same role socket.id
// used to play.
function randomIdentitySuffix() {
  return Math.random().toString(36).slice(2, 8);
}

export async function connectToRoom(roomId, username) {
  const identity = `${username}-${randomIdentitySuffix()}`;
  const token = await fetchToken(roomId, identity, username);
  await room.connect(LIVEKIT_URL, token);

  // Peers already in the room when we joined — mirrors the old
  // existing-peers dump: silent, no toasts, no tiles yet (those arrive via
  // TrackSubscribed once the SFU forwards their existing tracks to us).
  room.remoteParticipants.forEach((participant) => {
    state.knownPeers.add(participant.identity);
    state.peerUsernames.set(participant.identity, labelFor(participant));
    participant.trackPublications.forEach((publication) => {
      if (isScreenShare(publication)) state.sharingPeers.add(participant.identity);
    });
  });
  refreshParticipants();
}

export function disconnectFromRoom() {
  room.disconnect();
}

// key (identity or 'local') -> { bytes, ts } from the last sample, used to
// turn cumulative byte counters into an instantaneous kbps figure. Same
// approach as the old peers.js, just fed by LiveKit's own stats getters
// instead of manually walking pc.getStats().
const lastStatsSample = new Map();

function applyStatsSample(key, stats, bytesField) {
  if (!stats) return;
  const bytes = stats[bytesField];
  const ts = stats.timestamp;
  const prev = lastStatsSample.get(key);
  lastStatsSample.set(key, { bytes, ts });

  if (!prev || !stats.frameWidth || !stats.frameHeight) return;
  const deltaBytes = bytes - prev.bytes;
  const deltaMs = ts - prev.ts;
  if (deltaBytes < 0 || deltaMs <= 0) return;

  const kbps = Math.round((deltaBytes * 8) / deltaMs);
  const fps = Math.round(stats.framesPerSecond || 0);
  updateTileStats(key, `${stats.frameWidth}×${stats.frameHeight} · ${fps}fps · ${kbps}kbps`);
}

async function pollStats() {
  const localVideoPub = [...room.localParticipant.trackPublications.values()].find(
    (pub) => pub.track && isScreenShare(pub)
  );
  if (localVideoPub?.track) {
    const [senderStats] = await localVideoPub.track.getSenderStats();
    applyStatsSample('local', senderStats, 'bytesSent');
  }

  for (const participant of room.remoteParticipants.values()) {
    const videoPub = [...participant.trackPublications.values()].find(
      (pub) => pub.track && pub.kind === Track.Kind.Video
    );
    if (!videoPub?.track) continue;
    const receiverStats = await videoPub.track.getReceiverStats();
    applyStatsSample(participant.identity, receiverStats, 'bytesReceived');
  }
}

setInterval(pollStats, 2000);
