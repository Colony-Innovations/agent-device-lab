const status = document.getElementById('status');
const say = (text) => { status.textContent = text; };

const search = document.getElementById('search');
document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  say(`Searched for: ${search.value}`);
});

// The PIN is never echoed: only its length is reported.
const pin = document.getElementById('pin');
document.getElementById('pin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  say(`PIN entered (${pin.value.length} digits)`);
});

const dialog = document.getElementById('shortcuts');
const isTextField = (el) => el instanceof HTMLElement && (el.isContentEditable || el.matches('input, textarea, select'));
document.addEventListener('keydown', (e) => {
  if (e.key !== '?' || dialog.open || isTextField(e.target)) return;
  e.preventDefault();
  dialog.showModal();
  say('Shortcuts opened');
});
document.getElementById('close-shortcuts').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => say('Shortcuts closed'));
