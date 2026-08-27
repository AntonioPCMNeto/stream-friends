// STUN handles most NATs; TURN relays traffic when a direct connection
// can't be established (symmetric NATs, restrictive firewalls).
// Using the free Open Relay Project (metered.ca) — public demo credentials,
// no signup required. Swap for a private TURN provider or self-hosted
// coturn if you outgrow its shared bandwidth limits.
export const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:openrelay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
