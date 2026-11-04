import { DOOR_IDS, PART_IDS, WINDOW_IDS } from '../contracts/vehicle';
import type {
  ActionOutcome,
  PartId,
  PartSnapshot,
  VehicleAction,
  VehicleActionResult,
  VehicleController,
  VehicleSceneDriver,
  VehicleSnapshot,
} from '../contracts/vehicle';

function initialParts(): VehicleSnapshot['parts'] {
  return Object.fromEntries(
    PART_IDS.map((id) => [id, { open: false, targetOpen: false, moving: false }]),
  ) as Record<PartId, PartSnapshot>;
}

export function createVehicleController(): VehicleController {
  let driver: VehicleSceneDriver | null = null;
  let sceneVersion = 0;
  let snapshot: VehicleSnapshot = { ready: false, engineRunning: false, parts: initialParts() };
  const listeners = new Set<() => void>();
  const pending = new Map<PartId, Promise<ActionOutcome>>();

  function publish(next: VehicleSnapshot) {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  function setPart(id: PartId, part: PartSnapshot) {
    publish({ ...snapshot, parts: { ...snapshot.parts, [id]: part } });
  }

  async function movePart(
    id: PartId,
    open: boolean,
    version: number,
    signal?: AbortSignal,
  ): Promise<ActionOutcome> {
    const preceding = pending.get(id);
    const operation = (async (): Promise<ActionOutcome> => {
      await preceding;
      if (signal?.aborted || version !== sceneVersion) return 'cancelled';
      const activeDriver = driver;
      if (!activeDriver) return 'failed';

      const previous = snapshot.parts[id];
      if (previous.open === open) return 'already-at-target';
      setPart(id, { open: previous.open, targetOpen: open, moving: true });
      try {
        await activeDriver.setPartOpen(id, open);
      } catch {
        if (version !== sceneVersion) return 'cancelled';
        setPart(id, previous);
        return 'failed';
      }
      if (version !== sceneVersion) return 'cancelled';
      setPart(id, { open, targetOpen: open, moving: false });
      return 'completed';
    })();

    pending.set(id, operation);
    try {
      return await operation;
    } finally {
      if (pending.get(id) === operation) pending.delete(id);
    }
  }

  async function runAction(
    action: VehicleAction,
    version: number,
    signal?: AbortSignal,
  ): Promise<ActionOutcome> {
    if (signal?.aborted || version !== sceneVersion) return 'cancelled';
    if (action.kind === 'part') return movePart(action.partId, action.open, version, signal);
    if (action.kind === 'engine') {
      if (snapshot.engineRunning === action.running) return 'already-at-target';
      publish({ ...snapshot, engineRunning: action.running });
      return 'completed';
    }
    const ids = action.group === 'doors' ? DOOR_IDS : WINDOW_IDS;
    const outcomes = await Promise.all(ids.map((id) => movePart(id, action.open, version, signal)));
    if (outcomes.includes('failed')) return 'failed';
    if (outcomes.includes('cancelled')) return 'cancelled';
    return outcomes.includes('completed') ? 'completed' : 'already-at-target';
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    attachScene(next) {
      if (driver === next) return;
      driver = next;
      sceneVersion += 1;
      pending.clear();
      publish({ ...snapshot, ready: driver !== null, parts: initialParts() });
    },
    async togglePart(id) {
      const action = { kind: 'part', partId: id, open: !snapshot.parts[id].open } as const;
      const outcome = pending.has(id) ? 'cancelled' : await runAction(action, sceneVersion);
      return { action, outcome };
    },
    async execute(actions, options) {
      const version = sceneVersion;
      const results: VehicleActionResult[] = [];
      for (const action of actions) {
        const outcome = await runAction(action, version, options?.signal);
        const result = { action, outcome };
        results.push(result);
        options?.onResult?.(result);
      }
      return results;
    },
  };
}
