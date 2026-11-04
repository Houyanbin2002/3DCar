export const INTENT_PATH = '/api/intent';
export const INTENT_VALUES = ['ventilate', 'unsupported'] as const;

export interface IntentRequest {
  text: string;
}

export interface IntentResponse {
  intent: (typeof INTENT_VALUES)[number];
}
