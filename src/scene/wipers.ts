import type { Object3D } from 'three';

export function bindWipers(root: Object3D) {
  const arms = ['dvorright', 'dvorleft'].map((name, index) => {
    const node = root.getObjectByName(name);
    if (!node) throw new Error('无法绑定雨刮 ' + name);
    return { node, rest: node.rotation.y, sweep: index === 0 ? -1.18 : -1.12 };
  });
  let phase = 0;
  let running = false;
  let parking: { resolve(): void; reject(error: Error): void } | null = null;

  function apply() {
    const position = (1 - Math.cos(phase * Math.PI * 2)) / 2;
    arms.forEach(({ node, rest, sweep }) => { node.rotation.y = rest + sweep * position; });
  }

  return {
    setRunning(next: boolean): Promise<void> {
      if (parking) return Promise.reject(new Error('雨刮正在归位'));
      running = next;
      if (next || phase === 0) return Promise.resolve();
      return new Promise((resolve, reject) => { parking = { resolve, reject }; });
    },
    advance(delta: number) {
      if (!running && phase === 0) return false;
      const next = phase + delta / 1.55;
      if (!running && next >= 1) {
        phase = 0;
        parking?.resolve();
        parking = null;
      } else {
        phase = next % 1;
      }
      apply();
      return true;
    },
    dispose() {
      parking?.reject(new Error('车模已卸载'));
      parking = null;
      running = false;
      phase = 0;
      apply();
    },
  };
}
