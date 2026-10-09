// Shared helpers. Classic script, loaded with `defer` before each page's own script.
function audit(event) {
  return fetch('/audit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event }) }).catch(() => {});
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

// A modal dialog with a scrim: locks body scroll, traps Tab, closes on Escape and restores focus.
function modal(dialog, scrim) {
  let opener = null;
  let prevOverflow = '';
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden]'));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
  function open(from, focusEl) {
    opener = from;
    prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    scrim.hidden = false;
    dialog.hidden = false;
    document.addEventListener('keydown', onKey);
    (focusEl || dialog).focus();
  }
  function close() {
    if (dialog.hidden) return;
    dialog.hidden = true;
    scrim.hidden = true;
    document.body.style.overflow = prevOverflow;
    document.removeEventListener('keydown', onKey);
    if (opener) opener.focus();
  }
  scrim.addEventListener('click', close);
  return { open, close };
}
