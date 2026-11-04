export const SPEECH_PATH = '/api/speech';
export const SPEECH_SAMPLE_RATE = 16000;

export type SpeechServerEvent =
  | { type: 'ready' }
  | { type: 'speech-start'; id: number }
  | { type: 'transcript'; id: number; text: string; final: boolean }
  | { type: 'end' }
  | { type: 'error'; code: 'speech-service' | 'rate-limited' | 'audio-limit' };
