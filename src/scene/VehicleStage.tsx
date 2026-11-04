import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import {
  Matrix4, PerspectiveCamera, PMREMGenerator, Raycaster, Vector2, Vector3,
} from 'three';
import type { Intersection, Object3D } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { PartId, ShowroomProps } from '../contracts/vehicle';
import { PART_LABELS, partVerb } from '../vehicle/partLabels';
import { MODEL_3_URL } from './model3Parts';
import { prepareTesla } from './teslaModel';

export const INITIAL_CAMERA: [number, number, number] = [7.3, 2.55, 6.6];

function visibleHit(hit: Intersection) {
  for (let node: Object3D | null = hit.object; node; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}

function StudioLights() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const room = new RoomEnvironment();
    const generator = new PMREMGenerator(gl);
    const light = generator.fromScene(room, 0.06);
    scene.environment = light.texture;
    scene.environmentIntensity = 0.88;
    room.dispose();
    generator.dispose();
    const autoUpdate = gl.shadowMap.autoUpdate;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    return () => {
      scene.environment = null;
      gl.shadowMap.autoUpdate = autoUpdate;
      light.dispose();
    };
  }, [gl, scene]);

  return (
    <>
      <color attach="background" args={['#101115']} />
      <fog attach="fog" args={['#101115', 15, 37]} />
      <hemisphereLight args={['#d8e4ff', '#42434b', 0.56]} />
      <directionalLight position={[-6, 5, -5]} color="#c3d9ff" intensity={1.35} />
      <spotLight
        position={[-1.8, 6.8, 3.1]}
        color="#fff6ea"
        intensity={102}
        angle={0.54}
        penumbra={0.87}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-radius={4}
        shadow-normalBias={0.025}
        shadow-bias={-0.00015}
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.022, 0]} receiveShadow>
        <planeGeometry args={[160, 160]} />
        <meshStandardMaterial color="#1c1e24" metalness={0.06} roughness={0.92} envMapIntensity={0.18} />
      </mesh>
    </>
  );
}

type StageProps = ShowroomProps & {
  buttons: RefObject<Map<PartId, HTMLButtonElement>>;
};

export function VehicleStage({ onDriverChange, onPartClick, buttons }: StageProps) {
  const asset = useLoader(GLTFLoader, MODEL_3_URL);
  const model = useMemo(() => prepareTesla(asset.scene), [asset.scene]);
  const { camera, gl, size } = useThree();
  const orbit = useRef<OrbitControls | null>(null);
  const reportPick = useEffectEvent(onPartClick);
  const reportDriver = useEffectEvent(onDriverChange);
  const pickRay = useMemo(() => new Raycaster(), []);
  const markerRay = useMemo(() => new Raycaster(), []);
  const screen = useMemo(() => new Vector2(), []);
  const point = useMemo(() => new Vector3(), []);
  const projected = useMemo(() => new Vector3(), []);
  const direction = useMemo(() => new Vector3(), []);
  const origin = useMemo(() => new Vector3(), []);
  const visibility = useRef(new Map<PartId, boolean>());
  const visibilityDirty = useRef(true);
  const lastVisibilityUpdate = useRef(-Infinity);
  const lastCameraMatrix = useMemo(() => new Matrix4(), []);
  const lastProjection = useMemo(() => new Matrix4(), []);

  useLayoutEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return;
    const offset = size.width >= 1000 ? 0.12 : size.width >= 720 ? 0.06 : 0;
    camera.setViewOffset(size.width, size.height, size.width * offset, 0, size.width, size.height);
  }, [camera, size.height, size.width]);

  useEffect(() => {
    const canvas = gl.domElement;
    const controls = new OrbitControls(camera, canvas);
    camera.position.set(...INITIAL_CAMERA);
    controls.target.set(0, 0.77, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.enablePan = false;
    controls.minDistance = 4.5;
    controls.maxDistance = 16;
    controls.minPolarAngle = Math.PI / 8;
    controls.maxPolarAngle = Math.PI / 2 - 0.055;
    controls.update();
    orbit.current = controls;

    let press: { id: number; x: number; y: number; dragged: boolean } | null = null;
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) return;
      press = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
    };
    const move = (event: PointerEvent) => {
      if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) {
        press.dragged = true;
      }
    };
    const end = (event: PointerEvent) => {
      if (press?.id !== event.pointerId) return;
      move(event);
      const dragged = press.dragged;
      press = null;
      if (dragged || event.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom) return;
      screen.set(
        (event.clientX - rect.left) / rect.width * 2 - 1,
        -(event.clientY - rect.top) / rect.height * 2 + 1,
      );
      camera.updateMatrixWorld();
      pickRay.setFromCamera(screen, camera);
      const hit = pickRay.intersectObjects(model.meshes, false).find(visibleHit);
      const id = hit && model.owners.get(hit.object);
      if (id) reportPick(id);
    };
    const cancel = () => { press = null; };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('lostpointercapture', cancel);
    return () => {
      orbit.current = null;
      controls.dispose();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', end);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('lostpointercapture', cancel);
    };
  }, [camera, gl, model, pickRay, screen]);

  useEffect(() => {
    reportDriver({
      setPartOpen: model.setPartOpen,
      resetView: () => {
        const controls = orbit.current;
        if (!controls) return;
        controls.enableDamping = false;
        controls.update();
        camera.position.set(...INITIAL_CAMERA);
        controls.target.set(0, 0.77, 0);
        controls.update();
        controls.enableDamping = true;
      },
    });
    return () => {
      reportDriver(null);
      model.dispose();
    };
  }, [camera, model]);

  useFrame(({ clock }, delta) => {
    if (orbit.current) {
      orbit.current.dampingFactor = 1 - Math.exp(-6 * Math.min(delta, 0.25));
      orbit.current.update();
    }
    if (model.advance(delta)) {
      gl.shadowMap.needsUpdate = true;
      visibilityDirty.current = true;
    }
    camera.updateMatrixWorld();
    camera.getWorldPosition(origin);
    const cameraChanged = camera.matrixWorld.elements.some(
      (value, index) => Math.abs(value - lastCameraMatrix.elements[index]) > 1e-8,
    ) || !camera.projectionMatrix.equals(lastProjection);
    if (cameraChanged) {
      visibilityDirty.current = true;
      lastCameraMatrix.copy(camera.matrixWorld);
      lastProjection.copy(camera.projectionMatrix);
    }
    const updateVisibility = visibilityDirty.current
      && clock.elapsedTime - lastVisibilityUpdate.current > 0.075;
    if (updateVisibility) {
      lastVisibilityUpdate.current = clock.elapsedTime;
      visibilityDirty.current = false;
    }

    for (const [id, part] of model.parts) {
      const button = buttons.current.get(id);
      if (!button) continue;
      point.copy(part.anchor).applyMatrix4(part.anchorParent.matrixWorld);
      projected.copy(point).project(camera);
      const inView = Math.abs(projected.x) < 0.98 && Math.abs(projected.y) < 0.98
        && projected.z > -1 && projected.z < 1;
      if (inView && (updateVisibility || !visibility.current.has(id))) {
        direction.copy(point).sub(origin);
        markerRay.far = Math.max(0, direction.length() - 0.12);
        markerRay.set(origin, direction.normalize());
        const hit = markerRay.intersectObjects(model.meshes, false).find(visibleHit);
        visibility.current.set(id, !hit || model.owners.get(hit.object) === id);
      }
      button.style.visibility = inView && visibility.current.get(id) ? 'visible' : 'hidden';
      if (!inView) continue;
      button.style.left = (projected.x * 0.5 + 0.5) * size.width + 'px';
      button.style.top = (0.5 - projected.y * 0.5) * size.height + 'px';
      const tooltip = partVerb(id, part.progress < 0.5) + PART_LABELS[id];
      if (button.dataset.tooltip !== tooltip) button.dataset.tooltip = tooltip;
    }
  });

  return (
    <>
      <StudioLights />
      <primitive object={model.root} dispose={null} />
    </>
  );
}
