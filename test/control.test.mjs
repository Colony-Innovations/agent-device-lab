// The supervision state machine (pause, takeover, resume, return, stop), browser-free: every
// transition, the invalid ones, when a pending change takes effect, what each mode admits, and the
// wait a scripted runner does. The Lab's side effects are covered by supervision.test.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor, CONTROL_OPS } from '../dist/core/control.js';
import { LabError } from '../dist/core/schema.js';

/** A supervisor in a given state, built only through its public transitions. */
function make(state) {
  const s = new Supervisor();
  switch (state) {
    case 'agent': break;
    case 'busy': s.begin('click'); break;
    case 'paused': s.request('pause'); break;
    case 'pausing': s.begin('click'); s.request('pause'); break;
    case 'pausing-next': s.begin('click'); s.request('pause-next'); break;
    case 'pausing-human': s.begin('click'); s.request('takeover'); break;
    case 'human': s.request('takeover'); break;
    case 'stopping': s.begin('click'); s.request('stop'); break;
    case 'stopped': s.request('stop'); break;
    default: throw new Error(`unknown state ${state}`);
  }
  return s;
}

const refused = (fn, code) => assert.throws(fn, (e) => e instanceof LabError && e.code === code, `expected ${code}`);
const code = (fn) => { try { fn(); return undefined; } catch (e) { return e.code; } };

test('a new session is under agent control, idle, with nothing to observe first', () => {
  const s = new Supervisor();
  const st = s.state;
  assert.equal(st.mode, 'agent');
  assert.equal(st.interrupt, false);
  assert.equal(st.observeRequired, false);
  assert.equal(st.humanInteractions, 0);
  assert.equal(st.busy, undefined);
  assert.equal(s.recordingHuman, false);
  assert.equal(s.shouldInterrupt(), false);
  assert.deepEqual([...CONTROL_OPS], ['pause', 'pause-next', 'resume', 'takeover', 'return', 'stop', 'emergency-stop']);
});

test('state is a copy: changing it does not change the supervisor', () => {
  const s = new Supervisor();
  s.state.mode = 'stopped';
  assert.equal(s.mode, 'agent');
});

describe('pause', () => {
  test('when idle it pauses at once', () => {
    const s = new Supervisor();
    const st = s.request('pause', 'dashboard');
    assert.equal(st.mode, 'paused');
    assert.equal(st.by, 'dashboard');
    assert.equal(st.interrupt, false);
    assert.equal(s.recordingHuman, true, 'a person may use the page while paused');
  });

  test('with a command in flight it waits for it (pausing), asks long commands to stop, and pauses when it ends', () => {
    const s = make('busy');
    const st = s.request('pause');
    assert.equal(st.mode, 'pausing');
    assert.equal(st.pending, 'paused');
    assert.equal(st.interrupt, true);
    assert.equal(s.shouldInterrupt(), true);
    assert.equal(s.recordingHuman, false, 'not paused yet: the agent is still acting');
    s.end();
    assert.equal(s.mode, 'paused');
    assert.equal(s.state.pending, undefined);
    assert.equal(s.state.interrupt, false);
    assert.equal(s.shouldInterrupt(), false, 'nothing left to interrupt once paused');
    assert.equal(s.busy, false);
  });

  test('pause-next lets the command in flight (even a whole scan) run to the end', () => {
    const s = make('busy');
    const st = s.request('pause-next');
    assert.equal(st.mode, 'pausing');
    assert.equal(st.pending, 'paused');
    assert.equal(st.interrupt, false);
    assert.equal(s.shouldInterrupt(), false, 'a scan checkpoint does not stop');
    s.end();
    assert.equal(s.mode, 'paused');
  });

  test('pause-next when idle pauses at once', () => {
    assert.equal(new Supervisor().request('pause-next').mode, 'paused');
  });

  test('a pause-next can be upgraded to pause while still pending, never downgraded', () => {
    const s = make('pausing-next');
    assert.equal(s.shouldInterrupt(), false);
    assert.equal(s.request('pause').interrupt, true);
    assert.equal(s.shouldInterrupt(), true);
    assert.equal(s.request('pause-next').interrupt, true, 'a later pause-next does not withdraw the interrupt');
    assert.equal(s.mode, 'pausing');
  });

  test('invalid when already paused, under a person\'s control, waiting for a takeover, or stopped', () => {
    for (const state of ['paused', 'human', 'pausing-human', 'stopping', 'stopped']) {
      for (const op of ['pause', 'pause-next']) {
        const s = make(state);
        const before = s.state;
        refused(() => s.request(op), 'invalid_control');
        assert.deepEqual(s.state, before, `${op} in ${state} changes nothing`);
      }
    }
  });
});

describe('takeover', () => {
  test('when idle the person has control at once', () => {
    const s = new Supervisor();
    const st = s.request('takeover');
    assert.equal(st.mode, 'human');
    assert.equal(s.recordingHuman, true);
  });

  test('with a command in flight it waits for it, interrupts long commands, then hands over', () => {
    const s = make('busy');
    const st = s.request('takeover');
    assert.equal(st.mode, 'pausing');
    assert.equal(st.pending, 'human');
    assert.equal(st.interrupt, true);
    assert.equal(s.shouldInterrupt(), true);
    s.end();
    assert.equal(s.mode, 'human');
    assert.equal(s.state.pending, undefined);
    assert.equal(s.shouldInterrupt(), false);
  });

  test('from a pause (idle) it is immediate; from a pending pause it turns the pause into a takeover', () => {
    const paused = make('paused');
    assert.equal(paused.request('takeover').mode, 'human');
    const pausing = make('pausing-next');
    const st = pausing.request('takeover');
    assert.equal(st.mode, 'pausing');
    assert.equal(st.pending, 'human');
    assert.equal(st.interrupt, true, 'a takeover always stops long commands at the next checkpoint');
    pausing.end();
    assert.equal(pausing.mode, 'human');
  });

  test('invalid when a person already has control, or the session is stopping or stopped', () => {
    for (const state of ['human', 'stopping', 'stopped']) {
      const s = make(state);
      refused(() => s.request('takeover'), 'invalid_control');
    }
  });
});

describe('resume', () => {
  test('from a pause it gives the agent control; nothing to re-observe when nobody touched the page', () => {
    const s = make('paused');
    const st = s.request('resume');
    assert.equal(st.mode, 'agent');
    assert.equal(st.observeRequired, false);
    assert.equal(s.recordingHuman, false);
    assert.equal(code(() => s.admit('click', 'act')), undefined);
  });

  test('a pause still pending is simply withdrawn; the command in flight carries on and nothing pauses when it ends', () => {
    const s = make('pausing');
    const st = s.request('resume');
    assert.equal(st.mode, 'agent');
    assert.equal(st.interrupt, false);
    assert.equal(s.shouldInterrupt(), false);
    assert.equal(s.busy, true, 'the command is still in flight');
    s.end();
    assert.equal(s.mode, 'agent');
  });

  test('after a person interacted while paused, the agent must observe before acting', () => {
    const s = make('paused');
    s.humanInteraction();
    s.humanInteraction();
    assert.equal(s.state.humanInteractions, 2);
    const st = s.request('resume');
    assert.equal(st.mode, 'agent');
    assert.equal(st.observeRequired, true);
    refused(() => s.admit('click', 'act'), 'observation_required');
    assert.equal(code(() => s.admit('observe', 'observe')), undefined);
    s.observed();
    assert.equal(s.state.observeRequired, false);
    assert.equal(s.state.humanInteractions, 0);
    assert.equal(code(() => s.admit('click', 'act')), undefined);
  });

  test('invalid from agent control, under a person (which says to use return), waiting for a takeover, or stopped', () => {
    for (const state of ['agent', 'busy', 'human', 'pausing-human', 'stopping', 'stopped']) {
      refused(() => make(state).request('resume'), 'invalid_control');
    }
    assert.throws(() => make('human').request('resume'), /use return/);
  });
});

describe('return', () => {
  test('from human control the agent must re-observe: earlier refs are stale', () => {
    const s = make('human');
    const st = s.request('return');
    assert.equal(st.mode, 'agent');
    assert.equal(st.observeRequired, true, 'even when the person did nothing the recorder saw');
    refused(() => s.admit('fill', 'act'), 'observation_required');
    s.observed();
    assert.equal(code(() => s.admit('fill', 'act')), undefined);
  });

  test('a takeover still pending (the person never had the page) can be withdrawn without a forced re-observe', () => {
    const s = make('pausing-human');
    const st = s.request('return');
    assert.equal(st.mode, 'agent');
    assert.equal(st.observeRequired, false);
    assert.equal(s.shouldInterrupt(), false);
    s.end();
    assert.equal(s.mode, 'agent');
  });

  test('invalid unless a person has (or is about to have) control', () => {
    for (const state of ['agent', 'busy', 'paused', 'pausing', 'stopping', 'stopped']) {
      refused(() => make(state).request('return'), 'invalid_control');
    }
  });
});

describe('stop and emergency stop', () => {
  test('stop when idle closes at once', () => {
    const s = new Supervisor();
    assert.equal(s.request('stop').mode, 'stopped');
    assert.equal(s.shouldInterrupt(), true);
  });

  test('stop with a command in flight lets it finish (stopping), interrupts long ones, then stops', () => {
    const s = make('busy');
    const st = s.request('stop');
    assert.equal(st.mode, 'stopping');
    assert.equal(st.pending, 'stop');
    assert.equal(s.shouldInterrupt(), true);
    s.end();
    assert.equal(s.mode, 'stopped');
  });

  test('stop works from a pause, a takeover and a pending pause; stop twice is invalid', () => {
    assert.equal(make('paused').request('stop').mode, 'stopped');
    assert.equal(make('human').request('stop').mode, 'stopped');
    assert.equal(make('pausing').request('stop').mode, 'stopping');
    refused(() => make('stopping').request('stop'), 'invalid_control');
  });

  test('emergency stop is immediate even with a command in flight, and from a pending stop', () => {
    const busy = make('busy');
    assert.equal(busy.request('emergency-stop').mode, 'stopped');
    assert.equal(busy.busy, true, 'the operation is still unwinding; it fails on its own');
    busy.end();
    assert.equal(busy.mode, 'stopped');
    assert.equal(make('stopping').request('emergency-stop').mode, 'stopped');
    assert.equal(make('human').request('emergency-stop').mode, 'stopped');
  });

  test('nothing is valid once stopped', () => {
    for (const op of CONTROL_OPS) {
      const s = make('stopped');
      assert.throws(() => s.request(op), (e) => e.code === 'invalid_control' && /stopped/.test(e.message), op);
    }
  });

  test('a stop is refused again for agent commands, with session_stopped, while stopping and after', () => {
    for (const state of ['stopping', 'stopped']) {
      const s = make(state);
      for (const kind of ['observe', 'act']) refused(() => s.admit('click', kind), 'session_stopped');
      assert.equal(code(() => s.admit('status', 'read')), undefined, 'read-only commands still answer');
    }
  });
});

describe('the invalid_control error', () => {
  test('names the operation and why, carries the mode, and is recoverable (a 409, not a crash)', () => {
    const s = make('agent');
    let err;
    try { s.request('resume'); } catch (e) { err = e; }
    assert.ok(err instanceof LabError);
    assert.equal(err.code, 'invalid_control');
    assert.match(err.message, /Cannot resume: /);
    assert.match(err.message, /agent/);
    assert.equal(err.toJSON().recoverable, true);
    assert.deepEqual(err.details, { mode: 'agent' });
  });

  test('the reason says what the session is doing', () => {
    assert.throws(() => make('paused').request('pause'), /paused/);
    assert.throws(() => make('pausing-human').request('resume'), /hand control to a person/);
    assert.throws(() => make('human').request('takeover'), /person's control/);
  });
});

describe('admit: what each mode accepts', () => {
  /** mode -> [read, observe, act] expected refusal codes (undefined = runs). */
  const table = {
    agent:          [undefined, undefined, undefined],
    busy:           [undefined, undefined, undefined],
    paused:         [undefined, undefined, 'session_paused'],
    pausing:        [undefined, undefined, 'session_paused'],
    'pausing-next': [undefined, undefined, 'session_paused'],
    human:          [undefined, 'human_control', 'human_control'],
    'pausing-human': [undefined, 'human_control', 'human_control'],
    stopping:       [undefined, 'session_stopped', 'session_stopped'],
    stopped:        [undefined, 'session_stopped', 'session_stopped'],
  };
  for (const [state, expected] of Object.entries(table)) {
    test(`${state}: read, observe, act`, () => {
      const s = make(state);
      assert.deepEqual(['read', 'observe', 'act'].map((k) => code(() => s.admit('cmd', k))), expected);
    });
  }

  test('a refusal says nothing ran and nothing is queued, names the command, and carries the control details', () => {
    const s = make('paused');
    s.request('resume');
    s.request('pause', 'dashboard');
    let err;
    try { s.admit('click', 'act'); } catch (e) { err = e; }
    const j = err.toJSON();
    assert.equal(j.code, 'session_paused');
    assert.equal(j.recoverable, true);
    assert.match(j.message, /^click refused/);
    assert.match(j.hint, /Nothing was run and nothing is queued/);
    assert.equal(j.details.control.mode, 'paused');
    assert.equal(j.details.control.by, 'dashboard');
    assert.ok(j.details.control.since);
    assert.equal(new Supervisor().state.by, undefined);
  });

  test('the human_control hint says refs from before will be stale; observation_required says to observe', () => {
    let err;
    try { make('human').admit('observe', 'observe'); } catch (e) { err = e; }
    assert.match(err.hint, /stale/);
    const s = make('human');
    s.request('return');
    try { s.admit('click', 'act'); } catch (e) { err = e; }
    assert.equal(err.code, 'observation_required');
    assert.match(err.hint, /observe/i);
  });

  test('session_stopped is recoverable: false (the agent cannot fix it)', () => {
    let err;
    try { make('stopped').admit('click', 'act'); } catch (e) { err = e; }
    assert.equal(err.toJSON().recoverable, false);
  });

  test('observed() outside a hand-back changes nothing', () => {
    const s = make('paused');
    const before = s.state;
    s.observed();
    assert.deepEqual(s.state, before);
    const a = new Supervisor();
    a.observed();
    assert.equal(a.state.observeRequired, false);
  });
});

describe('human interactions are counted only while a person can be using the page', () => {
  test('not under agent control, pausing or stopped', () => {
    for (const state of ['agent', 'busy', 'pausing', 'stopping', 'stopped']) {
      const s = make(state);
      s.humanInteraction();
      assert.equal(s.state.humanInteractions, 0, state);
    }
  });

  test('counted while paused and under human control, and cleared when the agent has control again', () => {
    for (const state of ['paused', 'human']) {
      const s = make(state);
      s.humanInteraction();
      s.humanInteraction();
      s.humanInteraction();
      assert.equal(s.state.humanInteractions, 3, state);
    }
    const s = make('paused');
    s.humanInteraction();
    s.request('resume');
    s.observed();
    assert.equal(s.state.humanInteractions, 0);
  });

  test('a pause with no interaction and a pause with one lead to different hand-backs', () => {
    const clean = make('paused');
    clean.request('resume');
    assert.equal(clean.state.observeRequired, false);
    const touched = make('paused');
    touched.humanInteraction();
    touched.request('resume');
    assert.equal(touched.state.observeRequired, true);
  });

  test('a person\'s interaction during a pause carries through a takeover and return', () => {
    const s = make('paused');
    s.humanInteraction();
    s.request('takeover');
    s.humanInteraction();
    assert.equal(s.state.humanInteractions, 2);
    s.request('return');
    assert.equal(s.state.observeRequired, true);
    assert.equal(s.state.humanInteractions, 0);
  });
});

describe('busy and end', () => {
  test('nested operations keep the outer label; the first end() ends the operation', () => {
    const s = new Supervisor();
    s.begin('scan');
    s.begin('click');
    assert.equal(s.state.busy.command, 'scan');
    assert.equal(s.busy, true);
    s.end();
    assert.equal(s.busy, false);
    s.end();                                                       // no operation in flight: nothing happens
    assert.equal(s.mode, 'agent');
  });

  test('end() with no pending change leaves the mode alone and does not emit', () => {
    const s = make('busy');
    const seen = [];
    s.onChange((c) => seen.push(c.op));
    s.end();
    assert.equal(s.mode, 'agent');
    assert.deepEqual(seen, []);
  });

  test('a pending change takes effect at end() and is announced as "settled"', () => {
    const s = make('busy');
    const seen = [];
    s.onChange((c) => seen.push([c.op, c.state.mode]));
    s.request('pause', 'dashboard');
    s.end();
    assert.deepEqual(seen, [['pause', 'pausing'], ['settled', 'paused']]);
  });

  test('whenIdle resolves at once when idle, and when the operation in flight ends (including a pending pause)', async () => {
    const idle = new Supervisor();
    await idle.whenIdle();
    const s = make('pausing');
    let done = false;
    const p = s.whenIdle().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(done, false);
    s.end();
    await p;
    assert.equal(done, true);
    assert.equal(s.mode, 'paused');
  });

  test('onChange unsubscribes', () => {
    const s = new Supervisor();
    const seen = [];
    const off = s.onChange((c) => seen.push(c.op));
    s.request('pause');
    off();
    s.request('resume');
    assert.deepEqual(seen, ['pause']);
  });

  test('"since" moves when the mode changes, not when only flags do', async () => {
    const s = make('busy');
    s.request('pause-next');
    const t1 = s.state.since;
    await new Promise((r) => setTimeout(r, 5));
    s.request('pause');                                            // upgrade: still pausing
    assert.equal(s.state.since, t1);
    await new Promise((r) => setTimeout(r, 5));
    s.end();
    assert.notEqual(s.state.since, t1);
  });
});

describe('shouldInterrupt', () => {
  test('true only while pausing with interrupt (pause, takeover) or stopping/stopped', () => {
    assert.equal(make('agent').shouldInterrupt(), false);
    assert.equal(make('busy').shouldInterrupt(), false);
    assert.equal(make('pausing').shouldInterrupt(), true);
    assert.equal(make('pausing-next').shouldInterrupt(), false);
    assert.equal(make('pausing-human').shouldInterrupt(), true);
    assert.equal(make('paused').shouldInterrupt(), false);
    assert.equal(make('human').shouldInterrupt(), false);
    assert.equal(make('stopping').shouldInterrupt(), true);
    assert.equal(make('stopped').shouldInterrupt(), true);
  });

  test('a resume clears it', () => {
    const s = make('pausing');
    s.request('resume');
    assert.equal(s.shouldInterrupt(), false);
  });
});

describe('waitForTurn (scripted runners such as flows)', () => {
  const pending = async (p) => {
    let state = 'pending';
    p.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
    await new Promise((r) => setTimeout(r, 10));
    return state;
  };

  test('resolves at once under agent control', async () => {
    await new Supervisor().waitForTurn();
    await make('busy').waitForTurn();
  });

  test('waits while paused and resolves on resume', async () => {
    const s = make('paused');
    const p = s.waitForTurn();
    assert.equal(await pending(p), 'pending');
    s.request('resume');
    await p;
  });

  test('waits while a person has control and resolves on return', async () => {
    const s = make('human');
    const p = s.waitForTurn();
    assert.equal(await pending(p), 'pending');
    s.request('return');
    await p;
  });

  test('every waiter resolves', async () => {
    const s = make('paused');
    const all = Promise.all([s.waitForTurn(), s.waitForTurn(), s.waitForTurn()]);
    s.request('resume');
    await all;
  });

  test('a pause becoming a takeover keeps waiting; only the agent having control ends the wait', async () => {
    const s = make('paused');
    const p = s.waitForTurn();
    s.request('takeover');
    assert.equal(await pending(p), 'pending');
    s.request('return');
    await p;
  });

  test('rejects with session_stopped when a person stops the session (waiting, or already stopped)', async () => {
    const s = make('paused');
    const p = s.waitForTurn();
    s.request('stop');
    await assert.rejects(p, (e) => e.code === 'session_stopped');
    await assert.rejects(make('stopped').waitForTurn(), (e) => e.code === 'session_stopped');
    await assert.rejects(make('stopping').waitForTurn(), (e) => e.code === 'session_stopped');
    const h = make('human');
    const q = h.waitForTurn();
    h.request('emergency-stop');
    await assert.rejects(q, (e) => e.code === 'session_stopped');
  });

  test('a pending stop that takes effect later still rejects a waiter that arrived meanwhile', async () => {
    const s = make('stopping');
    await assert.rejects(s.waitForTurn(), (e) => e.code === 'session_stopped');
  });
});
