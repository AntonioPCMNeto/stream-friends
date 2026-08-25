// Mutable state shared across modules. Mutate properties in place
// (e.g. state.isSharing = true) rather than reassigning this object.
export const state = {
  localStream: null,
  isSharing: false,
  videoBitrateKbps: 2500, // null/0 = auto (browser default, no cap)
  roomId: null,
  myUsername: null,
  hasEntered: false,
  currentRoomUrl: null,
  knownPeers: new Set(), // remote socket ids
  peerUsernames: new Map(), // socket id -> username
};
