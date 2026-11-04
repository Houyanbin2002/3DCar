import { useCallback, useEffect, useRef, useState } from 'react';
import type { PartSnapshot, VehicleController, WindowId } from '../contracts/vehicle';
import { PART_LABELS } from '../vehicle/partLabels';

type Direction = 'raise' | 'lower';

interface WindowButtonProps {
  id: WindowId;
  part: PartSnapshot;
  controller: VehicleController;
  ready: boolean;
  gesturesEnabled: boolean;
}

export function WindowButton({ id, part, controller, ready, gesturesEnabled }: WindowButtonProps) {
  const hold = useRef<{
    direction: Direction;
    pointerId: number | null;
    long: boolean;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [pressed, setPressed] = useState<Direction | null>(null);
  const openness = part.openness ?? Number(part.open);
  const target = part.targetOpenness ?? Number(part.targetOpen);
  const percent = Math.round(openness * 100);
  const status = part.moving ? (target > openness ? '下降中' : '上升中')
    : percent === 0 ? '已升起' : percent === 100 ? '已降到底' : '已降下 ' + percent + '%';

  const automatic = useCallback((direction: Direction) => {
    const desired = direction === 'lower' ? 1 : 0;
    const current = controller.getSnapshot().parts[id];
    if (current.moving && current.targetOpenness === desired) return;
    controller.stopWindow?.(id);
    void controller.execute([{ kind: 'part', partId: id, open: desired === 1 }]);
  }, [controller, id]);

  const finish = useCallback((shortPress: boolean) => {
    const active = hold.current;
    if (!active) return;
    clearTimeout(active.timer);
    hold.current = null;
    setPressed(null);
    if (active.long) controller.stopWindow?.(id);
    else if (shortPress) automatic(active.direction);
  }, [automatic, controller, id]);

  useEffect(() => {
    const cancel = () => finish(false);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      const active = hold.current;
      if (active) {
        clearTimeout(active.timer);
        if (active.long) controller.stopWindow?.(id);
        hold.current = null;
      }
    };
  }, [controller, finish, id]);

  function start(direction: Direction, pointerId: number | null) {
    if (!ready || hold.current) return;
    setPressed(direction);
    const active = {
      direction,
      pointerId,
      long: false,
      timer: setTimeout(() => {
        active.long = true;
        void controller.beginWindowMove?.(id, direction);
      }, 280),
    };
    hold.current = active;
  }

  return (
    <div
      className="part-panel__part part-panel__window"
      data-part={id}
      data-open={part.open}
      data-moving={part.moving}
      data-openness={openness}
      role="group"
      aria-label={PART_LABELS[id] + '，' + status}
      title={status}
    >
      <span className="part-panel__window-name">{PART_LABELS[id]}</span>
      <div className="part-panel__rocker" role="group" aria-label={PART_LABELS[id] + '升降'}>
        {(['raise', 'lower'] as const).map((direction) => (
          <button
            key={direction}
            type="button"
            data-window-direction={direction}
            data-held={pressed === direction}
            aria-label={PART_LABELS[id] + (direction === 'raise' ? '升起' : '降下') + '，轻点自动到位，长按慢移，松开停止'}
            disabled={!ready}
            onPointerDown={(event) => {
              if (!gesturesEnabled || event.button !== 0 || !event.isPrimary || hold.current) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              start(direction, event.pointerId);
            }}
            onPointerUp={(event) => {
              if (hold.current?.pointerId === event.pointerId) finish(true);
            }}
            onPointerCancel={(event) => {
              if (hold.current?.pointerId === event.pointerId) finish(false);
            }}
            onLostPointerCapture={(event) => {
              if (hold.current?.pointerId === event.pointerId) finish(false);
            }}
            onBlur={() => {
              // The previous button blurs after pointerdown starts a press on the other direction.
              if (hold.current?.direction === direction) finish(false);
            }}
            onContextMenu={(event) => event.preventDefault()}
            onClick={(event) => {
              if (!gesturesEnabled || event.detail === 0) automatic(direction);
            }}
            onKeyDown={(event) => {
              if (gesturesEnabled && (event.key === ' ' || event.key === 'Enter')) {
                event.preventDefault();
                if (!event.repeat) start(direction, null);
              }
            }}
            onKeyUp={(event) => {
              if (gesturesEnabled && (event.key === ' ' || event.key === 'Enter')) {
                event.preventDefault();
                if (hold.current?.direction === direction) finish(true);
              }
            }}
          >
            {direction === 'raise' ? '↑ 升起' : '↓ 降下'}
          </button>
        ))}
      </div>
    </div>
  );
}
