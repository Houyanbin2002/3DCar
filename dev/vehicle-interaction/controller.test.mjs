import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { createServer } from 'vite';

let vite;
let createVehicleController;
let PART_IDS;

before(async () => {
  vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  ({ createVehicleController } = await vite.ssrLoadModule('/src/vehicle/vehicleController.ts'));
  ({ PART_IDS } = await vite.ssrLoadModule('/src/contracts/vehicle.ts'));
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
    open: false, targetOpen: true, moving: true,
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
