import { Component, Suspense, useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Canvas, useLoader } from '@react-three/fiber';
import { PCFShadowMap } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PART_IDS } from '../contracts/vehicle';
import type { PartId, ShowroomProps, VehicleSceneDriver } from '../contracts/vehicle';
import { PART_LABELS } from '../vehicle/partLabels';
import { MODEL_3_URL } from './model3Parts';
import { INITIAL_CAMERA, VehicleStage } from './VehicleStage';
import './showroom.css';

class SceneBoundary extends Component<{ children: ReactNode; retry(): void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <div className="showroom__notice" role="alert">
        <p>车模加载失败，请确认网络和浏览器的 WebGL 支持。</p>
        <button type="button" onClick={this.props.retry}>重新加载</button>
      </div>
    ) : this.props.children;
  }
}

export function Showroom({ onDriverChange, onPartClick }: ShowroomProps) {
  const buttons = useRef(new Map<PartId, HTMLButtonElement>());
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const reportDriver = useCallback((driver: VehicleSceneDriver | null) => {
    setReady(driver !== null);
    onDriverChange(driver);
  }, [onDriverChange]);

  function retry() {
    useLoader.clear(GLTFLoader, MODEL_3_URL);
    setReady(false);
    setAttempt((previous) => previous + 1);
  }

  return (
    <section className="showroom" aria-label="Model 3 车身展示" data-scene-ready={ready}>
      <SceneBoundary key={attempt} retry={retry}>
        <Canvas
          camera={{ position: INITIAL_CAMERA, fov: 30, near: 0.1, far: 70 }}
          dpr={[1, 1.6]}
          shadows={{ type: PCFShadowMap }}
          gl={{ antialias: true }}
          fallback={<p className="showroom__notice">此浏览器无法显示 WebGL 场景。</p>}
        >
          <Suspense fallback={null}>
            <VehicleStage buttons={buttons} onDriverChange={reportDriver} onPartClick={onPartClick} />
          </Suspense>
        </Canvas>
        {!ready && <p className="showroom__loading" role="status">正在准备车模</p>}
      </SceneBoundary>
      <div className="showroom__hotspots" hidden={!ready}>
        {PART_IDS.map((id) => (
          <button
            className="showroom__hotspot"
            key={id}
            type="button"
            ref={(button) => {
              if (button) buttons.current.set(id, button);
              else buttons.current.delete(id);
            }}
            data-hotspot={id}
            aria-label={PART_LABELS[id] + '热点'}
            onClick={() => onPartClick(id)}
          />
        ))}
      </div>
    </section>
  );
}
