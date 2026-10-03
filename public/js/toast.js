const container = document.getElementById('toastContainer');

// Transient, non-blocking notification (e.g. "Fulano entrou na sala").
// type: 'info' (default) or 'error' — error gets a distinguishing accent.
// onClick makes the toast clickable and keeps it up longer.
export function showToast(message, type = 'info', { onClick, duration = 2500 } = {}) {
  const toast = document.createElement('div');
  toast.className = type === 'error' ? 'toast toast-error' : 'toast';
  toast.textContent = message;
  if (onClick) {
    toast.classList.add('toast-action');
    toast.addEventListener('click', () => {
      onClick();
      toast.remove();
    });
  }
  container.appendChild(toast);

  setTimeout(() => toast.classList.add('toast-hide'), duration);
  setTimeout(() => toast.remove(), duration + 500);
}
