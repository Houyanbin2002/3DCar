import { useEffect, useMemo } from 'react';
import { PlaneGeometry, Vector2 } from 'three';
import type { ShaderMaterial } from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

const floorShader = {
  name: 'ShowroomFloorReflection',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    texel: { value: new Vector2(1 / 768, 1 / 512) },
  },
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix;
    varying vec4 vReflection;
    varying vec2 vFloor;
    varying vec3 vView;

    #include <common>
    #include <logdepthbuf_pars_vertex>

    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vReflection = textureMatrix * vec4(position, 1.0);
      vFloor = position.xy;
      vView = cameraPosition - worldPosition.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 texel;
    varying vec4 vReflection;
    varying vec2 vFloor;
    varying vec3 vView;

    #include <logdepthbuf_pars_fragment>

    void main() {
      #include <logdepthbuf_fragment>
      vec2 uv = vReflection.xy / vReflection.w;
      vec2 spread = texel * (1.0 + length(vFloor) * 0.12);
      vec3 reflection = texture2D(tDiffuse, uv).rgb * 0.20;
      reflection += texture2D(tDiffuse, uv + vec2(spread.x, 0.0)).rgb * 0.12;
      reflection += texture2D(tDiffuse, uv - vec2(spread.x, 0.0)).rgb * 0.12;
      reflection += texture2D(tDiffuse, uv + vec2(0.0, spread.y)).rgb * 0.12;
      reflection += texture2D(tDiffuse, uv - vec2(0.0, spread.y)).rgb * 0.12;
      reflection += texture2D(tDiffuse, uv + spread).rgb * 0.08;
      reflection += texture2D(tDiffuse, uv - spread).rgb * 0.08;
      reflection += texture2D(tDiffuse, uv + vec2(spread.x, -spread.y)).rgb * 0.08;
      reflection += texture2D(tDiffuse, uv + vec2(-spread.x, spread.y)).rgb * 0.08;

      float fade = 1.0 - smoothstep(2.2, 6.8, length(vFloor));
      float grazing = pow(1.0 - abs(normalize(vView).y), 2.0);
      gl_FragColor = vec4(reflection, fade * mix(0.14, 0.24, grazing));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

export function ReflectiveFloor() {
  const mirror = useMemo(() => {
    const floor = new Reflector(new PlaneGeometry(30, 30), {
      textureWidth: 768,
      textureHeight: 512,
      multisample: 0,
      clipBias: 0.003,
      shader: floorShader,
    });
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.018;
    const material = floor.material as ShaderMaterial;
    material.transparent = true;
    material.depthWrite = false;
    return floor;
  }, []);

  useEffect(() => () => {
    mirror.dispose();
    mirror.geometry.dispose();
  }, [mirror]);

  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.026, 0]}>
        <planeGeometry args={[160, 160]} />
        <meshBasicMaterial color="#edf0f4" toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.022, 0]} receiveShadow>
        <planeGeometry args={[160, 160]} />
        <shadowMaterial color="#26354a" opacity={0.2} depthWrite={false} />
      </mesh>
      <primitive object={mirror} dispose={null} />
    </>
  );
}
