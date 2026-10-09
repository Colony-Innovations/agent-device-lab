const status = document.getElementById('status');
const say = (text) => { status.textContent = text; };

const plan = document.getElementById('plan');
plan.addEventListener('change', () => say(`Plan: ${plan.selectedOptions[0].label}`));

document.getElementById('updates').addEventListener('change', (e) => say(e.target.checked ? 'Email updates on' : 'Email updates off'));

for (const radio of document.querySelectorAll('input[name="size"]')) {
  radio.addEventListener('change', () => { if (radio.checked) say(`Size: ${radio.value}`); });
}

const dark = document.getElementById('dark');
function toggleDark() {
  const on = dark.getAttribute('aria-checked') !== 'true';
  dark.setAttribute('aria-checked', String(on));
  say(on ? 'Dark mode on' : 'Dark mode off');
}
dark.addEventListener('click', toggleDark);
dark.addEventListener('keydown', (e) => {
  if (e.key === ' ') { e.preventDefault(); toggleDark(); }
});

// Same-document history: "Next step" pushes /form?step=2; Back and Forward restore either step.
const step2 = document.getElementById('step2');
const showStep = (step) => { step2.hidden = step !== 2; };
showStep(history.state?.step === 2 || new URLSearchParams(location.search).get('step') === '2' ? 2 : 1);
document.getElementById('next').addEventListener('click', () => {
  history.pushState({ step: 2 }, '', '/form?step=2');
  showStep(2);
  say('Step 2');
});
window.addEventListener('popstate', (e) => {
  const step = e.state?.step === 2 ? 2 : 1;
  showStep(step);
  say(`Step ${step}`);
});
