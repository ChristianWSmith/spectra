// keys.test.js — the clickable-row handlers (keys.js). A row's own action runs for a key
// or click on the row itself; a control inside the row (matched by `ignore`) keeps its own
// key and click. Run: node --test src/lib/keys.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openRow, CONTROL_SELECTOR } from './keys.js';

// A stand-in element: `closest` answers with `control` (the nested control) or null (the row).
class FakeElement {
  constructor(control = null) {
    this.control = control;
  }
  closest() {
    return this.control;
  }
}
const realElement = globalThis.Element;
globalThis.Element = FakeElement;
test.after(() => {
  globalThis.Element = realElement;
});

const key = (k, target) => {
  const e = { key: k, target, prevented: false, preventDefault() { this.prevented = true; } };
  return e;
};

test('Enter on the row runs its action', () => {
  let opened = 0;
  const row = openRow(() => opened++, { ignore: CONTROL_SELECTOR, enterOnly: true });
  const e = key('Enter', new FakeElement());
  row.onkeydown(e);
  assert.equal(opened, 1);
  assert.equal(e.prevented, true);
});

test('Enter on a control inside the row belongs to the control, not the row', () => {
  let opened = 0;
  const row = openRow(() => opened++, { ignore: CONTROL_SELECTOR, enterOnly: true });
  const e = key('Enter', new FakeElement(new FakeElement()));
  row.onkeydown(e);
  assert.equal(opened, 0, 'the row must not open for a key pressed on its name button');
  assert.equal(e.prevented, false, 'the control keeps its own default action');
});

test('a click on a control inside the row does not open the row; a click on the row does', () => {
  let opened = 0;
  const row = openRow(() => opened++, { ignore: CONTROL_SELECTOR });
  row.onclick({ target: new FakeElement(new FakeElement()) });
  assert.equal(opened, 0);
  row.onclick({ target: new FakeElement() });
  assert.equal(opened, 1);
});

test('without an ignore selector every key on the row runs the action', () => {
  let opened = 0;
  const row = openRow(() => opened++);
  row.onkeydown(key(' ', new FakeElement(new FakeElement())));
  assert.equal(opened, 1);
});
