import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Color, Mesh, MeshBasicMaterial, PlaneGeometry, PMREMGenerator, Scene } from 'three';
import { ReflectiveFloor } from './ReflectiveFloor';

export function StudioEnvironment() {
  const { gl, scene } = useThree();

  useEffect(() => {
    const studio = new Scene();
    studio.background = new Color('#616b77');
    const definitions = [
      { size: [10, 2.4], position: [0, 6, 1], color: '#f3f6ff', strength: 5 },
      { size: [8, 1.2], position: [-5, 3, 0], color: '#d6e6ff', strength: 4 },
      { size: [7, 1.2], position: [4.5, 3.2, -2], color: '#fff1df', strength: 3.5 },
      { size: [5, 0.8], position: [0, 2.5, -6], color: '#e3efff', strength: 4 },
    ];
    const panels = definitions.map(({ size, position, color, strength }) => {
      const panel = new Mesh(
        new PlaneGeometry(size[0], size[1]),
        new MeshBasicMaterial({ color: new Color(color).multiplyScalar(strength) }),
      );
      panel.position.set(position[0], position[1], position[2]);
      panel.lookAt(0, 0.8, 0);
      return panel;
    });
    studio.add(...panels);

    const generator = new PMREMGenerator(gl);
    const environment = generator.fromScene(studio, 0.035);
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.78;
    generator.dispose();
    panels.forEach((panel) => {
      panel.geometry.dispose();
      panel.material.dispose();
    });

    const autoUpdate = gl.shadowMap.autoUpdate;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    return () => {
      scene.environment = null;
      gl.shadowMap.autoUpdate = autoUpdate;
      environment.dispose();
    };
  }, [gl, scene]);

  return (
    <>
      <color attach="background" args={['#f5f6f8']} />
      <fog attach="fog" args={['#f5f6f8', 12, 32]} />
      <hemisphereLight args={['#ffffff', '#cbd2dc', 0.95]} />
      <directionalLight position={[-5, 4, -6]} color="#dce8ff" intensity={1.3} />
      <directionalLight position={[4, 2, 5]} color="#f0f3ff" intensity={0.6} />
      <spotLight
        position={[-1.8, 7.5, 3.5]}
        color="#fff2df"
        intensity={85}
        angle={0.6}
        penumbra={1}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-radius={4}
        shadow-normalBias={0.025}
        shadow-bias={-0.00015}
      />
      <spotLight
        position={[5, 5.5, -2.5]}
        color="#dae8ff"
        intensity={45}
        angle={0.65}
        penumbra={1}
      />
      <ReflectiveFloor />
    </>
  );
}
