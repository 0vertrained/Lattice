import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { BufferGeometry, Line, LineBasicMaterial, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Walkthrough } from './types';

function CameraControls() {
  const { camera, gl, invalidate } = useThree();
  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.target.set(0, 0, 0);
    controls.minDistance = 7;
    controls.maxDistance = 24;
    controls.maxPolarAngle = Math.PI / 2.15;
    controls.enablePan = false;
    controls.addEventListener('change', () => invalidate());
    controls.update();
    return () => controls.dispose();
  }, [camera, gl, invalidate]);
  return null;
}
function Trail({ run, time }: { run: Walkthrough; time: number }) {
  const line = useMemo(() => {
    const points = run.poses.filter((p) => p.t <= time).map((p) => new Vector3(p.x, 0.05, -p.y));
    return new Line(
      new BufferGeometry().setFromPoints(points),
      new LineBasicMaterial({ color: '#83dfb8' }),
    );
  }, [run, time]);
  useEffect(
    () => () => {
      line.geometry.dispose();
      line.material.dispose();
    },
    [line],
  );
  return <primitive object={line} />;
}
export default function RecordedTwin({ run, time }: { run: Walkthrough; time: number }) {
  const pose = run.poses.findLast((p) => p.t <= time) ?? run.poses[0];
  return (
    <div className="recorded-twin">
      <div
        className="recorded-twin-canvas"
        role="img"
        aria-label="Interactive 3D reconstruction of the warehouse using recorded rover poses"
      >
        <Canvas frameloop="demand" camera={{ position: [8, 10, 10], fov: 45 }}>
          <color attach="background" args={['#0a151a']} />
          <ambientLight intensity={1.5} />
          <directionalLight position={[2, 9, 4]} intensity={2.2} />
          <CameraControls />
          <mesh position={[0, -0.08, 0]}>
            <boxGeometry args={[10, 0.12, 8]} />
            <meshStandardMaterial color="#192d34" />
          </mesh>
          <gridHelper args={[10, 20, '#3f5f65', '#243e46']} />
          <mesh position={[2, 0.65, 0]}>
            <boxGeometry args={[0.7, 1.3, 1.8]} />
            <meshStandardMaterial color="#64756f" roughness={0.8} />
          </mesh>
          <mesh position={[0, 0.6, -4]}>
            <boxGeometry args={[10, 1.2, 0.1]} />
            <meshStandardMaterial color="#35545b" transparent opacity={0.5} />
          </mesh>
          <mesh position={[-5, 0.6, 0]}>
            <boxGeometry args={[0.1, 1.2, 8]} />
            <meshStandardMaterial color="#35545b" transparent opacity={0.5} />
          </mesh>
          {[
            [0, 2.5, '#83dfb8'],
            [3.5, 0, '#e9b66c'],
            [-3, -2, '#87b8e6'],
          ].map(([x, y, color]) => (
            <mesh
              key={String(color)}
              position={[Number(x), 0.025, -Number(y)]}
              rotation={[-Math.PI / 2, 0, 0]}
            >
              <ringGeometry args={[0.3, 0.43, 40]} />
              <meshBasicMaterial color={String(color)} />
            </mesh>
          ))}
          <Trail run={run} time={time} />
          {pose && (
            <group position={[pose.x, 0.24, -pose.y]} rotation={[0, pose.yaw, 0]}>
              <mesh>
                <boxGeometry args={[0.58, 0.2, 0.38]} />
                <meshStandardMaterial color="#a0e7c7" metalness={0.2} roughness={0.4} />
              </mesh>
              <mesh position={[0.28, 0.12, 0]}>
                <boxGeometry args={[0.14, 0.12, 0.22]} />
                <meshStandardMaterial color="#e6f6f1" />
              </mesh>
              {[-0.2, 0.2].flatMap((x) =>
                [-0.25, 0.25].map((z) => (
                  <mesh key={`${x}:${z}`} position={[x, -0.08, z]} rotation={[Math.PI / 2, 0, 0]}>
                    <cylinderGeometry args={[0.12, 0.12, 0.1, 20]} />
                    <meshStandardMaterial color="#070b10" />
                  </mesh>
                )),
              )}
            </group>
          )}
        </Canvas>
      </div>
      <p className="scope-note">
        Drag to orbit · scroll to zoom. Simplified 3D reconstruction from measured poses; camera
        evidence is in the next chapter.
      </p>
      <div className="twin-stations">
        <span>● Inspection bay</span>
        <span>● Loading dock</span>
        <span>● Charging station</span>
      </div>
    </div>
  );
}
