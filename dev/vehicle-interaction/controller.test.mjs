import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { createServer } from 'vite';

let vite;
let createVehicleController;
let PART_IDS;
let bindWipers;

before(async () => {
  vite = await createServer({
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  ({ createVehicleController } = await vite.ssrLoadModule('/src/vehicle/vehicleController.ts'));
  ({ PART_IDS } = await vite.ssrLoadModule('/src/contracts/vehicle.ts'));
  ({ bindWipers } = await vite.ssrLoadModule('/src/scene/wipers.ts'));
});

after(async () => { await vite?.close(); });

const partAction = (partId, open = true) => ({ kind: 'part', partId, open });

function createFakeScene() {
  const calls = [];
  const driver = {
    resetView() {},
    setPartOpen(id, open) {
      return new Promise((resolve, reject) => { calls.push({ id, open, resolve, reject }); });
    },
  };
  return { driver, calls };
}

test('all ten parts share an immutable snapshot and independently toggle', async () => {
  const controller = createVehicleController();
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => { notifications += 1; });
  const driver = { resetView() {}, async setPartOpen() {} };
  controller.attachScene(driver);
  const initial = controller.getSnapshot();
  assert.equal(controller.getSnapshot(), initial);
  assert.equal(Object.keys(initial.parts).length, 10);
  controller.attachScene(driver);
  assert.equal(notifications, 1);

  for (const id of PART_IDS) {
    assert.equal((await controller.togglePart(id)).outcome, 'completed');
    assert.equal(controller.getSnapshot().parts[id].open, true);
    assert.equal(initial.parts[id].open, false);
    assert.equal((await controller.execute([partAction(id)]))[0].outcome, 'already-at-target');
    assert.equal((await controller.togglePart(id)).outcome, 'completed');
    assert.equal(controller.getSnapshot().parts[id].open, false);
  }
  unsubscribe();
});

test('batch waits for all group members before opening the next part', async () => {
  const { driver, calls } = createFakeScene();
  const controller = createVehicleController();
  controller.attachScene(driver);
  const outcomes = [];
  const done = controller.execute(
    [{ kind: 'group', group: 'windows', open: true }, partAction('frunk')],
    { onResult: ({ outcome }) => outcomes.push(outcome) },
  );
  await flush();
  assert.equal(calls.length, 4);
  assert.deepEqual(controller.getSnapshot().parts.frontLeftWindow, {
    open: false, targetOpen: true, moving: true, openness: 0, targetOpenness: 1,
  });
  calls.slice(0, 3).forEach((call) => call.resolve());
  await flush();
  assert.deepEqual(outcomes, []);
  assert.equal(calls.length, 4);
  calls[3].resolve();
  await flush();
  assert.deepEqual(outcomes, ['completed']);
  assert.equal(calls[4].id, 'frunk');
  calls[4].resolve();
  await done;
  assert.deepEqual(outcomes, ['completed', 'completed']);
});

test('rapid repeats cancel while independent parts can move concurrently', async () => {
  const { driver, calls } = createFakeScene();
  const controller = createVehicleController();
  controller.attachScene(driver);
  const door = controller.togglePart('frontLeftDoor');
  const window = controller.togglePart('frontLeftWindow');
  const repeated = await controller.togglePart('frontLeftDoor');
  assert.equal(repeated.outcome, 'cancelled');
  assert.deepEqual(calls.map((call) => call.id), ['frontLeftDoor', 'frontLeftWindow']);
  calls.forEach((call) => call.resolve());
  await Promise.all([door, window]);
});

test('abort preserves the active movement and cancels remaining batch actions', async () => {
  const { driver, calls } = createFakeScene();
  const controller = createVehicleController();
  controller.attachScene(driver);
  const abort = new AbortController();
  const done = controller.execute([partAction('frunk'), partAction('trunk')], { signal: abort.signal });
  await flush();
  abort.abort();
  calls[0].resolve();
  assert.deepEqual((await done).map(({ outcome }) => outcome), ['completed', 'cancelled']);
  assert.deepEqual(calls.map((call) => call.id), ['frunk']);
  assert.equal(controller.getSnapshot().parts.frunk.open, true);
});

test('opposite commands for the same part wait for the active target to settle', async () => {
  const { driver, calls } = createFakeScene();
  const controller = createVehicleController();
  controller.attachScene(driver);
  const open = controller.execute([partAction('frontLeftDoor')]);
  const close = controller.execute([partAction('frontLeftDoor', false)]);
  await flush();
  assert.equal(calls.length, 1);
  calls[0].resolve();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].open, false);
  assert.equal(controller.getSnapshot().parts.frontLeftDoor.open, true);
  calls[1].resolve();
  assert.equal((await open)[0].outcome, 'completed');
  assert.equal((await close)[0].outcome, 'completed');
  assert.equal(controller.getSnapshot().parts.frontLeftDoor.open, false);
});

test('old scene completions cannot overwrite the next scene state', async () => {
  const first = createFakeScene();
  const second = createFakeScene();
  const controller = createVehicleController();
  controller.attachScene(first.driver);
  const oldAction = controller.togglePart('trunk');
  await flush();
  controller.attachScene(null);
  controller.attachScene(second.driver);
  first.calls[0].resolve();
  assert.equal((await oldAction).outcome, 'cancelled');
  assert.equal(controller.getSnapshot().parts.trunk.open, false);
  const newAction = controller.togglePart('trunk');
  await flush();
  second.calls[0].resolve();
  assert.equal((await newAction).outcome, 'completed');
  assert.equal(controller.getSnapshot().parts.trunk.open, true);
});

test('failure rolls back the part and engine commands are idempotent', async () => {
  const { driver, calls } = createFakeScene();
  const controller = createVehicleController();
  controller.attachScene(driver);
  const failed = controller.togglePart('frunk');
  await flush();
  calls[0].reject(new Error('test driver failure'));
  assert.equal((await failed).outcome, 'failed');
  assert.deepEqual(controller.getSnapshot().parts.frunk, {
    open: false, targetOpen: false, moving: false,
  });
  const run = { kind: 'engine', running: true };
  const stop = { kind: 'engine', running: false };
  const results = await controller.execute([run, run, stop]);
  assert.deepEqual(results.map(({ outcome }) => outcome), ['completed', 'already-at-target', 'completed']);
  assert.equal(controller.getSnapshot().engineRunning, false);
});

test('window gestures stop at the displayed position and can then lower fully', async () => {
  const controller = createVehicleController();
  let position = 0;
  let active;
  const targets = [];
  controller.attachScene({
    resetView() {},
    async setPartOpen() {},
    setWindowOpenness(id, target) {
      targets.push(target);
      return new Promise((resolve) => { active = { resolve }; });
    },
    getWindowOpenness() { return position; },
    stopWindowMovement() { active?.resolve(); active = undefined; },
  });
  assert.equal(controller.getSnapshot().supportsWindowGestures, true);
  const lower = controller.execute([partAction('frontLeftWindow')]);
  await flush();
  position = 1;
  active.resolve();
  await lower;

  const raise = controller.beginWindowMove('frontLeftWindow', 'raise');
  await flush();
  assert.equal(targets.at(-1), 0);
  position = 0.63;
  controller.stopWindow('frontLeftWindow');
  assert.equal(await raise, 'cancelled');
  assert.equal(controller.getSnapshot().parts.frontLeftWindow.openness, 0.63);
  assert.equal(controller.getSnapshot().parts.frontLeftWindow.moving, false);

  const lowerAgain = controller.execute([partAction('frontLeftWindow')]);
  await flush();
  assert.equal(targets.at(-1), 1);
  position = 1;
  active.resolve();
  assert.equal((await lowerAgain)[0].outcome, 'completed');
});

test('manual lowering preserves arbitrary position and a subsequent tap raises fully', async () => {
  const controller = createVehicleController();
  let position = 0;
  let active;
  const calls = [];
  controller.attachScene({
    resetView() {},
    async setPartOpen() {},
    setWindowOpenness(id, target, options) {
      calls.push({ target, manual: options.manual });
      return new Promise((resolve) => { active = { resolve }; });
    },
    getWindowOpenness() { return position; },
    stopWindowMovement() { active?.resolve(); active = undefined; },
  });
  const lower = controller.beginWindowMove('frontLeftWindow', 'lower');
  await flush();
  assert.deepEqual(calls, [{ target: 1, manual: true }]);
  position = 0.24;
  controller.stopWindow('frontLeftWindow');
  assert.equal(await lower, 'cancelled');
  assert.equal(controller.getSnapshot().parts.frontLeftWindow.openness, 0.24);
  assert.equal(controller.getSnapshot().parts.frontLeftWindow.moving, false);

  const raise = controller.execute([partAction('frontLeftWindow', false)]);
  await flush();
  assert.deepEqual(calls.at(-1), { target: 0, manual: false });
  position = 0;
  active.resolve();
  assert.equal((await raise)[0].outcome, 'completed');
  assert.equal(controller.getSnapshot().parts.frontLeftWindow.openness, 0);
});

test('releasing a queued raise prevents movement after the pointer is released', async () => {
  const controller = createVehicleController();
  let position = 0;
  let resolve;
  const targets = [];
  controller.attachScene({
    resetView() {},
    async setPartOpen() {},
    setWindowOpenness(id, target) {
      targets.push(target);
      return new Promise((done) => { resolve = done; });
    },
    getWindowOpenness() { return position; },
    stopWindowMovement() { resolve?.(); },
  });
  const lower = controller.execute([partAction('frontLeftWindow')]);
  await flush();
  position = 0.27;
  const raise = controller.beginWindowMove('frontLeftWindow', 'raise');
  controller.stopWindow('frontLeftWindow');
  assert.equal(await raise, 'cancelled');
  await lower;
  assert.deepEqual(targets, [1]);
  assert.equal(controller.getSnapshot().parts.frontLeftWindow.openness, 0.27);
});

test('invalid positions fail and legacy drivers retain full open and close', async () => {
  const controller = createVehicleController();
  const { driver, calls } = createFakeScene();
  controller.attachScene(driver);
  for (const openness of [-0.1, 1.1, NaN, Infinity]) {
    const result = await controller.execute([{ ...partAction('frontLeftWindow'), openness }]);
    assert.equal(result[0].outcome, 'failed');
  }
  const partial = await controller.execute([{ ...partAction('frontLeftWindow'), openness: 0.4 }]);
  assert.equal(partial[0].outcome, 'failed');
  assert.equal(calls.length, 0);
  assert.equal(controller.getSnapshot().supportsWindowGestures, false);
  const full = controller.execute([partAction('frontLeftWindow')]);
  await flush();
  calls[0].resolve();
  assert.equal((await full)[0].outcome, 'completed');
});

test('wiper control reports parking and completes independently from the doors', async () => {
  const controller = createVehicleController();
  let park;
  controller.attachScene({
    resetView() {},
    async setPartOpen() {},
    setWipersRunning(running) {
      return running ? Promise.resolve() : new Promise((resolve) => { park = resolve; });
    },
  });
  assert.equal(await controller.setWipersRunning(true), 'completed');
  assert.equal(controller.getSnapshot().wiperState, 'running');
  const stop = controller.setWipersRunning(false);
  await flush();
  assert.equal(controller.getSnapshot().wiperState, 'parking');
  assert.equal(await controller.setWipersRunning(true), 'cancelled');
  assert.equal((await controller.togglePart('frontLeftDoor')).outcome, 'completed');
  park();
  assert.equal(await stop, 'completed');
  assert.equal(controller.getSnapshot().wiperState, 'off');
});

test('wiper arms sweep around their own pivots and stop at their original pose', async () => {
  const { Group } = await import('three');
  const root = new Group();
  const right = new Group(); right.name = 'dvorright';
  const left = new Group(); left.name = 'dvorleft';
  root.add(right, left);
  const wipers = bindWipers(root);
  await wipers.setRunning(true);
  assert.equal(wipers.advance(0.3875), true);
  assert.ok(right.rotation.y < -0.5);
  assert.ok(left.rotation.y < -0.5);
  const stop = wipers.setRunning(false);
  wipers.advance(1.1625);
  await stop;
  assert.equal(right.rotation.y, 0);
  assert.equal(left.rotation.y, 0);
  assert.equal(wipers.advance(0.2), false);
  wipers.dispose();
});
