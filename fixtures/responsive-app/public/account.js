// The dialog has no max-height and no scrolling, so on short viewports its footer is unreachable.
const editBtn = document.getElementById('edit-profile');
const dlg = modal(document.getElementById('profile'), document.getElementById('profile-scrim'));
editBtn.addEventListener('click', () => dlg.open(editBtn, document.getElementById('p-first')));
document.getElementById('profile-cancel').addEventListener('click', dlg.close);
document.getElementById('profile-form').addEventListener('submit', (e) => {
  e.preventDefault();
  audit('save-profile');
});
