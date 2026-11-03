import './twin.css';
import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import { BufferGeometry, Line, LineBasicMaterial, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

interface RecordedPath {
  poses: { t: number; x: number; y: number; yaw: number; body_id?: string }[];
  handoff?: { source_body_id: string; target_body_id: string };
}

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
function Trail({
  poses,
  time,
  color,
}: {
  poses: RecordedPath['poses'];
  time: number;
  color: string;
}) {
  const line = useMemo(() => {
    const points = poses.filter((p) => p.t <= time).map((p) => new Vector3(p.x, 0.05, -p.y));
    return new Line(new BufferGeometry().setFromPoints(points), new LineBasicMaterial({ color }));
  }, [poses, time, color]);
  useEffect(
    () => () => {
      line.geometry.dispose();
      line.material.dispose();
    },
    [line],
  );
  return <primitive object={line} />;
}
const tokenNames = ['film', 'paper', 'ink', 'graphite', 'rule', 'clear', 'hold', 'body'] as const;
type Tokens = Record<(typeof tokenNames)[number], string>;
const readTokens = (): Tokens => {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    tokenNames.map((name) => [name, style.getPropertyValue(`--${name}`).trim() || '#808080']),
  ) as Tokens;
};
/** The page's colour tokens, read again whenever the theme changes. */
function useTokens() {
  const [tokens, setTokens] = useState(readTokens);
  useEffect(() => {
    const observer = new MutationObserver(() => setTokens(readTokens()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return tokens;
}

export default function RecordedTwin({ run, time }: { run: RecordedPath; time: number }) {
  const tone = useTokens();
  const bodies = useMemo(
    () =>
      (run.handoff
        ? [run.handoff.source_body_id, run.handoff.target_body_id]
        : [...new Set(run.poses.map((pose) => pose.body_id ?? 'rover'))]
      ).map((id) => ({
        id,
        poses: run.poses.filter((pose) => (pose.body_id ?? 'rover') === id),
      })),
    [run],
  );
  return (
    <div className="recorded-twin">
      <div
        className="recorded-twin-canvas"
        role="img"
        aria-label="Interactive 3D reconstruction of the warehouse using recorded rover poses"
      >
        <Canvas frameloop="demand" camera={{ position: [8, 10, 10], fov: 45 }}>
          <color attach="background" args={[tone.film]} />
          <ambientLight intensity={1.5} />
          <directionalLight position={[2, 9, 4]} intensity={2.2} />
          <CameraControls />
          <mesh position={[0, -0.08, 0]}>
            <boxGeometry args={[10, 0.12, 8]} />
            <meshStandardMaterial color={tone.rule} />
          </mesh>
          <gridHelper key={tone.graphite} args={[10, 20, tone.graphite, tone.graphite]} />
          <mesh position={[2, 0.65, 0]}>
            <boxGeometry args={[0.7, 1.3, 1.8]} />
            <meshStandardMaterial color={tone.graphite} roughness={0.8} />
          </mesh>
          <mesh position={[0, 0.6, -4]}>
            <boxGeometry args={[10, 1.2, 0.1]} />
            <meshStandardMaterial color={tone.ink} transparent opacity={0.3} />
          </mesh>
          <mesh position={[-5, 0.6, 0]}>
            <boxGeometry args={[0.1, 1.2, 8]} />
            <meshStandardMaterial color={tone.ink} transparent opacity={0.3} />
          </mesh>
          {[
            [0, 2.5, tone.clear, 'bay'],
            [3.5, 0, tone.hold, 'dock'],
            [-3, -2, tone.body, 'charge'],
          ].map(([x, y, color, name]) => (
            <mesh
              key={String(name)}
              position={[Number(x), 0.025, -Number(y)]}
              rotation={[-Math.PI / 2, 0, 0]}
            >
              <ringGeometry args={[0.3, 0.43, 40]} />
              <meshBasicMaterial color={String(color)} />
            </mesh>
          ))}
          {bodies.map((body, index) => {
            const pose = body.poses.findLast((item) => item.t <= time) ?? body.poses[0];
            const color = index === 0 ? tone.ink : tone.body;
            return (
              <group key={body.id}>
                <Trail poses={body.poses} time={time} color={color} />
                {pose && (
                  <group position={[pose.x, 0.24, -pose.y]} rotation={[0, pose.yaw, 0]}>
                    <mesh>
                      <boxGeometry args={[0.58, 0.2, 0.38]} />
                      <meshStandardMaterial color={color} metalness={0.2} roughness={0.4} />
                    </mesh>
                    <mesh position={[0.28, 0.12, 0]}>
                      <boxGeometry args={[0.14, 0.12, 0.22]} />
                      <meshStandardMaterial color={tone.paper} />
                    </mesh>
                    {[-0.2, 0.2].flatMap((x) =>
                      [-0.25, 0.25].map((z) => (
                        <mesh
                          key={`${x}:${z}`}
                          position={[x, -0.08, z]}
                          rotation={[Math.PI / 2, 0, 0]}
                        >
                          <cylinderGeometry args={[0.12, 0.12, 0.1, 20]} />
                          <meshStandardMaterial color={tone.ink} />
                        </mesh>
                      )),
                    )}
                  </group>
                )}
              </group>
            );
          })}
        </Canvas>
      </div>
      <p className="scope-note">
        Drag to orbit and scroll to zoom. A simplified reconstruction from measured poses; the
        camera evidence has its own chapter.
      </p>
      <div className="twin-stations">
        <span>● Inspection bay</span>
        <span>● Loading dock</span>
        <span>● Charging station</span>
      </div>
    </div>
  );
}
