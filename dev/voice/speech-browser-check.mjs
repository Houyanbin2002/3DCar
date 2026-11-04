import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Real PCM -> AudioWorklet -> Worker -> real ASR/model -> actual vehicle controller.
// Only the microphone source is replaced with repeatable, locally generated WAVs.
const directory = process.env.ASR_CORPUS_DIR || join(tmpdir(), '3dcar-asr-corpus');
const amount = Number(process.env.SPEECH_AMOUNT || '1');
const dialogueMode = process.env.SPEECH_DIALOGUE === '1';
const intentMode = process.env.SPEECH_INTENT === '1';
const genericHalf = amount === 0.5;
const confirmation = !intentMode && (process.env.SPEECH_CONFIRM === '1' || genericHalf || dialogueMode);
const files = intentMode ? ['case-10.wav', 'case-21.wav', 'case-22.wav']
  : dialogueMode ? ['case-17.wav', 'case-18.wav', 'case-19.wav']
  : genericHalf ? ['case-14.wav', 'confirm.wav'] : amount === 0.25 ? ['case-13.wav']
  : confirmation ? ['case-10.wav', 'confirm.wav'] : ['case-02.wav'];
const clips = await Promise.all(files
  .map(async (file) => (await readFile(join(directory, file))).toString('base64')));
const profile = await mkdtemp(join(tmpdir(), '3dcar-speech-browser-'));
const browser = spawn(process.env.BROWSER_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let socket;
let evaluate;
const errors = [];
let modelRequests = 0;
let startupError;
browser.on('error', (error) => { startupError = error; });
async function waitFor(check, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (await check()) return;
    await delay(150);
  }
  throw new Error('Timed out: ' + check);
}

try {
  let port;
  await waitFor(async () => {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return true; }
    catch { return false; }
  });
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Network.requestWillBeSent' && message.params.request.url.endsWith('/api/intent')) modelRequests++;
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(method + ' timeout')); }, 30000);
    timer.unref();
    pending.set(key, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: key, method, params }));
  });
  evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(result.description ?? exceptionDetails.text);
    return result.value;
  };
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.bringToFront');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__audioCount = 0;
    const clips = ${JSON.stringify(clips)};
    navigator.mediaDevices.getUserMedia = async () => {
      const index = window.__audioCount++;
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const source = context.createBufferSource();
      const data = Uint8Array.from(atob(clips[Math.min(index, clips.length - 1)]), c => c.charCodeAt(0));
      source.buffer = await context.decodeAudioData(data.buffer);
      source.connect(destination);
      await context.resume();
      // The confirmation answer intentionally arrives later than the old 5s limit.
      source.start(context.currentTime + (index === 0 ? 3 : 8));
      if (${dialogueMode || intentMode} && index === 1) {
        const followup = context.createBufferSource();
        followup.buffer = await context.decodeAudioData(Uint8Array.from(atob(clips[2]), c => c.charCodeAt(0)).buffer);
        followup.connect(destination);
        followup.start(context.currentTime + 8 + source.buffer.duration + 5);
      }
      destination.stream.getAudioTracks()[0].addEventListener('ended', () => context.close());
      return destination.stream;
    };
  ` });
  await send('Page.navigate', { url: process.env.PREVIEW_URL || 'http://127.0.0.1:5173/' });
  await waitFor(() => evaluate('document.querySelector("[data-scene-ready=true]") !== null'));
  assert.equal(await evaluate('document.querySelectorAll("[data-part][data-open=true]").length'), 0);
  await evaluate(`window.__phases=[];new MutationObserver(()=>window.__phases.push(document.querySelector('.voice-panel').dataset.phase)).observe(document.querySelector('.voice-panel'),{attributes:true,attributeFilter:['data-phase']})`);
  const point = await evaluate('(()=>{const r=document.querySelector(".voice-panel__toggle").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
  if (dialogueMode || intentMode || (confirmation && !genericHalf)) {
    await waitFor(() => evaluate('document.querySelector(".voice-panel").dataset.phase === "dialogue"'));
    assert.equal(await evaluate('document.querySelectorAll("[data-part][data-open=true]").length'), 0);
    console.log('PASS real model clarification or suggestion; accepts full spoken replies without fixed confirmation words');
  }
  if (genericHalf) {
    await waitFor(() => evaluate('document.querySelector(".voice-panel").dataset.phase === "confirming"'));
    assert.equal(await evaluate('document.querySelectorAll("[data-part][data-open=true]").length'), 0, 'No vehicle action before voice consent');
    await delay(6000);
    assert.equal(await evaluate('document.querySelector(".voice-panel").dataset.phase'), 'confirming', 'Still accepts voice after 6s');
    console.log('PASS confirmation remains open beyond 5s; no manual confirmation click');
  }
  if (dialogueMode) {
    await waitFor(() => evaluate('Number(document.querySelector("[data-part=frontLeftWindow]").dataset.openness) === 0.5'));
    console.log('PASS short answer 左前车窗 directly placed only the left-front window at 50%');
    await waitFor(() => evaluate('Number(document.querySelector("[data-part=frontLeftWindow]").dataset.openness) === 0.75'));
    console.log('PASS 再低一点 retained the previous target and directly added 25%');
  } else if (intentMode) {
    await waitFor(() => evaluate('[...document.querySelectorAll("[data-openness]")].every(node=>Number(node.dataset.openness) === 1)'));
    console.log('PASS 帮我降下全部车窗吧 replaced the single-window suggestion and directly lowered all four');
    await waitFor(() => evaluate('[...document.querySelectorAll("[data-openness]")].every(node=>Number(node.dataset.openness) === 0)'));
    console.log('PASS 那你帮我升起吧 directly raised all four using dialogue context');
  } else await waitFor(() => evaluate('document.querySelectorAll("[data-part][data-open=true]").length > 0'));
  await waitFor(() => evaluate('["waiting", "dialogue"].includes(document.querySelector(".voice-panel").dataset.phase)'));
  console.log('Page feedback:', await evaluate('document.querySelector(".voice-panel").innerText'));
  assert.deepEqual(errors, []);
  if (dialogueMode || intentMode) {
    assert.equal(await evaluate('window.__phases.includes("confirming")'), false, 'No extra confirmation gate');
  }
  if (intentMode) {
    assert.equal(await evaluate('document.querySelectorAll("[data-part][data-open=true]").length'), 0);
    assert.ok(modelRequests >= 5);
    console.log('PASS real ASR + real Qwen modified intent + direct all-window actions without saying 可以');
  } else if (dialogueMode) {
    assert.equal(await evaluate('document.querySelectorAll("[data-part][data-open=true]").length'), 1);
    assert.ok(modelRequests >= 5);
    console.log('PASS real ASR + real Qwen multi-turn clarification + direct contextual control at 75%');
  } else if (genericHalf) {
    const positions = await evaluate('[...document.querySelectorAll("[data-openness]")].map(node=>Number(node.dataset.openness))');
    assert.equal(positions.length, 4);
    assert.ok(positions.every((position) => position === 0.5));
    assert.equal(modelRequests, 0, 'Fractional window confirmation stays in local rules');
    console.log('PASS real ASR + 车窗打开一半 + spoken 可以 + all four actual windows at 50%, no model request');
  } else if (confirmation) console.log('PASS real ASR + real Qwen suggestion + spoken 可以 + actual window animation');
  else {
    assert.equal(await evaluate('document.querySelector("[data-part=frontLeftWindow]").dataset.open'), 'true');
    assert.equal(await evaluate('Number(document.querySelector("[data-part=frontLeftWindow]").dataset.openness)'), amount);
    assert.equal(modelRequests, 0);
    console.log('PASS real ASR wake word + rule + actual front-left window at ' + amount * 100 + '%');
  }
} catch (error) {
  console.error(error);
  if (evaluate) console.error(await evaluate('document.body.innerText').catch(() => 'Unavailable'));
  console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  socket?.close();
  browser.kill();
}
