// Plays raw 48 kHz / stereo / 16-bit PCM pushed from the main process (see
// appAudio.js). A small ring buffer absorbs the jitter between the helper's
// packets and the audio clock; if it runs dry the output is silence until a
// little audio has built up again, and if it grows too far the oldest audio is
// dropped so the stream never drifts behind.
const CAPACITY = 48000; // 1 s
const START_LEVEL = 2400; // 50 ms buffered before playing
const MAX_LEVEL = 12000; // 250 ms: beyond this, trim back to TRIM_LEVEL
const TRIM_LEVEL = 4800;

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(CAPACITY);
    this.right = new Float32Array(CAPACITY);
    this.readPos = 0;
    this.writePos = 0;
    this.level = 0;
    this.playing = false;
    this.port.onmessage = (event) => {
      const bytes = event.data;
      this.push(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1));
    };
  }

  push(samples) {
    const frames = samples.length >> 1;
    for (let i = 0; i < frames; i++) {
      if (this.level >= CAPACITY) {
        this.readPos = (this.readPos + 1) % CAPACITY;
        this.level--;
      }
      this.left[this.writePos] = samples[2 * i] / 32768;
      this.right[this.writePos] = samples[2 * i + 1] / 32768;
      this.writePos = (this.writePos + 1) % CAPACITY;
      this.level++;
    }
    if (this.level > MAX_LEVEL) {
      const drop = this.level - TRIM_LEVEL;
      this.readPos = (this.readPos + drop) % CAPACITY;
      this.level = TRIM_LEVEL;
    }
  }

  process(inputs, outputs) {
    const [left, right] = outputs[0];
    if (!this.playing) {
      if (this.level < START_LEVEL) return true;
      this.playing = true;
    }
    for (let i = 0; i < left.length; i++) {
      if (this.level === 0) {
        this.playing = false; // underrun: rebuffer before playing again
        break;
      }
      left[i] = this.left[this.readPos];
      right[i] = this.right[this.readPos];
      this.readPos = (this.readPos + 1) % CAPACITY;
      this.level--;
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
