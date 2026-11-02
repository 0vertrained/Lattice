#!/usr/bin/env python3
"""Record an actual reviewed rover-to-quadruped inspection mission.

Run through LATTICE_CAPABILITY_SHOWCASE=1 run-durable-heterogeneous-warehouse.sh.
The two engines share a semantic frame, not a physics world. Only accepted
camera evidence and sampled physical telemetry are published. Failed runs keep
private diagnostics without replacing the public recording.
"""
import base64
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import runpy
import socket
import subprocess
import threading
import time
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
api = runpy.run_path(str(ROOT / 'scripts/smoke-navigation.py'))
request, wait = api['request'], api['wait']
ROVER, QUAD = 'gazebo-rover', 'mujoco-go1'


def gateway(path):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(2)
        client.connect(path)
        client.sendall(b'{"op":"status"}\n')
        return json.loads(client.makefile('r').readline())


def distance(a, b):
    return math.sqrt(sum((a.get(axis, 0) - b.get(axis, 0)) ** 2 for axis in ('x', 'y', 'z')))


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def physics_provenance():
    quad_python = Path(os.getenv('LATTICE_QUADRUPED_VENV', str(ROOT / 'target/quadruped-venv'))).resolve() / 'bin/python'
    quad_assets = Path(os.getenv('LATTICE_QUADRUPED_ASSETS', str(ROOT / 'target/quadruped-assets'))).resolve()
    subprocess.run([str(quad_python), str(ROOT / 'simulation/quadruped/assets.py'),
                    '--output', str(quad_assets), '--verify'], check=True)
    return json.loads(subprocess.check_output([str(quad_python), '-c',
        'import json,mujoco,assets,policy; print(json.dumps({"policy_sha256":policy.POLICY_SHA256,'
        '"model_commit":assets.MODEL_COMMIT,"mujoco_version":mujoco.__version__}))'],
        cwd=ROOT / 'simulation/quadruped', text=True))


def main():
    assert request('/v1/auth/config')['durable'], 'Use the durable heterogeneous runner'
    run_dir = Path(os.environ['LATTICE_HETEROGENEOUS_RUN_DIR'])
    provenance = physics_provenance()
    paths = {ROVER: os.environ['LATTICE_ROVER_SOCKET'], QUAD: os.environ['LATTICE_QUADRUPED_SOCKET']}
    for path in paths.values():
        wait(lambda: (s if (s := gateway(path))['ready'] and s.get('pose') else None), 90,
             'Both simulated bodies must be localized and ready')
    for identity in paths:
        wait(lambda: next((b for b in request('/v1/bodies') if b['id'] == identity
             and b['status'] == 'online' and b.get('pose')), None), 30, 'Both bodies must register')
    assert not any(r['status'] in ('active', 'recovery_required') for r in request('/v1/rounds')), \
        'Finish or explicitly abandon the previous round before recording'
    # Staging is a separate reviewed navigation mission, never a simulator reset.
    staging = api['approve']({'title': 'Stage rover at the route inspection bay', 'command': {
        'type': 'navigate', 'destination': 'inspection_bay', 'max_speed_mps': .3}})
    assert staging['assigned_body_id'] == ROVER, 'An unrelated body took the staging mission'
    staged = wait(lambda: api['mission_result'](staging['id']), 150, 'Rover staging did not finish')
    assert staged['status'] == 'succeeded', staged
    semantic_map = request('/v1/navigation/map')
    places = {p['id']: p for p in semantic_map['places']}
    wait(lambda: distance(next(b['pose'] for b in request('/v1/bodies') if b['id'] == ROVER),
                          places['inspection_bay']['pose']) <= places['inspection_bay']['arrival_radius_m'],
         10, 'Staging pose did not reach the reviewed source region')
    proposal = request('/v1/navigation/plans', {'route': {
        'source_body_id': ROVER, 'source_place_id': 'inspection_bay',
        'destination_place_id': 'upper_inspection', 'destination_capability': 'inspect'},
        'inspect_source': True, 'inspect_destination': True})
    assert proposal['status'] == 'pending' and proposal['plan'], proposal.get('failure')
    assert proposal['step_body_ids'] == [ROVER, ROVER, QUAD, QUAD]
    assert len(proposal['plan']['transfers']) == 1
    start = time.monotonic()
    recording = {'schema': 'lattice.capability-route.v1',
                 'recorded_at': datetime.now(timezone.utc).isoformat(),
                 'route_plan_id': proposal['id'], 'digest': proposal['digest'],
                 'map': semantic_map, 'plan': proposal['plan'], 'steps': proposal['steps'],
                 'step_body_ids': proposal['step_body_ids'],
                 'scope': 'Gazebo rover and MuJoCo quadruped in separate physics worlds, linked by one semantic map; no shared interbody collision test.'}
    current = request(f'/v1/navigation/plans/{proposal["id"]}/approve', {'digest': proposal['digest']})
    assert current['assigned_body_id'] == ROVER
    recording['round_id'] = current['id']
    poses, physics, events, seen = [], [], [], {}
    review = approved = first_observation = transfer_options = None
    context_seen = False
    transfer_source_pose = None
    max_source_drift = 0.0
    missions = {}
    sampler_stop = threading.Event()
    sampler_errors = []

    def sample_physics():
        next_sample = time.monotonic()
        while not sampler_stop.is_set():
            try:
                state = gateway(paths[QUAD])
                physics.append({'t': elapsed(), **state['physics']})
            except (OSError, ValueError, KeyError) as error:
                sampler_errors.append(str(error))
            next_sample = max(next_sample + .05, time.monotonic())
            sampler_stop.wait(max(0, next_sample - time.monotonic()))

    def elapsed():
        return round(time.monotonic() - start, 3)

    def event(title, detail, kind='mission'):
        events.append({'t': elapsed(), 'title': title, 'detail': detail, 'kind': kind})
        print(f'{elapsed():6.1f}s {title}: {detail}', flush=True)

    def sample():
        states = {body: gateway(path) for body, path in paths.items()}
        for body, state in states.items():
            if state.get('pose'):
                poses.append({'t': elapsed(), 'body_id': body, **state['pose'], 'status': state['state']})
        return states

    event('Capability route approved', 'Rover inspects the bay and approaches the stairs; the staged Go1 owns the stair segment and upper inspection.', 'approval')
    deadline = time.monotonic() + 480
    sampler = threading.Thread(target=sample_physics, daemon=True)
    sampler.start()
    try:
        while time.monotonic() < deadline:
            current = next(r for r in request('/v1/rounds') if r['id'] == current['id'])
            missions = {m['id']: m for m in request('/v1/missions') if m['id'] in current['mission_ids']}
            states = sample()
            for identity, mission in missions.items():
                if seen.get(identity) != mission['status']:
                    seen[identity] = mission['status']
                    event(mission['title'], f'{mission["assigned_body_id"]}: {mission["status"]}',
                          'anomaly' if mission['status'] == 'failed' else 'mission')
            if current['status'] in ('failed', 'completed'):
                assert current['status'] == 'completed', f'Round failed: {current["id"]}'
                break
            if current['status'] == 'recovery_required' and current['current_step'] == 2 and review is None:
                transfer_options = request(f'/v1/rounds/{current["id"]}/transfer-options')
                assert transfer_options['required'] and transfer_options['ready'], transfer_options
                assert transfer_options['recommended_target_body_id'] == QUAD
                assert transfer_options['transfer_place_id'] == 'stair_transfer'
                assert states[QUAD]['state'] != 'running', 'Target moved before transfer approval'
                assert distance(states[ROVER]['pose'], places['stair_transfer']['pose']) <= places['stair_transfer']['arrival_radius_m']
                first_observation = next(o for o in request('/v1/observations?limit=100')
                    if o['mission_id'] in current['mission_ids'] and o['body_id'] == ROVER)
                assert first_observation['outcome'] == 'detected'
                review = request(f'/v1/rounds/{current["id"]}/handoff-proposal', {'target_body_id': QUAD})
                assert review['retained_observation_ids'] == [first_observation['id']]
                assert len(review['completed_steps']) == 2 and len(review['remaining_steps']) == 2
                transfer_source_pose = states[ROVER]['pose']
                event('Transfer requires review', transfer_options['reason'], 'handoff')
                try:
                    request(f'/v1/handoffs/{review["id"]}/approve', {'digest': review['digest']})
                except urllib.error.HTTPError as error:
                    assert error.code == 422
                else:
                    raise AssertionError('Transfer bypassed the source authorization safety margin')
            if review and not approved:
                assert states[QUAD]['state'] != 'running', 'Target moved before explicit transfer approval'
                ready_at = datetime.fromisoformat(review['not_before_at'].replace('Z', '+00:00'))
                if datetime.now(timezone.utc) >= ready_at:
                    approved = request(f'/v1/handoffs/{review["id"]}/approve', {'digest': review['digest']})
                    assert approved['status'] == 'approved'
                    event('Go1 continuation approved', 'The retained rover image and completed steps travel with the same objective.', 'approval')
            if transfer_source_pose:
                max_source_drift = max(max_source_drift, distance(states[ROVER]['pose'], transfer_source_pose))
                assert max_source_drift < .15, 'Source rover moved after its completed approach'
            if approved and not context_seen:
                latest = next(h for h in request('/v1/handoffs') if h['id'] == review['id'])
                if latest['context_acknowledged_at']:
                    approved, context_seen = latest, True
                    event('Go1 verified retained evidence', 'The body checked the original JPEG hash and acknowledged the signed context before actuation.', 'memory')
            time.sleep(.25)
        else:
            raise AssertionError('Capability route exceeded its recording deadline')
        assert approved and context_seen and first_observation
        observations = [o for o in request('/v1/observations?limit=100') if o['mission_id'] in current['mission_ids']]
        assert len(observations) == 2 and current['anomaly_count'] == 0
        assert next(o for o in observations if o['id'] == first_observation['id']) == first_observation
        assert all(o['outcome'] == 'detected' for o in observations)
        quad_observation = next(o for o in observations if o['body_id'] == QUAD)
        assert quad_observation['location'] == 'upper_inspection'
        traversals = [m for m in missions.values() if m['command']['type'] == 'traverse_route' and m['status'] == 'succeeded']
        assert len(traversals) == 2
        for mission in traversals:
            required = mission['command']['traversal']['required_capabilities']
            assert 'stairs' not in required or mission['assigned_body_id'] == QUAD
        assert sum(m['command'] == proposal['steps'][0]['command'] for m in missions.values()) == 1, 'Completed inspection repeated'
        final = sample()[QUAD]
        assert distance(final['pose'], places['upper_inspection']['pose']) <= places['upper_inspection']['arrival_radius_m']
        metrics = final['physics']
        assert set(metrics['contact_steps']) == {'step0', 'step1', 'step2'}
        assert not metrics['fallen'] and not metrics['torso_contact'] and metrics['max_motor_torque'] <= 33.501
        assert metrics['base_z'] > .38 and final['pose']['z'] > .12
        assert len({c['foot'] for c in metrics['foot_contacts'] if c['normal_force_n'] > 1}) >= 3
        event('Inspection completed across capabilities', 'The rover’s bay evidence is retained; Go1 climbed three physical 5 cm steps and captured the upper marker.', 'complete')
        # Retain a physical standing tail for video, without pausing either simulator.
        until = time.monotonic() + 4
        while time.monotonic() < until:
            stable = sample()[QUAD]
            assert distance(stable['pose'], final['pose']) < .05 and not stable['physics']['fallen']
            time.sleep(.1)
        sampler_stop.set()
        sampler.join(timeout=3)
        assert not sampler.is_alive() and not sampler_errors, sampler_errors
        artifacts, public_observations = [], []
        output = ROOT / 'apps/control-center/public/demo'
        output.mkdir(parents=True, exist_ok=True)
        for index, observation in enumerate(sorted(observations, key=lambda o: o['captured_at'])):
            evidence = request(f'/v1/observations/{observation["id"]}/evidence')
            raw = base64.b64decode(evidence['image_base64'], validate=True)
            assert hashlib.sha256(raw).hexdigest() == observation['image_sha256']
            filename = f'capability-observation-{index + 1}.jpg'
            artifacts.append((output / filename, raw))
            public_observations.append({**observation, 'image': filename})
        distances = {}
        for body in paths:
            trail = [p for p in poses if p['body_id'] == body]
            distances[body] = round(sum(distance(a, b) for a, b in zip(trail, trail[1:])), 2)
        recording.update({'duration_s': elapsed(), 'outcome': current['status'],
            'anomaly_count': current['anomaly_count'], 'poses': poses, 'events': events,
            'observations': public_observations, 'distance_by_body_m': distances,
            'transfer_recommendation': transfer_options,
            'handoff': {'id': approved['id'], 'source_body_id': ROVER, 'target_body_id': QUAD,
                'context_digest': approved['context']['digest'], 'completed_steps': 2, 'remaining_steps': 2,
                'post_transfer_source_drift_m': round(max_source_drift, 4),
                'context_acknowledged_at': approved['context_acknowledged_at'],
                'not_before_at': approved['not_before_at'], 'approved_at': approved['approved_at']},
            'quadruped': {'engine': 'MuJoCo 3.3.7', 'controller': 'Walk These Ways Go1',
                'step_count': 3, 'riser_height_m': .05, 'contact_steps': metrics['contact_steps'],
                'max_tilt_rad': metrics['max_tilt'], 'max_motor_torque_nm': metrics['max_motor_torque'],
                'final_base_z_m': metrics['base_z'], 'final_navigation_z_m': final['pose']['z'],
                'foot_contacts_at_completion': metrics['foot_contacts']}})
        atomic_json(run_dir / 'capability-route-result.json', {'staging_mission': staged,
            'physics_provenance': provenance,
            'proposal': proposal, 'round': current, 'missions': list(missions.values()),
            'handoff': approved, 'recording': recording, 'physics': physics})
        # Publish success last. Failed and interrupted runs cannot replace the tour.
        for path, raw in artifacts:
            path.write_bytes(raw)
            path.chmod(0o644)
        atomic_json(output / 'capability-route.json', recording)
        (output / 'capability-route.json').chmod(0o644)
        print(json.dumps({'result': 'passed', 'duration_s': recording['duration_s'],
            'distances_m': distances, 'poses': len(poses), 'observations': len(observations),
            'quadruped': recording['quadruped']}, indent=2))
    except Exception as error:
        sampler_stop.set()
        sampler.join(timeout=3)
        atomic_json(run_dir / 'capability-route-failed.json', {'error': str(error),
            'proposal': proposal, 'round': current, 'missions': list(missions.values()),
            'handoff': review, 'poses': poses, 'physics': physics, 'events': events,
            'sampler_errors': sampler_errors})
        raise


if __name__ == '__main__':
    main()
