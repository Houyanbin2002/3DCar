import { SPEECH_PATH, SPEECH_SAMPLE_RATE } from '../../shared/speech';
import type { SpeechServerEvent } from '../../shared/speech';
import type { SpeechInput, SpeechInputEvents } from './speechIO';

interface Session {
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  recorder?: AudioWorkletNode;
  socket?: WebSocket;
  timer?: ReturnType<typeof setTimeout>;
}

export function speechEndpoint(): string | null {
  const configured = import.meta.env?.VITE_SPEECH_API_URL ?? import.meta.env?.VITE_INTENT_API_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured, globalThis.location?.href);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) return null;
    url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
    url.pathname = SPEECH_PATH;
    url.search = url.hash = '';
    return url.href;
  } catch { return null; }
}

export function createRealtimeSpeechInput(): SpeechInput {
  let current: Session | null = null;
  const stop = () => {
    const session = current;
    current = null;
    if (!session) return;
    clearTimeout(session.timer);
    session.recorder?.disconnect();
    session.source?.disconnect();
    session.stream?.getTracks().forEach((track) => track.stop());
    if (session.context) void session.context.close().catch(() => {});
    session.socket?.close();
  };

  const start = async (session: Session, events: SpeechInputEvents) => {
    const active = () => current === session;
    const fail = (code: string) => {
      if (!active()) return;
      stop();
      events.onError(code);
    };
    const end = () => {
      if (!active()) return;
      stop();
      events.onEnd();
    };
    const endpoint = speechEndpoint();
    if (!endpoint) { fail('unconfigured'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      if (!active()) { stream.getTracks().forEach((track) => track.stop()); return; }
      session.stream = stream;
      session.context = new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });
      await session.context.resume();
      if (!active()) return;
      await session.context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
      if (!active()) return;
      const socket = new WebSocket(endpoint);
      session.socket = socket;
      const seen = new Set<number>();
      let ready = false;
      let speaking = false;
      session.timer = setTimeout(() => fail('speech-service'), 15000);
      socket.onmessage = ({ data }) => {
        if (!active()) return;
        let event: SpeechServerEvent;
        try {
          event = JSON.parse(data);
          if (!event || typeof event !== 'object') throw new Error('Invalid speech event');
        } catch { fail('speech-service'); return; }
        switch (event.type) {
          case 'ready': {
            if (ready || !session.context) return;
            ready = true;
            clearTimeout(session.timer);
            try {
              const recorder = new AudioWorkletNode(session.context, 'pcm-recorder', {
                channelCount: 1, channelCountMode: 'explicit',
              });
              session.recorder = recorder;
              session.source = session.context.createMediaStreamSource(stream);
              recorder.onprocessorerror = () => fail('audio-capture');
              recorder.port.onmessage = ({ data: pcm }) => {
                if (!active() || socket.readyState !== WebSocket.OPEN) return;
                if (socket.bufferedAmount > 64000) { fail('network'); return; }
                try { socket.send(pcm); } catch { fail('network'); }
              };
              session.source.connect(recorder);
              recorder.connect(session.context.destination);
            } catch { fail('audio-capture'); return; }
            events.onStart();
            break;
          }
          case 'speech-start':
            if (!Number.isInteger(event.id) || seen.has(event.id)) return;
            if (!speaking) { speaking = true; events.onSpeechStart(); }
            break;
          case 'transcript':
            if (!ready || typeof event.text !== 'string' || !Number.isInteger(event.id)
              || typeof event.final !== 'boolean' || seen.has(event.id)) return;
            if (!speaking) { speaking = true; events.onSpeechStart(); }
            if (event.final) {
              seen.add(event.id);
              events.onTranscript({ finals: [event.text], interim: '' });
              speaking = false;
              events.onSpeechEnd();
            } else {
              events.onTranscript({ finals: [], interim: event.text });
            }
            break;
          case 'error': fail(event.code); break;
          case 'end': end(); break;
          default: fail('speech-service');
        }
      };
      socket.onerror = () => fail('speech-service');
      socket.onclose = () => { if (ready) end(); else fail('speech-service'); };
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      fail(name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture');
    }
  };

  return {
    supported: Boolean(typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function'
      && typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined' && typeof WebSocket !== 'undefined'),
    stop,
    start(events) {
      stop();
      const session: Session = {};
      current = session;
      void start(session, events);
    },
  };
}
