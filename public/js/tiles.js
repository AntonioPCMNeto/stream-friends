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

// Switches directly to the next/previous tile's fullscreen — calling
// requestFullscreen() on a different element while one is already
// fullscreen swaps to it directly, no exitFullscreen() round-trip needed.
// Wraps around; a no-op with a single tile (only element cycles to itself).
function switchFullscreen(direction) {
  const current = document.fullscreenElement;
  if (!current) return;

  const keys = [...tiles.keys()];
  const currentIndex = keys.findIndex((key) => tiles.get(key) === current);
  if (currentIndex === -1) return;

  const nextIndex = (currentIndex + direction + keys.length) % keys.length;
  tiles.get(keys[nextIndex]).requestFullscreen();
}

// One video tile per stream (your own preview plus one per remote streamer).
// Tiles always start muted — Chrome blocks unmuted autoplay without a prior
// user gesture, which a friend just opening the room link won't have given
// yet. Remote tiles get a mute toggle and a volume slider.
export function addOrUpdateTile(key, stream, label, isLocal) {
  let tile = tiles.get(key);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile';

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.ondblclick = () => toggleFullscreen(tile);

    const statsEl = document.createElement('div');
    statsEl.className = 'tile-stats';

    const overlay = document.createElement('div');
    overlay.className = 'tile-overlay';

    const labelEl = document.createElement('span');
    labelEl.className = 'tile-label';

    const actions = document.createElement('div');
    actions.className = 'tile-actions';

    if (!isLocal) {
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
    tile.appendChild(statsEl);
    tile.appendChild(prevBtn);
    tile.appendChild(nextBtn);
    tile.appendChild(overlay);

    videosContainer.appendChild(tile);
    initAutoHide(tile);
    tiles.set(key, tile);
  }

  tile.querySelector('video').srcObject = stream;
  tile.querySelector('.tile-label').textContent = label;
}

// Updates the small "1280x720 · 30fps · 850kbps" badge shown on a tile.
// No-op if the tile doesn't exist (e.g. a stats sample arriving right as
// the tile is torn down).
export function updateTileStats(key, text) {
  const tile = tiles.get(key);
  if (!tile) return;
  tile.querySelector('.tile-stats').textContent = text;
}

export function removeTile(key) {
  const tile = tiles.get(key);
  if (tile) {
    tile.remove();
    tiles.delete(key);
  }
}

// The <video> element of a tile (or null). The stats poller uses this to
// measure the local preview's real framerate before any viewer connects,
// when there's no outbound RTP to read it from.
export function getTileVideo(key) {
  return tiles.get(key)?.querySelector('video') || null;
}
