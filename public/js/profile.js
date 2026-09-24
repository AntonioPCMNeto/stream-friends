import { getIdentity, uploadAvatar } from './auth.js';
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

export function initProfilePicture() {
  const input = document.getElementById('avatarFileInput');
  const triggers = document.querySelectorAll('.avatar-editable');

  triggers.forEach((el) => el.addEventListener('click', async () => {
    if (await getIdentity()) input.click();
    else showToast('Entre na sua conta para trocar a foto.', 'error');
  }));

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

    const { error } = await uploadAvatar(blob);
    if (error) showToast(error, 'error');
    else showToast('Foto de perfil atualizada!');
  });
}
