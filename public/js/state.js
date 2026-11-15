// Mutable state shared across modules. Mutate properties in place
// (e.g. state.isSharingScreen = true) rather than reassigning this object.
export const state = {
  // Local outgoing streams. Screen and webcam are independent — either,
  // neither, or both can be active at once.
  screenStream: null,
  webcamStream: null,
  isSharingScreen: false,
  nativeSize: null, // { width, height } the native helper encodes
  nativeStats: null, // last 'stats' line from the native helper
  nativeScreen: false, // the screen video comes from the desktop capture helper (nativeShare.js), not a MediaStreamTrack
  isSharingWebcam: false,
  webcamFacing: 'user', // 'user' | 'environment' — which camera to request (matters on phones)
  videoBitrateKbps: null, // null/0 = auto (browser default, no cap) — screen only
  videoFramerateFps: 30, // screen only; webcam uses a fixed default (see share.js)
  // Voice chat (full mesh, purpose 'voice' — see voice.js). Independent of
  // screen/webcam sharing.
  micStream: null,
  isInVoice: false,
  isMuted: false,
  isDeafened: false,
  voicePeers: new Set(), // socket ids currently in the voice mesh
  roomId: null,
  myUsername: null,
  myVerified: false, // signed in with Discord (see lobby.js/auth.js), not just a typed nick
  hasEntered: false,
  currentRoomUrl: null,
  knownPeers: new Set(), // remote socket ids
  peerUsernames: new Map(), // socket id -> username
  peerVerified: new Map(), // socket id -> verified (bool, signed in with Discord)
  sharingPeers: new Map(), // socket id -> Set of purposes ('screen'/'webcam') they're sharing
  // tile key (`${peerId}:${purpose}`, 'local' streams excluded — see
  // state.screenStream/webcamStream) -> inbound MediaStream
  streams: new Map(),
  // Streams being watched from a channel other than the one we're in (see
  // sfu.js's startRemoteWatch): tile key -> { channelId, channelName, username }.
  // Their peers aren't in knownPeers, so tiles.js lets these keys through.
  remoteWatch: new Map(),
};
