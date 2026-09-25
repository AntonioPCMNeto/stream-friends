// Voice cues, synthesized with Web Audio so there are no assets to ship (and
// nothing for the CSP to block): a rising pair when someone joins, a falling
// pair when they leave, and lower-pitched pairs for mute/unmute and
// deafen/undeafen so they can be told apart by ear. `volume` is 0-1 and scales
// the whole cue (the "volume dos sons" setting).

const HIGH_HZ = 880;
const LOW_HZ = 587.33;
const NOTE_SECONDS = 0.09;
const PEAK_GAIN = 0.12;

function playPair(ctx, frequencies, volume = 1) {
  const peak = Math.max(0.0002, PEAK_GAIN * volume);
  const start = ctx.currentTime + 0.01;
  frequencies.forEach((hz, i) => {
    const t = start + i * NOTE_SECONDS;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + NOTE_SECONDS);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + NOTE_SECONDS + 0.02);
  });
}

export function playJoinSound(ctx, volume) {
  playPair(ctx, [LOW_HZ, HIGH_HZ], volume);
}

export function playLeaveSound(ctx, volume) {
  playPair(ctx, [HIGH_HZ, LOW_HZ], volume);
}

export function playMuteSound(ctx, volume) {
  playPair(ctx, [523.25, 392], volume);
}

export function playUnmuteSound(ctx, volume) {
  playPair(ctx, [392, 523.25], volume);
}

export function playDeafenSound(ctx, volume) {
  playPair(ctx, [392, 293.66], volume);
}

export function playUndeafenSound(ctx, volume) {
  playPair(ctx, [293.66, 392], volume);
}
