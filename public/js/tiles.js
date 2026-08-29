import { state } from './state.js';
import { setWatching } from './peers.js';

const videosContainer = document.getElementById('videos');
const tiles = new Map(); // tile key ('local' or socket id) -> tile <div>

// Fullscreens the tile wrapper, not the <video> itself — Chrome overlays
// its own native play/pause/volume controls when a <video> element goes
// fullscreen directly, which makes no sense for a live stream and hides
// our own overlay. Fullscreening the wrapping div avoids that.
function toggleFullscreen(el) {
  if (document.fullscreenElement === el) {
    document.exitFullscreen();
  } else {
    el.requestFullscreen();
  }
}

// Fades the overlay and nav arrows (and hides the cursor) once the pointer
// sits still for a couple of seconds, the way YouTube/Discord players do.
// Any movement brings them back; leaving the tile hides them immediately;
// holding the pointer down (dragging the volume slider) keeps them up.
function initAutoHide(tile) {
  let timer;
  let held = false;
  const arm = () => {
    clearTimeout(timer);
    if (held) return;
    timer = setTimeout(() => tile.classList.add('controls-hidden'), 2500);
  };
  const show = () => {
    tile.classList.remove('controls-hidden');
    arm();
  };
  tile.addEventListener('pointermove', show);
  tile.addEventListener('pointerdown', () => { held = true; show(); });
  tile.addEventListener('pointerup', () => { held = false; arm(); });
  tile.addEventListener('pointerleave', () => {
    if (held) return;
    clearTimeout(timer);
    tile.classList.add('controls-hidden');
  });
  show();
}

// Switches to the next/previous tile's fullscreen. Wraps around; a no-op with
// a single tile. Exits first, then re-enters: calling requestFullscreen() on a
// second element while one is already fullscreen *stacks* it rather than
// swapping, so a later exitFullscreen() pops back to the previous tile instead
// of returning to the grid.
async function switchFullscreen(direction) {
  const current = document.fullscreenElement;
  if (!current) return;

  const keys = [...tiles.keys()];
  const currentIndex = keys.findIndex((key) => tiles.get(key) === current);
  if (currentIndex === -1) return;

  const nextIndex = (currentIndex + direction + keys.length) % keys.length;
  const next = tiles.get(keys[nextIndex]);
  if (next === current) return;

  try {
    await document.exitFullscreen();
    await next.requestFullscreen();
  } catch (err) {
    // Transient activation may not survive the exit; dropping to the grid is
    // an acceptable fallback.
    console.error('Failed to switch fullscreen tile:', err);
  }
}

// `f` exits fullscreen too, alongside the browser's native Esc. Ignored while
// typing into an input so it doesn't eat the keystroke.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'f' && e.key !== 'F') return;
  if (!document.fullscreenElement) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  document.exitFullscreen();
});

// Builds one video tile (your own preview or a remote streamer's). Tiles
// always start muted — Chrome blocks unmuted autoplay without a prior user
// gesture, which a friend just opening the room link won't have given yet.
// Remote tiles get a mute toggle and a volume slider. The stream and label
// are filled in by renderTiles(); everything transient the viewer sets here
// (mute, volume, stats visibility, which controls show) lives on the node
// and survives every re-render.
function createTile(isLocal, key) {
  const tile = document.createElement('div');
  tile.className = 'tile';

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.ondblclick = () => toggleFullscreen(tile);

  // "Hide this stream" cover — click it (or the 👁 button) to bring the
  // stream back. Only built for remote tiles; wired further down.
  let hiddenCover = null;

  const statsEl = document.createElement('div');
  statsEl.className = 'tile-stats';

  const overlay = document.createElement('div');
  overlay.className = 'tile-overlay';

  const labelEl = document.createElement('span');
  labelEl.className = 'tile-label';

  const actions = document.createElement('div');
  actions.className = 'tile-actions';

  if (!isLocal) {
    // Tell the sharer to stop / resume sending us this screen. While hidden
    // they encode nothing for us — it's a real bandwidth + CPU cut on both
    // ends, not just a UI hide.
    const watchBtn = document.createElement('button');
    watchBtn.className = 'icon-btn';
    watchBtn.title = 'Ocultar stream';
    watchBtn.setAttribute('aria-label', 'Ocultar stream');
    watchBtn.textContent = '👁';

    hiddenCover = document.createElement('button');
    hiddenCover.className = 'stream-hidden-cover';
    hiddenCover.textContent = 'Stream oculto — clique para mostrar';

    const toggleHidden = () => {
      const hidden = tile.classList.toggle('stream-hidden');
      watchBtn.textContent = hidden ? '🚫' : '👁';
      watchBtn.title = hidden ? 'Mostrar stream' : 'Ocultar stream';
      watchBtn.setAttribute('aria-label', watchBtn.title);
      setWatching(key, !hidden);
    };
    watchBtn.onclick = toggleHidden;
    hiddenCover.onclick = toggleHidden;
    actions.appendChild(watchBtn);

    const muteBtn = document.createElement('button');
    muteBtn.className = 'icon-btn';
    muteBtn.title = 'Mudo';
    muteBtn.setAttribute('aria-label', 'Mudo');
    muteBtn.textContent = '🔇';
    muteBtn.onclick = () => {
      video.muted = !video.muted;
      const label = video.muted ? 'Ativar som' : 'Mudo';
      muteBtn.textContent = video.muted ? '🔇' : '🔊';
      muteBtn.title = label;
      muteBtn.setAttribute('aria-label', label);
    };
    actions.appendChild(muteBtn);

    const volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.className = 'volume-slider';
    volumeSlider.min = '0';
    volumeSlider.max = '1';
    volumeSlider.step = '0.05';
    volumeSlider.value = '1';
    volumeSlider.title = 'Volume';
    volumeSlider.setAttribute('aria-label', 'Volume');
    volumeSlider.oninput = () => {
      video.volume = Number(volumeSlider.value);
      video.muted = false;
      muteBtn.textContent = '🔊';
      muteBtn.title = 'Mudo';
    };
    actions.appendChild(volumeSlider);
  }

  if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
    const pipBtn = document.createElement('button');
    pipBtn.className = 'icon-btn';
    pipBtn.title = 'Picture-in-Picture';
    pipBtn.setAttribute('aria-label', 'Picture-in-Picture');
    pipBtn.textContent = '🗗';
    pipBtn.onclick = async () => {
      try {
        if (document.pictureInPictureElement === video) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch (err) {
        console.error('Failed to toggle Picture-in-Picture:', err);
      }
    };
    actions.appendChild(pipBtn);
  }

  // Toggles the resolution/fps/bitrate badge. Off by default — it's
  // diagnostic detail, not something to stare at during a normal watch.
  const infoBtn = document.createElement('button');
  infoBtn.className = 'icon-btn';
  infoBtn.title = 'Informações do stream';
  infoBtn.setAttribute('aria-label', 'Informações do stream');
  infoBtn.setAttribute('aria-pressed', 'false');
  infoBtn.textContent = 'ℹ️';
  infoBtn.onclick = () => {
    const on = tile.classList.toggle('stats-visible');
    infoBtn.setAttribute('aria-pressed', String(on));
  };
  actions.appendChild(infoBtn);

  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.className = 'icon-btn';
  fullscreenBtn.title = 'Tela cheia';
  fullscreenBtn.setAttribute('aria-label', 'Tela cheia');
  fullscreenBtn.textContent = '⛶';
  fullscreenBtn.onclick = () => toggleFullscreen(tile);
  actions.appendChild(fullscreenBtn);

  const prevBtn = document.createElement('button');
  prevBtn.className = 'tile-nav prev';
  prevBtn.title = 'Stream anterior';
  prevBtn.setAttribute('aria-label', 'Stream anterior');
  prevBtn.textContent = '◀';
  prevBtn.onclick = () => switchFullscreen(-1);

  const nextBtn = document.createElement('button');
  nextBtn.className = 'tile-nav next';
  nextBtn.title = 'Próximo stream';
  nextBtn.setAttribute('aria-label', 'Próximo stream');
  nextBtn.textContent = '▶';
  nextBtn.onclick = () => switchFullscreen(1);

  overlay.appendChild(labelEl);
  overlay.appendChild(actions);
  tile.appendChild(video);
  if (hiddenCover) tile.appendChild(hiddenCover); // above the video, below the controls
  tile.appendChild(statsEl);
  tile.appendChild(prevBtn);
  tile.appendChild(nextBtn);
  tile.appendChild(overlay);

  return tile;
}

// Reconciles the tile grid against current state: the local preview while
// we're sharing (state.localStream) plus one tile per inbound stream
// (state.streams). Idempotent — call it after any change that adds or drops
// a stream. Existing tile nodes are reused, so playback / PiP / volume / the
// stats toggle are never interrupted by a re-render.
export function renderTiles() {
  const desired = new Map(); // key -> { stream, label, isLocal }

  if (state.localStream) {
    desired.set('local', {
      stream: state.localStream,
      label: `Você (${state.myUsername})`,
      isLocal: true,
    });
  }
  for (const [id, stream] of state.streams) {
    desired.set(id, {
      stream,
      label: state.peerUsernames.get(id) || `Usuário ${id.slice(0, 5)}`,
      isLocal: false,
    });
  }

  for (const key of [...tiles.keys()]) {
    if (!desired.has(key)) {
      tiles.get(key).remove();
      tiles.delete(key);
    }
  }

  for (const [key, { stream, label, isLocal }] of desired) {
    let tile = tiles.get(key);
    if (!tile) {
      tile = createTile(isLocal, key);
      videosContainer.appendChild(tile);
      initAutoHide(tile);
      tiles.set(key, tile);
    }
    const video = tile.querySelector('video');
    if (video.srcObject !== stream) video.srcObject = stream;
    const labelEl = tile.querySelector('.tile-label');
    if (labelEl.textContent !== label) labelEl.textContent = label;
  }
}

// Updates the small "1280x720 · 30fps · 850kbps" badge shown on a tile.
// No-op if the tile doesn't exist (e.g. a stats sample arriving right as
// the tile is torn down).
export function updateTileStats(key, text) {
  const tile = tiles.get(key);
  if (!tile) return;
  tile.querySelector('.tile-stats').textContent = text;
}
