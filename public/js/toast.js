const container = document.getElementById('toastContainer');

// Transient, non-blocking notification (e.g. "Fulano entrou na sala").
// type: 'info' (default) or 'error' — error gets a distinguishing accent.
export function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = type === 'error' ? 'toast toast-error' : 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => toast.classList.add('toast-hide'), 2500);
  setTimeout(() => toast.remove(), 3000);
}
