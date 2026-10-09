// Menu, filters drawer, deals carousel, tabs and accordion for /. None of it is consequential, so
// nothing here calls audit().
const menuBtn = document.getElementById('menu-btn');
const menu = document.getElementById('site-menu');
function setMenu(open) {
  menu.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
}
menuBtn.addEventListener('click', () => setMenu(menu.hidden));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menu.hidden) {
    setMenu(false);
    menuBtn.focus();
  }
});

const filtersBtn = document.getElementById('filters-btn');
const drawer = modal(document.getElementById('filters'), document.getElementById('filters-scrim'));
const chips = [...document.querySelectorAll('#filters .chips button')];
function pick(chip) {
  for (const c of chips) c.setAttribute('aria-pressed', String(c === chip));
}
for (const chip of chips) chip.addEventListener('click', () => pick(chip));
filtersBtn.addEventListener('click', () => drawer.open(filtersBtn, document.getElementById('filters-close')));
document.getElementById('filters-close').addEventListener('click', drawer.close);
document.getElementById('filters-reset').addEventListener('click', () => pick(chips[0]));
document.getElementById('filters-apply').addEventListener('click', drawer.close);

const track = document.getElementById('peek-track');
const slides = [...track.children];
const prev = document.getElementById('deal-prev');
const next = document.getElementById('deal-next');
let dealIndex = 0;
function showDeal() {
  const step = slides[0].offsetWidth + 12;
  track.style.setProperty('--x', `${-dealIndex * step}px`);
  slides.forEach((slide, i) => {
    const inView = i === dealIndex;
    slide.toggleAttribute('inert', !inView);
    if (inView) slide.removeAttribute('aria-hidden');
    else slide.setAttribute('aria-hidden', 'true');
  });
  prev.disabled = dealIndex === 0;
  next.disabled = dealIndex === slides.length - 1;
}
prev.addEventListener('click', () => { dealIndex -= 1; showDeal(); });
next.addEventListener('click', () => { dealIndex += 1; showDeal(); });
window.addEventListener('resize', showDeal);
showDeal();

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab, focus) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
}
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => selectTab(tab, false));
  tab.addEventListener('keydown', (e) => {
    const to = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    selectTab(tabs[to], true);
  });
});

for (const btn of document.querySelectorAll('.acc button')) {
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    document.getElementById(btn.getAttribute('aria-controls')).hidden = !open;
  });
}
