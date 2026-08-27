// Mutable state shared across modules. Mutate properties in place
// (e.g. state.isSharing = true) rather than reassigning this object.
export const state = {
  isSharing: false,
  videoBitrateKbps: 2500, // null/0 = auto (browser default, no cap)
  videoFramerateFps: 30,
  roomId: null,
  myUsername: null,
  hasEntered: false,
  currentRoomUrl: null,
  knownPeers: new Set(), // remote LiveKit participant identities
  peerUsernames: new Map(), // identity -> display name
  sharingPeers: new Set(), // identities currently sharing their screen
};
