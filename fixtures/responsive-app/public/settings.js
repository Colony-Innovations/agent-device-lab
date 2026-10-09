// Exploration-safety page: consequential controls carry the same ARIA state attributes as harmless
// disclosure buttons, so only the audit log tells them apart.
const actionsBtn = document.getElementById('actions-btn');
const actionsMenu = document.getElementById('actions-menu');
const items = [...actionsMenu.querySelectorAll('[role="menuitem"]')];
function setActions(open) {
  actionsMenu.hidden = !open;
  actionsBtn.setAttribute('aria-expanded', String(open));
}
actionsBtn.addEventListener('click', () => {
  setActions(actionsMenu.hidden);
  if (!actionsMenu.hidden) items[0].focus();
});
for (const item of items) item.addEventListener('click', () => audit(item.dataset.audit));
actionsMenu.addEventListener('keydown', (e) => {
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
  else if (e.key === 'ArrowUp') items[(i + items.length - 1) % items.length].focus();
  else return;
  e.preventDefault();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !actionsMenu.hidden) {
    setActions(false);
    actionsBtn.focus();
  }
});

const confirmDialog = modal(document.getElementById('confirm'), document.getElementById('confirm-scrim'));
function confirmWith(btn, event, title, text) {
  btn.addEventListener('click', () => {
    audit(event);
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-text').textContent = text;
    confirmDialog.open(btn, document.getElementById('confirm-close'));
  });
}
confirmWith(document.getElementById('delete-workspace'), 'delete-workspace', 'Delete workspace?', 'This would remove the workspace and everything in it.');
confirmWith(document.getElementById('cancel-booking'), 'cancel-booking', 'Cancel booking?', 'This would cancel your booking for Friday.');
document.getElementById('confirm-close').addEventListener('click', confirmDialog.close);

document.getElementById('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  audit('form-submit');
});
document.getElementById('apply').addEventListener('click', () => audit('apply-changes'));
const advBtn = document.getElementById('adv-btn');
advBtn.addEventListener('click', () => {
  const open = advBtn.getAttribute('aria-expanded') !== 'true';
  advBtn.setAttribute('aria-expanded', String(open));
  document.getElementById('adv').hidden = !open;
});

document.getElementById('upload-avatar').addEventListener('click', () => {
  audit('upload');
  document.getElementById('avatar-file').click();
});
document.getElementById('more').addEventListener('click', () => {
  audit('more');
  document.getElementById('more-text').hidden = false;
});
document.getElementById('remove-card').addEventListener('click', () => audit('remove-card'));

const notifBtn = document.getElementById('notif-btn');
notifBtn.addEventListener('click', () => {
  const open = notifBtn.getAttribute('aria-expanded') !== 'true';
  notifBtn.setAttribute('aria-expanded', String(open));
  document.getElementById('notif').hidden = !open;
});
