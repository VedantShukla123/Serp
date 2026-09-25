import { Suspense, useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Center, OrbitControls, useGLTF } from '@react-three/drei'
import * as THREE from 'three'

function EveModel() {
  const { scene } = useGLTF('/eve_ah.glb')
  const ref = useRef<THREE.Group>(null)
  // Normalize: clone, uniform-scale to ~2.4 units, recenter at origin.
  const model = useMemo(() => {
    const clone = scene.clone(true)
    const box = new THREE.Box3().setFromObject(clone)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const s = 2.4 / Math.max(size.x, size.y, size.z, 1e-6)
    clone.scale.setScalar(s)
    clone.position.sub(center.multiplyScalar(s))
    return clone
  }, [scene])
  useFrame(({ clock }) => {
    // Gentle idle life: slight sway + soft bob, never a full spin.
    const t = clock.getElapsedTime()
    if (ref.current) {
      ref.current.rotation.y = Math.sin(t * 0.5) * 0.22
      ref.current.rotation.x = Math.sin(t * 0.35) * 0.04
      ref.current.position.y = Math.sin(t * 0.8) * 0.05
    }
  })
  return (
    <group ref={ref}>
      <primitive object={model} />
    </group>
  )
}

useGLTF.preload('/eve_ah.glb')

/** Real-time 3D hero: user's eve_ah.glb, auto-spinning, draggable. */
export default function RoboViewer() {
  return (
    <Canvas
      camera={{ position: [0, 1.1, 4.4], fov: 38 }}
      gl={{ alpha: true, antialias: true }}
      dpr={[1, 2]}
    >
      <ambientLight intensity={1.0} />
      <directionalLight position={[4, 6, 4]} intensity={1.5} />
      <directionalLight position={[-4, 3, -3]} intensity={0.5} color="#c9b8ff" />
      <Suspense fallback={null}>
        <Center>
          <EveModel />
        </Center>
      </Suspense>
      <OrbitControls
        enableZoom={false}
        enablePan={false}
        minPolarAngle={Math.PI / 3.2}
        maxPolarAngle={Math.PI / 1.75}
      />
    </Canvas>
  )
}
