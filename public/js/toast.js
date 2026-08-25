const container = document.getElementById('toastContainer');

// Transient, non-blocking notification (e.g. "Fulano entrou na sala").
export function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => toast.classList.add('toast-hide'), 2500);
  setTimeout(() => toast.remove(), 3000);
}
