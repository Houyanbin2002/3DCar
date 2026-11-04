import { StrictMode, useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { PartId, VehicleSceneDriver } from '../../src/contracts/vehicle';
import { Showroom } from '../../src/scene/Showroom';
import { PartPanel } from '../../src/ui/PartPanel';
import { createVehicleController } from '../../src/vehicle/vehicleController';
import './demo.css';

function VehiclePreview() {
  const [controller] = useState(createVehicleController);
  const driver = useRef<VehicleSceneDriver | null>(null);
  const { ready } = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  const attach = useCallback((next: VehicleSceneDriver | null) => {
    driver.current = next;
    controller.attachScene(next);
  }, [controller]);

  const toggle = useCallback((id: PartId) => {
    void controller.togglePart(id);
  }, [controller]);

  return (
    <main className="vehicle-demo">
      <Showroom onDriverChange={attach} onPartClick={toggle} />
      <header className="vehicle-demo__title">
        <h1>Tesla Model 3</h1>
        <p>3D 交互展厅</p>
      </header>
      <div className="vehicle-demo__panel"><PartPanel controller={controller} /></div>
      <div className="vehicle-demo__hud">
        <span>拖动旋转 <span aria-hidden="true">·</span> 滚轮缩放</span>
        <button type="button" disabled={!ready} onClick={() => driver.current?.resetView()}>
          重置视角
        </button>
      </div>
      <footer className="vehicle-demo__credits">
        <a href={import.meta.env.BASE_URL + 'models/TESLA-LICENSE.md'} target="_blank" rel="noreferrer">
          车模 Ameer Studio · CC BY 4.0
        </a>
        <a href={import.meta.env.BASE_URL + 'models/FORMDRIVE-LICENSE.md'} target="_blank" rel="noreferrer">
          FormDrive · MIT
        </a>
      </footer>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<StrictMode><VehiclePreview /></StrictMode>);
