// Voice join/leave cues, synthesized with Web Audio so there are no assets to
// ship (and nothing for the CSP to block): a rising pair when someone joins, a
// falling pair when they leave.

const HIGH_HZ = 880;
const LOW_HZ = 587.33;
const NOTE_SECONDS = 0.09;
const PEAK_GAIN = 0.12;

function playPair(ctx, frequencies) {
  const start = ctx.currentTime + 0.01;
  frequencies.forEach((hz, i) => {
    const t = start + i * NOTE_SECONDS;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + NOTE_SECONDS);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + NOTE_SECONDS + 0.02);
  });
}

export function playJoinSound(ctx) {
  playPair(ctx, [LOW_HZ, HIGH_HZ]);
}

export function playLeaveSound(ctx) {
  playPair(ctx, [HIGH_HZ, LOW_HZ]);
}
