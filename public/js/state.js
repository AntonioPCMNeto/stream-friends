// Mutable state shared across modules. Mutate properties in place
// (e.g. state.isSharingScreen = true) rather than reassigning this object.
export const state = {
  // Local outgoing streams. Screen and webcam are independent — either,
  // neither, or both can be active at once.
  screenStream: null,
  webcamStream: null,
  isSharingScreen: false,
  isSharingWebcam: false,
  webcamFacing: 'user', // 'user' | 'environment' — which camera to request (matters on phones)
  videoBitrateKbps: 10000, // null/0 = auto (browser default, no cap) — screen only
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
  hasEntered: false,
  currentRoomUrl: null,
  knownPeers: new Set(), // remote socket ids
  peerUsernames: new Map(), // socket id -> username
  sharingPeers: new Map(), // socket id -> Set of purposes ('screen'/'webcam') they're sharing
  // tile key (`${peerId}:${purpose}`, 'local' streams excluded — see
  // state.screenStream/webcamStream) -> inbound MediaStream
  streams: new Map(),
};
