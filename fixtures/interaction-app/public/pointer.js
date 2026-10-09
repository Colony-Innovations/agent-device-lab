const status = document.getElementById('status');
const say = (text) => { status.textContent = text; };

// Tooltip on hover.
const info = document.getElementById('info');
const tip = document.getElementById('tip');
info.addEventListener('mouseenter', () => { tip.hidden = false; say('Tooltip shown'); });
info.addEventListener('mouseleave', () => { tip.hidden = true; say('Tooltip hidden'); });

// HTML5 drag and drop: dropping a task on another moves it before the drop target.
const tasks = document.getElementById('tasks');
let dragged = null;
for (const button of tasks.querySelectorAll('button[draggable]')) {
  button.addEventListener('dragstart', (e) => {
    dragged = button.closest('li');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', button.dataset.task);
  });
  button.addEventListener('dragover', (e) => e.preventDefault());
  button.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = button.closest('li');
    if (dragged && dragged !== target) tasks.insertBefore(dragged, target);
    dragged = null;
    say(`Order: ${[...tasks.querySelectorAll('button[data-task]')].map((b) => b.dataset.task).join(', ')}`);
  });
  button.addEventListener('dragend', () => { dragged = null; });
}

// Pointer-driven slider: x across the track maps to 0-100.
const slider = document.getElementById('volume');
const thumb = slider.querySelector('.thumb');
function setFrom(x) {
  const rect = slider.getBoundingClientRect();
  const value = Math.round(Math.min(1, Math.max(0, (x - rect.left) / rect.width)) * 100);
  slider.setAttribute('aria-valuenow', String(value));
  thumb.style.left = `${value}%`;
  return value;
}
slider.addEventListener('pointerdown', (e) => {
  slider.setPointerCapture(e.pointerId);
  setFrom(e.clientX);
});
slider.addEventListener('pointermove', (e) => { if (slider.hasPointerCapture(e.pointerId)) setFrom(e.clientX); });
slider.addEventListener('pointerup', (e) => {
  const value = setFrom(e.clientX);
  if (slider.hasPointerCapture(e.pointerId)) slider.releasePointerCapture(e.pointerId);
  say(`Volume ${value}`);
});
