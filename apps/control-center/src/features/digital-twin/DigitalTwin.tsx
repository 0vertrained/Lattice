import { Canvas } from '@react-three/fiber';
import type { Body } from '../../core/api/schemas';
import { type Tokens, useTokens } from '../../ink/tokens';
import './twin.css';

interface DigitalTwinProps {
  readonly bodies: readonly Body[];
}

function BodyMesh({
  body,
  position,
  tone,
}: {
  readonly body: Body;
  readonly position: [number, number, number];
  readonly tone: Tokens;
}) {
  const active = body.status === 'online';
  // Body blue says which body; a body that is not online is drawn in graphite.
  const color = active ? tone.body : tone.graphite;

  return (
    <group position={position} rotation={[0, body.pose?.yaw ?? 0, 0]} scale={0.45}>
      {body.kind === 'drone' ? (
        <>
          <mesh>
            <boxGeometry args={[0.8, 0.15, 0.45]} />
            <meshStandardMaterial color={color} />
          </mesh>
          {[
            [-0.55, 0, -0.38],
            [0.55, 0, -0.38],
            [-0.55, 0, 0.38],
            [0.55, 0, 0.38],
          ].map((offset) => (
            <mesh
              key={offset.join(':')}
              position={offset as [number, number, number]}
              rotation={[Math.PI / 2, 0, 0]}
            >
              <cylinderGeometry args={[0.24, 0.24, 0.04, 24]} />
              <meshStandardMaterial color={color} />
            </mesh>
          ))}
        </>
      ) : body.kind === 'quadruped' || body.kind === 'spider' ? (
        <>
          <mesh>
            <boxGeometry args={[0.9, 0.35, 0.55]} />
            <meshStandardMaterial color={color} />
          </mesh>
          {[-0.35, 0.35].flatMap((x) =>
            [-0.22, 0.22].map((z) => (
              <mesh key={`${x}:${z}`} position={[x, -0.35, z]}>
                <boxGeometry args={[0.12, 0.7, 0.12]} />
                <meshStandardMaterial color={color} />
              </mesh>
            )),
          )}
        </>
      ) : body.kind === 'humanoid' ? (
        <>
          <mesh position={[0, 0.5, 0]}>
            <capsuleGeometry args={[0.28, 0.8, 8, 16]} />
            <meshStandardMaterial color={color} />
          </mesh>
          <mesh position={[0, 1.25, 0]}>
            <sphereGeometry args={[0.24, 24, 24]} />
            <meshStandardMaterial color={color} />
          </mesh>
        </>
      ) : (
        <>
          <mesh>
            <boxGeometry args={[1.1, 0.42, 0.72]} />
            <meshStandardMaterial color={color} />
          </mesh>
          {[-0.42, 0.42].flatMap((x) =>
            [-0.38, 0.38].map((z) => (
              <mesh key={`${x}:${z}`} position={[x, -0.25, z]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.18, 0.18, 0.16, 20]} />
                <meshStandardMaterial color={tone.ink} />
              </mesh>
            )),
          )}
        </>
      )}
      <mesh position={[0, -0.39, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.45, 0.58, 32]} />
        <meshBasicMaterial color={active ? tone.clear : tone.graphite} transparent opacity={0.6} />
      </mesh>
    </group>
  );
}

export function DigitalTwin({ bodies }: DigitalTwinProps) {
  const tone = useTokens();
  return (
    <section className="plate twin-plate" aria-labelledby="digital-twin-title">
      <header className="plate-head">
        <h2 id="digital-twin-title">3D view</h2>
        <p className="note">Measured poses in the warehouse map frame, in metres.</p>
      </header>
      <div
        className="twin-canvas"
        role="img"
        aria-label="Three-dimensional view of the warehouse with each body at its last reported pose"
      >
        <Canvas frameloop="demand" camera={{ position: [6, 6, 8], fov: 42 }}>
          <color attach="background" args={[tone.film]} />
          <ambientLight intensity={0.9} />
          <directionalLight position={[4, 8, 5]} intensity={1.4} />
          <gridHelper key={tone.graphite} args={[12, 12, tone.graphite, tone.rule]} />
          {/* ROS map x/y becomes Three.js x/-z; only measured poses are rendered. */}
          {bodies
            .filter((body) => body.pose != null)
            .map((body) => (
              <BodyMesh
                key={body.id}
                body={body}
                tone={tone}
                position={[body.pose?.x ?? 0, (body.pose?.z ?? 0) + 0.25, -(body.pose?.y ?? 0)]}
              />
            ))}
          <mesh position={[2, 0.5, 0]}>
            <boxGeometry args={[0.7, 1, 1.8]} />
            <meshStandardMaterial color={tone.graphite} />
          </mesh>
          {[
            [3.5, 0],
            [-3, -2],
            [0, 2.5],
          ].map(([x, y]) => (
            <mesh
              key={`${x}:${y}`}
              position={[x ?? 0, 0.01, -(y ?? 0)]}
              rotation={[-Math.PI / 2, 0, 0]}
            >
              <ringGeometry args={[0.25, 0.35, 24]} />
              <meshBasicMaterial color={tone.ink} />
            </mesh>
          ))}
        </Canvas>
      </div>
      <ul className="twin-legend">
        {bodies.map((body) => (
          <li key={body.id} data-online={body.status === 'online' ? '' : undefined}>
            {body.display_name}
            {body.pose == null && ', no pose reported'}
            {body.pose?.z != null && `, ${body.pose.z.toFixed(2)} m up`}
          </li>
        ))}
        {bodies.length === 0 && <li>Start a body adapter to see it here.</li>}
      </ul>
    </section>
  );
}
