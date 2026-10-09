// Invoice fixture behaviour. State lives in localStorage so each fresh browser context starts
// with the same two seeded invoices.
const STORE_KEY = 'invoice-fixture:v1';
const SEED = [
  { id: 'INV-001', customer: 'Globex', amount: 1200, status: 'Open' },
  { id: 'INV-002', customer: 'Initech', amount: 450, status: 'Paid' },
];

const load = () => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) ?? structuredClone(SEED); } catch { return structuredClone(SEED); }
};
const save = (invoices) => localStorage.setItem(STORE_KEY, JSON.stringify(invoices));
const money = (n) => `$${n.toFixed(2)}`;
const $ = (sel) => document.querySelector(sel);
// Tell the server what happened, for its optional audit log. Fire-and-forget.
const report = (event) => fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) }).catch(() => {});

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.textContent = ''; }, 8000);
}

function invoicesPage() {
  let invoices = load();
  const list = $('#invoice-list');
  const dialog = $('#create-dialog');
  const form = $('#create-form');
  const customer = $('#customer');
  const amount = $('#amount');
  const error = $('#form-error');
  const saveButton = $('#save');

  const render = () => {
    list.replaceChildren(...invoices.map((inv) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `/invoices/${inv.id}`;
      a.textContent = `${inv.id} ${inv.customer} · ${money(inv.amount)} · ${inv.status}`;
      li.append(a);
      return li;
    }));
  };

  const showError = (field, message) => {
    for (const f of [customer, amount]) f.removeAttribute('aria-invalid');
    field.setAttribute('aria-invalid', 'true');
    error.textContent = message;
    field.focus();
  };

  $('#new-invoice').addEventListener('click', () => {
    form.reset();
    error.textContent = '';
    for (const f of [customer, amount]) f.removeAttribute('aria-invalid');
    dialog.showModal();
    customer.focus();
  });
  $('#cancel').addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = customer.value.trim();
    const value = Number(amount.value);
    if (!name) return showError(customer, 'Customer is required');
    if (!amount.value.trim() || !Number.isFinite(value) || value <= 0) return showError(amount, 'Amount must be a positive number');

    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    const next = Math.max(...invoices.map((i) => Number(i.id.slice(4)))) + 1;
    const invoice = { id: `INV-${String(next).padStart(3, '0')}`, customer: name, amount: value, status: 'Open' };
    await fetch('/api/invoices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invoice) });
    invoices = [...invoices, invoice];
    save(invoices);
    render();
    saveButton.disabled = false;
    saveButton.textContent = 'Save';
    dialog.close();
    toast(`Invoice ${invoice.id} created`);
  });

  render();
}

function invoicePage() {
  const invoices = load();
  const id = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop());
  const invoice = invoices.find((i) => i.id === id);
  const button = $('#mark-paid');
  if (!invoice) {
    $('#invoice-title').textContent = 'Invoice not found';
    button.hidden = true;
    return;
  }
  const render = () => {
    document.title = `${invoice.id} · Fixture`;
    $('#invoice-title').textContent = invoice.id;
    $('#invoice-customer').textContent = invoice.customer;
    $('#invoice-amount').textContent = money(invoice.amount);
    $('#invoice-status').textContent = invoice.status;
    button.disabled = invoice.status === 'Paid';
  };
  button.addEventListener('click', () => {
    invoice.status = 'Paid';
    save(invoices);
    render();
    toast(`${invoice.id} marked as paid`);
    report({ type: 'invoice.paid', id: invoice.id, customer: invoice.customer, amount: invoice.amount });
  });
  render();
}

function reportsPage() {
  const invoices = load();
  const total = invoices.reduce((sum, i) => sum + i.amount, 0);
  $('#report-summary').textContent = `${invoices.length} invoices totalling ${money(total)}`;
  $('#export').addEventListener('click', () => {
    toast(`Export ready: ${invoices.length} invoices`);
    report({ type: 'report.exported', count: invoices.length });
  });
}

({ invoices: invoicesPage, invoice: invoicePage, reports: reportsPage })[document.body.dataset.page]?.();
