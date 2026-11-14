// Electron only. The stream's audio without Discord: the main process captures
// "everything except Discord" (see startLoopbackHelper in main.js) and pushes raw
// PCM here, which pcmPlayerWorklet.js turns into a MediaStreamTrack. A window
// share carries only that program's audio ('include'); a screen share carries
// everything except Discord ('exclude'). Resolves to null whenever that isn't possible — Discord isn't running, old Windows, the
// helper was blocked — and the caller keeps the regular system audio instead.
let pipeline = null;

export async function startAppAudio(sourceId) {
  stopAppAudio();
  if (!window.appAudio) return null;

  let result;
  try {
    result = await window.appAudio.start(sourceId);
  } catch (err) {
    console.error('[audio] could not ask for app audio:', err);
    return null;
  }
  if (!result?.ok) {
    console.log('[audio] using the regular system audio:', result?.reason);
    return null;
  }

  try {
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule(new URL('./pcmPlayerWorklet.js', import.meta.url).href);
    const node = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [2] });
    const destination = ctx.createMediaStreamDestination();
    node.connect(destination);
    // A silent branch to the real output keeps the context running; nothing is audible.
    const keepAlive = ctx.createGain();
    keepAlive.gain.value = 0;
    node.connect(keepAlive).connect(ctx.destination);
    window.appAudio.onPcm((data) => node.port.postMessage(data, [data.buffer]));
    await ctx.resume();
    pipeline = { ctx };
    return { track: destination.stream.getAudioTracks()[0], mode: result.mode };
  } catch (err) {
    console.error('[audio] app audio pipeline failed:', err);
    window.appAudio.stop();
    return null;
  }
}

export function stopAppAudio() {
  if (!pipeline) return;
  pipeline.ctx.close().catch(() => {});
  pipeline = null;
  window.appAudio?.stop();
}
