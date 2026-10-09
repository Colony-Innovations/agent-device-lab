// Seeded layout shift: 600 ms after load a 120 px banner is inserted at the top of main.
setTimeout(() => {
  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.textContent = 'Free delivery this week';
  document.getElementById('news-main').prepend(banner);
}, 600);
