import { Canvas } from '@react-three/fiber';
import type { Body } from '../../core/api/schemas';

interface DigitalTwinProps {
  readonly bodies: readonly Body[];
}

function BodyMesh({
  body,
  position,
}: {
  readonly body: Body;
  readonly position: [number, number, number];
}) {
  const active = body.status === 'online';
  const color = active ? '#55c4ff' : '#536171';

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
                <meshStandardMaterial color="#1e2936" />
              </mesh>
            )),
          )}
        </>
      )}
      <mesh position={[0, -0.39, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.45, 0.58, 32]} />
        <meshBasicMaterial color={active ? '#2c9bd2' : '#343f4b'} transparent opacity={0.55} />
      </mesh>
    </group>
  );
}

export function DigitalTwin({ bodies }: DigitalTwinProps) {
  return (
    <section className="panel digital-twin" aria-labelledby="digital-twin-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Normalized fleet state</p>
          <h2 id="digital-twin-title">Digital twin</h2>
        </div>
        <span>Warehouse · map frame · metres</span>
      </div>
      <div className="twin-canvas" role="img" aria-label="Three-dimensional fleet overview">
        <Canvas camera={{ position: [6, 6, 8], fov: 42 }}>
          <color attach="background" args={['#071019']} />
          <ambientLight intensity={0.8} />
          <directionalLight position={[4, 8, 5]} intensity={1.6} />
          <gridHelper args={[12, 12, '#29465d', '#172837']} />
          {/* ROS map x/y becomes Three.js x/-z; only measured poses are rendered. */}
          {bodies
            .filter((body) => body.pose != null)
            .map((body) => (
              <BodyMesh
                key={body.id}
                body={body}
                position={[body.pose?.x ?? 0, 0.25, -(body.pose?.y ?? 0)]}
              />
            ))}
          <mesh position={[2, 0.5, 0]}>
            <boxGeometry args={[0.7, 1, 1.8]} />
            <meshStandardMaterial color="#475569" />
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
              <meshBasicMaterial color="#7dd3fc" />
            </mesh>
          ))}
        </Canvas>
      </div>
      <div className="twin-legend">
        {bodies.map((body) => (
          <span key={body.id}>
            <i className={body.status === 'online' ? 'online-dot' : 'offline-dot'} />
            {body.display_name}
            {body.pose == null ? ' · no localization' : ''}
          </span>
        ))}
        {bodies.length === 0 && <span>Start a body adapter to populate the scene.</span>}
      </div>
    </section>
  );
}
