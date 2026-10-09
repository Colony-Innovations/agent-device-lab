import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedRequest, classifyControl, orderCandidates, stateSignature } from '../dist/core/explore-safety.js';

const control = (role, name, over = {}) => ({ ref: 'e1', role, name, rect: { x: 0, y: 0, w: 80, h: 40 }, ...over });
const traits = (over = {}) => ({ ref: 'e1', tag: 'button', role: '', ...over });
const none = { allow: [], deny: [] };
const classify = (c, t, cfg = none, route = '/app') => classifyControl(c, t, cfg, route);

test('deny list: skips even a control that declares a popup, and beats the allow list', () => {
  const c = control('button', 'Settings');
  const r = classify(c, traits({ haspopup: 'dialog' }), { allow: [], deny: [{ name: 'Settings' }] });
  assert.equal(r.verdict, 'skip');
  assert.match(r.reason, /explore\.deny/);
  const both = classify(c, traits(), { allow: [{ name: 'Settings' }], deny: [{ name: 'Settings' }] });
  assert.equal(both.verdict, 'skip');
  assert.match(both.reason, /explore\.deny/);
});

test('deny list honours role and route matchers', () => {
  const deny = [{ role: 'button', name: 'Danger*', route: '/admin/*' }];
  assert.equal(classify(control('button', 'Danger zone'), traits({ haspopup: 'menu' }), { allow: [], deny }, '/admin/users').verdict, 'skip');
  assert.equal(classify(control('button', 'Danger zone'), traits({ haspopup: 'menu' }), { allow: [], deny }, '/home').verdict, 'explore');
});

test('hard blocks: file choosers, external links, downloads and new tabs are skipped, even when allow-listed', () => {
  const allow = { allow: [{ name: '*' }], deny: [] };
  const file = classify(control('button', 'Choose'), traits({ file: true }), allow);
  assert.equal(file.verdict, 'skip');
  assert.match(file.reason, /upload/);
  const external = classify(control('link', 'Docs'), traits({ tag: 'a', link: 'external', haspopup: 'menu' }), allow);
  assert.equal(external.verdict, 'skip');
  assert.match(external.reason, /external/);
  const download = classify(control('link', 'Get report'), traits({ tag: 'a', download: true }), allow);
  assert.equal(download.verdict, 'skip');
  assert.match(download.reason, /download/);
  const newTab = classify(control('link', 'Help centre'), traits({ tag: 'a', newTab: true }), allow);
  assert.equal(newTab.verdict, 'skip');
  assert.match(newTab.reason, /new tab/);
  assert.equal(classify(control('link', 'Docs'), traits({ tag: 'a', link: 'external' })).verdict, 'skip', 'without the allow list too');
});

test('allow list: a plain button with no attributes is explored as allow-listed', () => {
  const r = classify(control('button', 'Filters'), traits(), { allow: [{ name: 'Filters' }], deny: [] });
  assert.equal(r.verdict, 'explore');
  assert.equal(r.kind, 'allow-listed');
});

test('consequential names are skipped whatever attributes the control has', () => {
  const cases = [
    ['Delete workspace', { haspopup: 'dialog' }], ['Remove card', { expanded: 'false' }], ['Cancel booking', {}], ['Log out', { haspopup: 'menu' }],
    ['Pay now', {}], ['Place order', { haspopup: 'dialog' }], ['Save changes', {}], ['Apply changes', { expanded: 'false' }],
    ['Upload avatar', { haspopup: 'dialog' }], ['Confirm', {}], ['Send message', { haspopup: 'dialog' }], ['Sign out', { haspopup: 'menu' }],
  ];
  for (const [name, attrs] of cases) {
    const r = classify(control('button', name), traits(attrs));
    assert.equal(r.verdict, 'skip', name);
    assert.match(r.reason, /consequential/, name);
  }
});

test('form submit and reset buttons are skipped, naming the form', () => {
  const submit = classify(control('button', 'Advanced'), traits({ submits: true, formName: 'Search' }));
  assert.equal(submit.verdict, 'skip');
  assert.match(submit.reason, /form/);
  assert.match(classify(control('button', 'Advanced'), traits({ submits: true })).reason, /form/);
  const reset = classify(control('button', 'Advanced'), traits({ resets: true }));
  assert.equal(reset.verdict, 'skip');
  assert.match(reset.reason, /reset/);
});

test('links: a plain same-origin link is not a candidate; one declaring a popup is skipped for leaving the route', () => {
  assert.equal(classify(control('link', 'Pricing'), traits({ tag: 'a', link: 'same-origin' })), undefined);
  const r = classify(control('link', 'Pricing'), traits({ tag: 'a', link: 'same-origin', haspopup: 'menu' }));
  assert.equal(r.verdict, 'skip');
  assert.match(r.reason, /route/);
});

test('attributes say what a control opens: popups, disclosures, accordions, tabs, toggles', () => {
  const kind = (name, t, role = 'button') => { const r = classify(control(role, name), traits(t)); return r && `${r.verdict}:${r.kind ?? ''}`; };
  assert.equal(kind('Advanced', { haspopup: 'menu' }), 'explore:menu');
  assert.equal(kind('Advanced', { haspopup: 'dialog' }), 'explore:dialog');
  assert.equal(kind('Advanced', { haspopup: 'true' }), 'explore:menu');
  assert.equal(kind('Advanced', { expanded: 'false' }), 'explore:disclosure');
  assert.equal(kind('Advanced', { expanded: 'false', tag: 'summary' }), 'explore:accordion');
  assert.equal(kind('Advanced', { expanded: 'true' }), undefined, 'already open');
  assert.equal(kind('Advanced', { closedDetails: true, tag: 'summary' }), 'explore:accordion');
  assert.equal(kind('Overview', { role: 'tab', selected: 'false' }, 'tab'), 'explore:tab');
  assert.equal(kind('Overview', { role: 'tab', selected: 'true' }, 'tab'), undefined, 'the selected tab is already showing');
  assert.equal(kind('Advanced', { controlsHidden: true }), 'explore:disclosure');
  assert.equal(kind('In stock', { pressed: 'false' }), 'explore:toggle');
});

test('menu items and ambiguous buttons are skipped with a reason; unremarkable buttons are not recorded', () => {
  const item = classify(control('menuitem', 'Item one'), traits({ role: 'menuitem' }));
  assert.equal(item.verdict, 'skip');
  assert.match(item.reason, /purpose cannot be determined/);
  for (const name of ['More', 'Filters', '']) {
    const r = classify(control('button', name), traits());
    assert.equal(r.verdict, 'skip', `"${name}"`);
    assert.match(r.reason, /purpose ambiguous/);
    assert.match(r.reason, /scan\.explore\.allow/);
  }
  assert.equal(classify(control('button', 'Chat'), traits()), undefined);
});

test('disabled controls and text fields are not candidates', () => {
  assert.equal(classify(control('button', 'Advanced', { disabled: true }), traits({ haspopup: 'menu' })), undefined);
  assert.equal(classify(control('textbox', 'Search'), traits({ tag: 'input' })), undefined);
  assert.equal(classify(control('searchbox', 'Find'), traits({ tag: 'input' })), undefined);
});

test('missing traits: safety cannot be determined, so skip', () => {
  const r = classify(control('button', 'Advanced'), undefined);
  assert.equal(r.verdict, 'skip');
  assert.match(r.reason, /cannot be determined/);
});

test('decisions carry the control identity, including its context', () => {
  const r = classify(control('button', 'Options', { context: 'Card A' }), traits({ haspopup: 'menu' }));
  assert.deepEqual([r.role, r.name, r.context], ['button', 'Options', 'Card A']);
});

// ---------- ordering ----------

test('orderCandidates: allow-listed, dialog, menu, disclosure, accordion, tab, toggle; stable within a kind', () => {
  const items = [
    { n: 'toggle', kind: 'toggle' }, { n: 'accordion', kind: 'accordion' }, { n: 'disclosure', kind: 'disclosure' }, { n: 'menu-1', kind: 'menu' },
    { n: 'dialog', kind: 'dialog' }, { n: 'allow', kind: 'allow-listed' }, { n: 'tab', kind: 'tab' }, { n: 'menu-2', kind: 'menu' },
  ];
  assert.deepEqual(orderCandidates(items).map((i) => i.n), ['allow', 'dialog', 'menu-1', 'menu-2', 'disclosure', 'accordion', 'tab', 'toggle']);
  assert.equal(items[0].n, 'toggle', 'the input is not mutated');
});

// ---------- state signature ----------

const state = (over = {}) => ({ route: '/app', headings: ['Home'], controls: [control('button', 'Menu', { expanded: false }), control('textbox', 'Name')], ...over });

test('stateSignature: changes with route, dialog, headings, control state and names', () => {
  const base = stateSignature(state());
  assert.notEqual(stateSignature(state({ route: '/other' })), base);
  assert.notEqual(stateSignature(state({ dialog: 'Settings' })), base);
  assert.notEqual(stateSignature(state({ headings: ['Home', 'More'] })), base);
  for (const key of ['expanded', 'pressed', 'checked', 'selected']) {
    const open = state({ controls: [control('button', 'Menu', { [key]: true })] });
    const closed = state({ controls: [control('button', 'Menu', { [key]: false })] });
    assert.notEqual(stateSignature(open), stateSignature(closed), key);
  }
  assert.notEqual(stateSignature(state({ controls: [control('button', 'Menus', { expanded: false }), control('textbox', 'Name')] })), base);
});

test('stateSignature: ignores typed values and refs', () => {
  const base = stateSignature(state());
  const typed = state({ controls: [control('button', 'Menu', { expanded: false, ref: 'e77' }), control('textbox', 'Name', { value: 'Ada', ref: 'e78' })] });
  assert.equal(stateSignature(typed), base);
});

// ---------- request guard ----------

const ORIGIN = 'http://localhost:5199';

test('blockedRequest: same-origin reads pass', () => {
  assert.equal(blockedRequest('GET', `${ORIGIN}/api/items`, false, ORIGIN), undefined);
  assert.equal(blockedRequest('GET', `${ORIGIN}/page`, true, ORIGIN), undefined);
});

test('blockedRequest: writes are blocked and labelled with method and path', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(blockedRequest(method, `${ORIGIN}/api/items/3?x=1`, false, ORIGIN), `${method} /api/items/3`);
  }
  assert.match(blockedRequest('POST', 'https://api.example.test/v1/save', false, ORIGIN), /^POST .*api\.example\.test.*\/v1\/save/);
});

test('blockedRequest: navigating to another origin is blocked; sub-resources from other origins are not', () => {
  assert.equal(blockedRequest('GET', 'https://other.test/page', true, ORIGIN), 'navigation to https://other.test');
  assert.equal(blockedRequest('GET', 'https://cdn.test/app.js', false, ORIGIN), undefined);
});

test('blockedRequest: data and blob URLs are never blocked', () => {
  assert.equal(blockedRequest('GET', 'data:text/plain,hi', false, ORIGIN), undefined);
  assert.equal(blockedRequest('GET', 'blob:http://localhost:5199/abc', true, ORIGIN), undefined);
});
