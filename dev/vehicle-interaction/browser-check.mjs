import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const executable = process.env.BROWSER_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browserName = basename(executable, '.exe');
const profile = await mkdtemp(join(tmpdir(), '3dcar-browser-'));
const rendererArguments = process.env.SOFTWARE_WEBGL === '0'
  ? []
  : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'];
const browser = spawn(executable, [
  '--headless=new', '--disable-background-networking', '--no-first-run',
  '--no-default-browser-check', ...rendererArguments,
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });

let startupError;
browser.on('error', (error) => { startupError = error; });
let socket;
let send;
let evaluate;
const errors = [];

async function waitFor(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    const result = await check();
    if (result) return result;
    await delay(150);
  }
  throw new Error('Timed out waiting for ' + check);
}

async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const target = join(tmpdir(), '3dcar-' + browserName + '-' + name + '.png');
  await writeFile(target, Buffer.from(data, 'base64'));
  console.log('Screenshot', target);
}

try {
  const port = await waitFor(async () => {
    try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch { return false; }
  });
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description
        ?? message.params.exceptionDetails.text);
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Browser command timed out ' + method));
    }, 30000);
    timer.unref();
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(result.description ?? exceptionDetails.text);
    return result.value;
  };
  const mouse = (type, x, y, extra) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  const click = async (x, y) => {
    await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
    await mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 });
  };
  const drag = async (fromX, fromY, toX, toY, returnToStart = false) => {
    await mouse('mousePressed', fromX, fromY, { button: 'left', buttons: 1, clickCount: 1 });
    await mouse('mouseMoved', toX, toY, { button: 'left', buttons: 1 });
    if (returnToStart) await mouse('mouseMoved', fromX, fromY, { button: 'left', buttons: 1 });
    await mouse('mouseReleased', returnToStart ? fromX : toX, returnToStart ? fromY : toY, {
      button: 'left', buttons: 0, clickCount: 1,
    });
  };
  const choose = (text) => evaluate(
    'Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='
    + JSON.stringify(text) + ').click()',
  );
  const part = (id) => JSON.stringify('[data-part="' + id + '"]');
  const switchPart = (id) => evaluate('document.querySelector(' + part(id) + ').click()');
  const settled = (id, open) => waitFor(() => evaluate(
    'document.querySelector(' + part(id) + ')?.dataset.open==="' + open
    + '" && document.querySelector(' + part(id) + ').dataset.moving==="false"',
  ));
  const groupSettled = (open) => waitFor(() => evaluate(
    'document.querySelectorAll("[data-part][data-open=' + open + '][data-moving=false]").length===4',
  ));
  const markers = () => evaluate(
    'Array.from(document.querySelectorAll("[data-hotspot]")).filter(b=>getComputedStyle(b).visibility==="visible")'
    + '.map(b=>{const r=b.getBoundingClientRect();return [b.dataset.hotspot,Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]})',
  );
  const allClosed = () => evaluate(
    'document.querySelectorAll("[data-part][data-moving=true], [data-part][data-open=true]").length===0',
  );

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', {
    url: process.env.PREVIEW_URL || 'http://127.0.0.1:5174/dev/vehicle-interaction/',
  });
  await waitFor(() => evaluate('document.querySelector("[data-scene-ready]")?.dataset.sceneReady==="true"'));
  await waitFor(async () => (await markers()).length >= 4);
  const initial = await markers();
  await screenshot('preview');

  for (const [group, ids] of [
    ['车窗', ['frontLeftWindow', 'frontRightWindow', 'rearLeftWindow', 'rearRightWindow']],
    ['车门', ['frontLeftDoor', 'frontRightDoor', 'rearLeftDoor', 'rearRightDoor']],
    ['备箱', ['frunk', 'trunk']],
  ]) {
    await choose(group);
    for (const id of ids) {
      await switchPart(id);
      await settled(id, true);
      assert.equal(await evaluate('document.querySelectorAll("[data-part][data-open=true]").length'), 1);
      await switchPart(id);
      await settled(id, false);
    }
  }
  console.log('PASS all ten parts independently opened and closed');

  await choose('车门');
  await switchPart('frontLeftDoor');
  await settled('frontLeftDoor', true);
  await choose('车窗');
  await switchPart('frontLeftWindow');
  await settled('frontLeftWindow', true);
  const windowMarker = await waitFor(async () => (await markers()).find(([id]) => id === 'frontLeftWindow'));
  await screenshot('open-window');
  await click(windowMarker[1], windowMarker[2]);
  await settled('frontLeftWindow', false);
  await choose('车门');
  await settled('frontLeftDoor', true);
  await switchPart('frontLeftDoor');
  await settled('frontLeftDoor', false);
  console.log('PASS lowered window raised through its hotspot while the door stayed open');

  await choose('全部打开');
  await groupSettled(true);
  await choose('全部关闭');
  await groupSettled(false);
  await choose('车窗');
  await choose('全部降下');
  await groupSettled(true);
  await choose('全部升起');
  await groupSettled(false);
  console.log('PASS batch doors and windows');

  await choose('车门');
  await click(100, 155);
  assert.ok(await allClosed());
  await drag(540, 470, 720, 500, true);
  assert.ok(await allClosed());
  await mouse('mouseWheel', 480, 430, { deltaX: 0, deltaY: -370 });
  await waitFor(async () => JSON.stringify(await markers()) !== JSON.stringify(initial));
  await choose('重置视角');
  await waitFor(async () => JSON.stringify(await markers()) === JSON.stringify(initial));
  console.log('PASS blank click, drag-release protection, wheel zoom and camera reset');

  for (const [group, id] of [['车门', 'frontLeftDoor'], ['车窗', 'frontLeftWindow'], ['备箱', 'frunk']]) {
    await choose(group);
    const marker = (await markers()).find(([partId]) => partId === id);
    assert.ok(marker, 'Visible picking point for ' + id);
    const selector = JSON.stringify('[data-hotspot="' + id + '"]');
    await evaluate('document.querySelector(' + selector + ').style.pointerEvents="none"');
    await click(marker[1], marker[2]);
    await settled(id, true);
    await evaluate('document.querySelector(' + selector + ').style.pointerEvents=""');
    await switchPart(id);
    await settled(id, false);
  }
  console.log('PASS direct ray picking on door, glass and frunk');

  await drag(520, 210, 320, 210);
  let previousMarkers = '';
  let stableFrames = 0;
  await waitFor(async () => {
    await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    const current = JSON.stringify(await markers());
    stableFrames = current === previousMarkers ? stableFrames + 1 : 0;
    previousMarkers = current;
    return stableFrames >= 3;
  }, 60000);
  const trunk = (await markers()).find(([id]) => id === 'trunk');
  assert.ok(trunk, 'Rear trunk hotspot becomes visible when rotating around the car');
  await screenshot('rear');
  await evaluate('document.querySelector("[data-hotspot=trunk]").style.pointerEvents="none"');
  await click(trunk[1], trunk[2]);
  await settled('trunk', true);
  await switchPart('trunk');
  await settled('trunk', false);
  console.log('PASS rear viewpoint and direct trunk picking');
  assert.deepEqual(errors, []);
  console.log('PASS no uncaught browser errors in ' + browserName);
} catch (error) {
  console.error(error);
  console.error('Browser errors', errors);
  if (evaluate) {
    console.error('Page text', await evaluate('document.body.innerText').catch(() => 'unavailable'));
    await screenshot('failure').catch(() => {});
  }
  process.exitCode = 1;
} finally {
  socket?.close();
  browser.kill();
}
