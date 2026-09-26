import { getIdentity, uploadAvatar, removeAvatar } from './auth.js';
import { buildAvatar } from './identity.js';
import { showToast } from './toast.js';

const AVATAR_SIZE = 256;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

// Center-crops to a square and re-encodes small (a few KB) — the file that
// gets stored and downloaded by every viewer is never the original photo.
async function toAvatarBlob(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_SIZE;
  canvas.getContext('2d').drawImage(
    bitmap,
    (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
    0, 0, AVATAR_SIZE, AVATAR_SIZE
  );
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
}

let openModalImpl = null;

// For the settings page's "Editar foto de perfil".
export function openProfileModal() {
  openModalImpl?.();
}

// Click anyone's avatar that has a picture to see it large. Capture phase so it
// wins over the row/card the avatar sits in (join channel, open server...);
// your own avatars keep opening the edit dialog.
function initAvatarViewer() {
  const backdrop = document.getElementById('avatarViewBackdrop');
  const preview = document.getElementById('avatarViewPreview');
  const nameEl = document.getElementById('avatarViewName');
  const close = () => backdrop.classList.add('hidden');

  document.addEventListener('click', (e) => {
    const el = e.target.closest('.avatar[data-user][data-photo]');
    if (!el || el.closest('.avatar-editable')) return;
    e.stopPropagation();
    e.preventDefault();
    const avatar = buildAvatar(el.dataset.user, el.dataset.photo);
    avatar.classList.add('avatar-xxl');
    preview.replaceChildren(avatar);
    nameEl.textContent = el.dataset.user;
    backdrop.classList.remove('hidden');
  }, true);

  document.getElementById('avatarViewCloseBtn').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) close();
  });
}

export function initProfilePicture() {
  initAvatarViewer();
  const input = document.getElementById('avatarFileInput');
  const backdrop = document.getElementById('profileModalBackdrop');
  const preview = document.getElementById('profilePreview');
  const nameEl = document.getElementById('profileModalName');
  const chooseBtn = document.getElementById('profileChooseBtn');
  const saveBtn = document.getElementById('profileSaveBtn');
  const cancelBtn = document.getElementById('profileCancelBtn');
  const removeBtn = document.getElementById('profileRemoveBtn');
  const settingsBtn = document.getElementById('userBarSettingsBtn');
  const settingsPopover = document.getElementById('userBarPopover');

  let identity = null;
  let pendingBlob = null;
  let pendingUrl = null;

  function showCurrent() {
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    pendingBlob = pendingUrl = null;
    preview.innerHTML = '';
    const avatar = buildAvatar(identity.username, identity.avatarUrl);
    avatar.classList.add('avatar-xl');
    preview.appendChild(avatar);
    chooseBtn.classList.remove('hidden');
    removeBtn.classList.toggle('hidden', !identity.avatarUrl);
    saveBtn.classList.add('hidden');
    cancelBtn.classList.add('hidden');
  }

  function showPending(blob) {
    pendingBlob = blob;
    pendingUrl = URL.createObjectURL(blob);
    preview.innerHTML = '';
    const avatar = buildAvatar(identity.username, pendingUrl);
    avatar.classList.add('avatar-xl');
    preview.appendChild(avatar);
    chooseBtn.classList.add('hidden');
    removeBtn.classList.add('hidden');
    saveBtn.classList.remove('hidden');
    cancelBtn.classList.remove('hidden');
  }

  function closeModal() {
    backdrop.classList.add('hidden');
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    pendingBlob = pendingUrl = null;
  }

  async function openModal() {
    identity = await getIdentity();
    if (!identity) {
      showToast('Entre na sua conta para ter uma foto de perfil.', 'error');
      return;
    }
    nameEl.textContent = identity.username;
    showCurrent();
    backdrop.classList.remove('hidden');
  }

  openModalImpl = openModal;
  document.querySelectorAll('.avatar-editable').forEach((el) => el.addEventListener('click', openModal));
  document.getElementById('userBarProfileBtn').addEventListener('click', () => {
    if (!settingsPopover.classList.contains('hidden')) settingsBtn.click();
    openModal();
  });

  document.getElementById('profileModalCloseBtn').addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) closeModal();
  });

  chooseBtn.addEventListener('click', () => input.click());
  removeBtn.addEventListener('click', async () => {
    removeBtn.disabled = true;
    const { error } = await removeAvatar();
    removeBtn.disabled = false;
    if (error) {
      showToast(error, 'error');
      return;
    }
    showToast('Foto de perfil removida.');
    closeModal();
    document.dispatchEvent(new CustomEvent('profile-changed'));
  });
  cancelBtn.addEventListener('click', showCurrent);

  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > MAX_SOURCE_BYTES) {
      showToast('Escolha uma imagem de até 10 MB.', 'error');
      return;
    }

    let blob;
    try {
      blob = await toAvatarBlob(file);
    } catch {
      showToast('Não foi possível ler essa imagem.', 'error');
      return;
    }
    if (blob?.type !== 'image/webp') {
      showToast('Seu navegador não conseguiu preparar a imagem.', 'error');
      return;
    }
    showPending(blob);
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const { error } = await uploadAvatar(pendingBlob);
    saveBtn.disabled = false;
    if (error) {
      showToast(error, 'error');
      return;
    }
    showToast('Foto de perfil atualizada!');
    closeModal();
    document.dispatchEvent(new CustomEvent('profile-changed'));
  });
}
