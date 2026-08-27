// Mutable state shared across modules. Mutate properties in place
// (e.g. state.isSharing = true) rather than reassigning this object.
export const state = {
  localStream: null,
  isSharing: false,
  videoBitrateKbps: 6000, // null/0 = auto (browser default, no cap)
  videoFramerateFps: 30,
  roomId: null,
  myUsername: null,
  hasEntered: false,
  currentRoomUrl: null,
  knownPeers: new Set(), // remote socket ids
  peerUsernames: new Map(), // socket id -> username
  sharingPeers: new Set(), // socket ids currently sharing their screen
};
