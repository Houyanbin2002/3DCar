import { DOOR_IDS, PART_IDS, WINDOW_IDS } from '../../src/contracts/vehicle';
import type { VehicleController, VehicleSnapshot, VehicleActionResult } from '../../src/contracts/vehicle';
import type { SpeechInput, SpeechInputEvents } from '../../src/voice/speechIO';

export class SimulatedInput implements SpeechInput {
  readonly supported = true;
  private events: SpeechInputEvents | null = null;
  start(events: SpeechInputEvents) { this.events = events; events.onStart(); }
  stop() { this.events = null; }
  say(text: string) { this.events?.onTranscript({ finals: [text], interim: '' }); }
}

export function createSimulatedVehicle(): VehicleController {
  let snapshot: VehicleSnapshot = {
    ready: true, engineRunning: false,
    parts: Object.fromEntries(PART_IDS.map((id) => [id, { open: false, targetOpen: false, moving: false }])) as VehicleSnapshot['parts'],
  };
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const vehicle: VehicleController = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    attachScene() {},
    async togglePart(partId) {
      const [result] = await vehicle.execute([{ kind: 'part', partId, open: !snapshot.parts[partId].open }]);
      return result;
    },
    async execute(actions, options) {
      const results: VehicleActionResult[] = [];
      for (const action of actions) {
        const result: VehicleActionResult = { action, outcome: options?.signal?.aborted ? 'cancelled' : 'completed' };
        if (result.outcome === 'completed') {
          if (action.kind === 'engine') {
            snapshot = { ...snapshot, engineRunning: action.running };
          } else {
            const ids = action.kind === 'part' ? [action.partId] : action.group === 'doors' ? DOOR_IDS : WINDOW_IDS;
            const parts = { ...snapshot.parts };
            for (const id of ids) parts[id] = { open: action.open, targetOpen: action.open, moving: false };
            snapshot = { ...snapshot, parts };
          }
          notify();
        }
        results.push(result);
        options?.onResult?.(result);
      }
      return results;
    },
  };
  return vehicle;
}
