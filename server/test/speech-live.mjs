import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const directory = process.env.ASR_CORPUS_DIR;
if (!directory) throw new Error('Set ASR_CORPUS_DIR to the generated corpus directory');
const cases = JSON.parse((await readFile(join(directory, 'corpus.json'), 'utf8')).replace(/^\uFEFF/, ''));
const endpoint = process.env.ASR_TEST_URL || 'ws://127.0.0.1:8790/api/speech';
const socket = new WebSocket(endpoint, { headers: { Origin: process.env.ASR_TEST_ORIGIN || 'http://127.0.0.1:5173' } });
let current = [];
let fatal;
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('ASR connection timed out')), 15000);
  socket.on('unexpected-response', (_request, response) => {
    clearTimeout(timer);
    reject(new Error('ASR HTTP status ' + response.statusCode));
    socket.terminate();
  });
  socket.on('error', reject);
  socket.on('message', (data) => {
    const event = JSON.parse(data.toString());
    if (event.type === 'ready') { clearTimeout(timer); resolve(); }
    if (event.type === 'error') { fatal = event.code; reject(new Error(event.code)); }
    if (event.type === 'transcript' && event.final) current.push(event.text);
  });
});

function pcmData(wav) {
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  for (let offset = 12; offset + 8 <= wav.length;) {
    const length = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') return wav.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + length % 2;
  }
  throw new Error('Missing PCM data');
}

const normalize = (text) => text.replace(/[\s\p{P}]/gu, '');
function distance(expected, actual) {
  let row = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let i = 0; i < expected.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < actual.length; j++) {
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(expected[i] !== actual[j])));
    }
    row = next;
  }
  return row.at(-1);
}

const results = [];
try {
  await ready;
  for (const item of cases) {
    current = [];
    const pcm = pcmData(await readFile(join(directory, item.file)));
    for (let offset = 0; offset < pcm.length; offset += 3200) {
      if (fatal || socket.readyState !== WebSocket.OPEN) throw new Error(fatal || 'ASR closed');
      socket.send(pcm.subarray(offset, offset + 3200));
      await delay(100);
    }
    await delay(700);
    const transcript = current.join('');
    const expected = normalize(item.text);
    const actual = normalize(transcript);
    const result = { ...item, transcript, exact: expected === actual, errors: distance(expected, actual) };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const totalCharacters = results.reduce((sum, item) => sum + normalize(item.text).length, 0);
  const errors = results.reduce((sum, item) => sum + item.errors, 0);
  const wakeCases = results.filter((item) => item.text.includes('小满同学'));
  const wakeMatches = wakeCases.filter((item) => normalize(item.transcript).includes('小满同学')).length;
  const falseWakes = results.filter((item) => !item.text.includes('小满同学') && normalize(item.transcript).includes('小满同学')).length;
  const summary = {
    samples: results.length, exactMatches: results.filter((item) => item.exact).length,
    characterAccuracy: Number((1 - errors / totalCharacters).toFixed(4)),
    wakeMatches, wakeSamples: wakeCases.length, falseWakes,
  };
  await writeFile(join(directory, 'results.json'), JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify(summary));
  assert.equal(wakeMatches, wakeCases.length, 'Wake word accuracy');
  assert.equal(falseWakes, 0, 'False wake count');
  assert.equal(summary.exactMatches, results.length, 'Full utterance transcription');
} finally { socket.close(); }
