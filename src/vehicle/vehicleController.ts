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
  WindowId,
  WindowOpenness,
} from '../contracts/vehicle';

const windowIds = new Set<PartId>(WINDOW_IDS);

function initialParts(): VehicleSnapshot['parts'] {
  return Object.fromEntries(
    PART_IDS.map((id) => [id, {
      open: false,
      targetOpen: false,
      moving: false,
      ...(windowIds.has(id) ? { openness: 0, targetOpenness: 0 } : {}),
    }]),
  ) as Record<PartId, PartSnapshot>;
}

export function createVehicleController(): VehicleController {
  let driver: VehicleSceneDriver | null = null;
  let sceneVersion = 0;
  let snapshot: VehicleSnapshot = { ready: false, engineRunning: false, parts: initialParts() };
  const listeners = new Set<() => void>();
  const pending = new Map<PartId, Promise<ActionOutcome>>();
  let wiperRequest: Promise<ActionOutcome> | null = null;
  const gestures = new Map<WindowId, AbortController>();

  function publish(next: VehicleSnapshot) {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  function setPart(id: PartId, part: PartSnapshot) {
    publish({ ...snapshot, parts: { ...snapshot.parts, [id]: part } });
  }

  async function movePart(
    id: PartId,
    target: WindowOpenness,
    version: number,
    signal?: AbortSignal,
    manual = false,
  ): Promise<ActionOutcome> {
    const preceding = pending.get(id);
    const operation = (async (): Promise<ActionOutcome> => {
      await preceding;
      if (signal?.aborted || version !== sceneVersion) return 'cancelled';
      const activeDriver = driver;
      if (!activeDriver) return 'failed';
      if (target > 0 && target < 1 && !activeDriver.setWindowOpenness) return 'failed';

      const previous = snapshot.parts[id];
      if ((previous.openness ?? Number(previous.open)) === target) return 'already-at-target';
      const isWindow = windowIds.has(id);
      setPart(id, {
        ...previous,
        targetOpen: target > 0,
        moving: true,
        ...(isWindow ? { targetOpenness: target } : {}),
      });
      let actual = target;
      try {
        if (isWindow && activeDriver.setWindowOpenness) {
          await activeDriver.setWindowOpenness(id as WindowId, target, { manual });
        } else {
          await activeDriver.setPartOpen(id, target === 1);
        }
        if (isWindow && activeDriver.getWindowOpenness) {
          actual = activeDriver.getWindowOpenness(id as WindowId);
          if (!Number.isFinite(actual) || actual < 0 || actual > 1) {
            throw new Error('Invalid window position from scene');
          }
        }
      } catch {
        if (version !== sceneVersion) return 'cancelled';
        setPart(id, previous);
        return 'failed';
      }
      if (version !== sceneVersion) return 'cancelled';
      setPart(id, {
        open: actual > 0,
        targetOpen: actual > 0,
        moving: false,
        ...(isWindow ? { openness: actual, targetOpenness: actual } : {}),
      });
      return Math.abs(actual - target) < 0.0001 ? 'completed' : 'cancelled';
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
    if (action.kind === 'engine') {
      if (snapshot.engineRunning === action.running) return 'already-at-target';
      publish({ ...snapshot, engineRunning: action.running });
      return 'completed';
    }
    const target = action.openness ?? (action.open ? 1 : 0);
    const isWindow = action.kind === 'part'
      ? windowIds.has(action.partId)
      : action.group === 'windows';
    if (action.openness !== undefined && (
      !isWindow || !Number.isFinite(target) || target < 0 || target > 1 || action.open !== (target > 0)
    )) return 'failed';
    if (action.kind === 'part') return movePart(action.partId, target, version, signal);
    const ids = action.group === 'doors' ? DOOR_IDS : WINDOW_IDS;
    const outcomes = await Promise.all(ids.map((id) => movePart(id, target, version, signal)));
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
      gestures.forEach((gesture) => gesture.abort());
      gestures.clear();
      wiperRequest = null;
      publish({
        ...snapshot,
        ready: driver !== null,
        supportsWindowGestures: Boolean(driver?.setWindowOpenness
          && driver.stopWindowMovement && driver.getWindowOpenness),
        supportsWipers: typeof driver?.setWipersRunning === 'function',
        wiperState: 'off',
        parts: initialParts(),
      });
    },
    async togglePart(id) {
      const action = { kind: 'part', partId: id, open: !snapshot.parts[id].open } as const;
      const outcome = pending.has(id) ? 'cancelled' : await runAction(action, sceneVersion);
      return { action, outcome };
    },
    async beginWindowMove(id, direction) {
      const activeDriver = driver;
      if (!activeDriver?.setWindowOpenness || !activeDriver.stopWindowMovement
        || !activeDriver.getWindowOpenness) return 'failed';
      const version = sceneVersion;
      gestures.get(id)?.abort();
      const token = new AbortController();
      gestures.set(id, token);
      activeDriver.stopWindowMovement(id);
      await pending.get(id);
      if (version !== sceneVersion || gestures.get(id) !== token) return 'cancelled';
      try {
        return await movePart(id, direction === 'raise' ? 0 : 1, version, token.signal, true);
      } finally {
        if (gestures.get(id) === token) gestures.delete(id);
      }
    },
    stopWindow(id) {
      gestures.get(id)?.abort();
      gestures.delete(id);
      driver?.stopWindowMovement?.(id);
    },
    async setWipersRunning(running) {
      if (wiperRequest) return 'cancelled';
      const version = sceneVersion;
      const operation = (async (): Promise<ActionOutcome> => {
        await Promise.resolve();
        if (version !== sceneVersion) return 'cancelled';
        const activeDriver = driver;
        if (!activeDriver?.setWipersRunning) return 'failed';
        const previous = snapshot.wiperState ?? 'off';
        if (running === (previous === 'running')) return 'already-at-target';
        publish({ ...snapshot, wiperState: running ? 'running' : 'parking' });
        try {
          await activeDriver.setWipersRunning(running);
        } catch {
          if (version !== sceneVersion) return 'cancelled';
          publish({ ...snapshot, wiperState: previous });
          return 'failed';
        }
        if (version !== sceneVersion) return 'cancelled';
        publish({ ...snapshot, wiperState: running ? 'running' : 'off' });
        return 'completed';
      })();
      wiperRequest = operation;
      try {
        return await operation;
      } finally {
        if (wiperRequest === operation) wiperRequest = null;
      }
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
