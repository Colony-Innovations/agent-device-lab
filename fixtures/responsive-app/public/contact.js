const email = document.getElementById('c-email');
email.addEventListener('blur', () => {
  const existing = document.getElementById('email-error');
  const value = email.value.trim();
  const invalid = value !== '' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
  if (invalid && !existing) {
    const error = document.createElement('p');
    error.id = 'email-error';
    error.className = 'field-error';
    error.setAttribute('role', 'alert');
    error.textContent = 'Enter a valid email address.';
    document.getElementById('email-field').append(error);
    email.setAttribute('aria-invalid', 'true');
    email.setAttribute('aria-describedby', 'email-error');
  } else if (!invalid) {
    existing?.remove();
    email.removeAttribute('aria-invalid');
    email.removeAttribute('aria-describedby');
  }
});
document.getElementById('contact-form').addEventListener('submit', (e) => {
  e.preventDefault();
  audit('contact-submit');
});
