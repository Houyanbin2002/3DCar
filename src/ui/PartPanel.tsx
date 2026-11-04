import { useSyncExternalStore } from 'react';
import { DOOR_IDS, WINDOW_IDS } from '../contracts/vehicle';
import type { PartId, VehicleController, WindowId } from '../contracts/vehicle';
import { PART_LABELS, partVerb } from '../vehicle/partLabels';
import { WindowButton } from './WindowButton';
import './part-panel.css';

const sections = [
  { id: 'doors', label: '车门', parts: DOOR_IDS, open: '全部打开', close: '全部关闭' },
  { id: 'windows', label: '车窗', parts: WINDOW_IDS, open: '全部降下', close: '全部升起' },
  { id: 'storage', label: '备箱', parts: ['frunk', 'trunk'] as const },
] as const;

export function PartPanel({ controller }: { controller: VehicleController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  return (
    <section className="part-panel" aria-label="车辆部件控制">
      <div className="part-panel__header">
        <h2>车辆控制</h2>
        <span className="part-panel__ready" data-ready={state.ready}>
          {state.ready ? '车模就绪' : '等待车模'}
        </span>
      </div>
      {sections.map((section) => {
        const ids: readonly PartId[] = section.parts;
        const busy = ids.some((id) => state.parts[id].moving);
        return (
          <section key={section.id} className="part-panel__section" data-section={section.id} aria-label={section.label}>
            <div className="part-panel__section-header">
              <h3>{section.label}</h3>
              {section.id !== 'storage' && (
                <div className="part-panel__batch" role="group" aria-label={section.label + '批量控制'}>
                  <button
                    type="button"
                    disabled={!state.ready || busy || ids.every((id) => (state.parts[id].openness ?? Number(state.parts[id].open)) === 1)}
                    onClick={() => { void controller.execute([{ kind: 'group', group: section.id, open: true }]); }}
                  >
                    {section.open}
                  </button>
                  <button
                    type="button"
                    disabled={!state.ready || busy || ids.every((id) => !state.parts[id].open)}
                    onClick={() => { void controller.execute([{ kind: 'group', group: section.id, open: false }]); }}
                  >
                    {section.close}
                  </button>
                </div>
              )}
            </div>
            <div className="part-panel__grid">
              {ids.map((id) => {
                const part = state.parts[id];
                if (section.id === 'windows') {
                  return (
                    <WindowButton
                      key={id}
                      id={id as WindowId}
                      part={part}
                      controller={controller}
                      ready={state.ready}
                      gesturesEnabled={Boolean(state.supportsWindowGestures)}
                    />
                  );
                }
                const actionLabel = partVerb(id, !part.open) + PART_LABELS[id];
                const status = part.moving ? partVerb(id, part.targetOpen) + '中' : '已' + partVerb(id, part.open);
                return (
                  <button
                    key={id}
                    className="part-panel__part"
                    type="button"
                    data-part={id}
                    data-open={part.open}
                    data-moving={part.moving}
                    aria-label={actionLabel}
                    aria-busy={part.moving}
                    aria-pressed={part.open}
                    title={status}
                    disabled={!state.ready || part.moving}
                    onClick={() => { void controller.togglePart(id); }}
                  >
                    <span>{PART_LABELS[id]}</span>
                  </button>
                );
              })}
            </div>
            {section.id === 'windows' && state.supportsWindowGestures && (
              <p className="part-panel__hint">轻点自动到位 · 长按慢移 · 松开即停</p>
            )}
          </section>
        );
      })}
      <div className="part-panel__wipers">
        <div>
          <span>雨刮</span>
          <small>{state.wiperState === 'running' ? '自动循环' : state.wiperState === 'parking' ? '正在归位' : '已关闭'}</small>
        </div>
        <button
          type="button"
          data-wipers={state.wiperState ?? 'off'}
          aria-pressed={state.wiperState === 'running'}
          aria-label={state.wiperState === 'running' ? '关闭雨刮' : '开启雨刮'}
          disabled={!state.ready || !state.supportsWipers || state.wiperState === 'parking'}
          onClick={() => { void controller.setWipersRunning?.(state.wiperState !== 'running'); }}
        >
          {state.wiperState === 'running' ? '关闭' : state.wiperState === 'parking' ? '归位中' : '开启'}
        </button>
      </div>
      <div className="part-panel__footer">
        <span>模拟动力</span>
        <span data-running={state.engineRunning}>{state.engineRunning ? '运行中' : '已熄火'}</span>
      </div>
    </section>
  );
}
