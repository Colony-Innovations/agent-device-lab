const status = document.getElementById('status');
const say = (text) => { status.textContent = text; };

// Carousel: report the snapped slide once scrolling has been quiet for 150 ms.
const carousel = document.getElementById('carousel');
let scrollTimer;
carousel.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => say(`Showing photo ${Math.round(carousel.scrollLeft / carousel.clientWidth) + 1}`), 150);
});

// Swipe card: touch events, plus pointer events whose pointerType is touch.
const card = document.getElementById('swipe-card');
let start = null;
const begin = (x, y) => { start = { x, y }; };
function finish(x, y) {
  if (!start) return;
  const dx = x - start.x;
  const dy = y - start.y;
  start = null;
  if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > 50) say(dx < 0 ? 'Swiped left' : 'Swiped right');
  else if (Math.abs(dy) > 50) say(dy < 0 ? 'Swiped up' : 'Swiped down');
}
card.addEventListener('touchstart', (e) => begin(e.changedTouches[0].clientX, e.changedTouches[0].clientY));
card.addEventListener('touchend', (e) => finish(e.changedTouches[0].clientX, e.changedTouches[0].clientY));
card.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') begin(e.clientX, e.clientY); });
card.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') finish(e.clientX, e.clientY); });

// Infinite list: 10 items, then 10 more (after 200 ms) each time the sentinel is reached, up to 30.
const items = document.getElementById('items');
let count = 0;
let loading = false;
function append() {
  for (let i = 0; i < 10; i++) {
    count += 1;
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `Item ${count}`;
    li.append(button);
    items.append(li);
  }
}
append();
const observer = new IntersectionObserver((entries) => {
  if (!entries.some((entry) => entry.isIntersecting) || loading || count >= 30) return;
  loading = true;
  setTimeout(() => {
    append();
    loading = false;
    say(`Loaded ${count} items`);
    if (count >= 30) observer.disconnect();
  }, 200);
});
observer.observe(document.getElementById('sentinel'));

document.getElementById('top').addEventListener('click', () => {
  window.scrollTo(0, 0);
  say('Back at top');
});
