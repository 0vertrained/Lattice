#!/usr/bin/env python3
"""Record real lidar-driven route replanning without replacing completed work.

Requires the durable adaptive runner. The only injected event is a physical
Gazebo box created through its world service. The recorder never supplies a
sensor observation or moves a body by editing simulator state.
"""
import base64
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import runpy
import re
import subprocess
import threading
import time
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
helpers = runpy.run_path(str(ROOT / 'scripts/record-capability-route.py'))
api = helpers['api']
request, wait = api['request'], api['wait']
gateway, distance = helpers['gateway'], helpers['distance']
atomic_json, physics_provenance = helpers['atomic_json'], helpers['physics_provenance']
ROVER, QUAD = 'gazebo-rover', 'mujoco-go1'
CASES = {'nominal': None, 'blocked_center': (.2, 1.55), 'blocked_offset': (.3, 1.5)}


def now():
    return datetime.now(timezone.utc).isoformat()


def gazebo_service(container, service, request_type, response_type, payload):
    result = subprocess.run(['docker', 'exec', container, 'bash', '-c',
        'source /opt/ros/jazzy/setup.bash && exec gz "$@"', 'lattice-gz', 'service', '-s', service,
        '--reqtype', request_type, '--reptype', response_type, '--timeout', '5000',
        '--req', payload], capture_output=True, text=True, timeout=12)
    if result.returncode != 0:
        raise RuntimeError('Gazebo world service failed: ' + result.stderr[-1200:])
    return result.stdout


def insert_barrier(container, case_name):
    position = CASES[case_name]
    if position is None:
        return None
    x, y = position
    name = 'adaptive_barrier_' + case_name
    sdf = f'''<sdf version="1.9"><model name="{name}"><static>true</static>
<pose>{x} {y} 0.4 0 0 0</pose><link name="barrier">
<collision name="collision"><geometry><box><size>1.4 0.18 0.8</size></box></geometry></collision>
<visual name="visual"><geometry><box><size>1.4 0.18 0.8</size></box></geometry>
<material><ambient>0.8 0.3 0.05 1</ambient><diffuse>0.9 0.35 0.05 1</diffuse></material></visual>
</link></model></sdf>'''
    response = gazebo_service(container, '/world/warehouse/create',
        'gz.msgs.EntityFactory', 'gz.msgs.Boolean', 'sdf: ' + json.dumps(sdf))
    assert 'data: true' in response, 'Gazebo did not confirm physical obstacle insertion'
    return {'model_name': name, 'pose': {'x': x, 'y': y, 'z': .4},
            'size': {'x': 1.4, 'y': .18, 'z': .8}, 'created_at': now(),
            'sdf_sha256': hashlib.sha256(sdf.encode()).hexdigest(),
            'creation_response': response.strip(),
            'scope': 'Physical collision and lidar geometry inserted after rover staging; absent from the static occupancy map.'}


def clean_owned_conditions(container):
    """Suite resets are explicit and can clear only exact events it owns."""
    snapshot = request('/v1/navigation/conditions')
    if not snapshot['blocked_segment_ids']:
        return
    allowed = set(json.loads(os.getenv('LATTICE_ADAPTIVE_CLEAR_EVENT_IDS', '[]')))
    latest = {}
    for condition in snapshot['conditions']:
        if condition['segment_id'] not in latest or condition['revision'] > latest[condition['segment_id']]['revision']:
            latest[condition['segment_id']] = condition
    blocked = [condition for condition in latest.values() if condition['status'] == 'blocked']
    assert blocked and all(condition['event_id'] in allowed for condition in blocked), \
        'Review existing route conditions before this run; the recorder only clears exact prior events owned by its evaluation suite'
    scene = gazebo_service(container, '/world/warehouse/scene/info', 'gz.msgs.Empty', 'gz.msgs.Scene', '')
    assert 'name: "ground"' in scene and 'name: "lattice_rover"' in scene, \
        'The new warehouse scene could not be established before clearing a prior condition'
    assert 'adaptive_barrier_' not in scene, 'The prior physical barrier is still present'
    for condition in blocked:
        current_revision = request('/v1/navigation/conditions')['revision']
        request('/v1/navigation/conditions', {'event_id': 'adaptive-clear-' + str(time.time_ns()),
            'map_digest': snapshot['map_digest'], 'segment_id': condition['segment_id'], 'status': 'clear',
            'reason': 'Evaluation operator verified the prior owned simulator ended and the new Gazebo scene contains no adaptive barrier.',
            'observed_at': now(), 'expected_revision': current_revision})
    assert not request('/v1/navigation/conditions')['blocked_segment_ids']


def main():
    case_name = os.getenv('LATTICE_ADAPTIVE_CASE', 'blocked_center')
    assert case_name in CASES, 'Select nominal, blocked_center or blocked_offset'
    expects_block = CASES[case_name] is not None
    assert request('/v1/auth/config')['durable'], 'Use the durable adaptive runner'
    run_dir = Path(os.environ['LATTICE_HETEROGENEOUS_RUN_DIR'])
    container = os.environ['LATTICE_ROS_CONTAINER']
    provenance = physics_provenance()
    paths = {ROVER: os.environ['LATTICE_ROVER_SOCKET'], QUAD: os.environ['LATTICE_QUADRUPED_SOCKET']}
    for identity, path in paths.items():
        wait(lambda: (s if (s := gateway(path))['ready'] and s.get('pose') else None), 90,
             f'{identity} must be localized and ready')
        wait(lambda: next((b for b in request('/v1/bodies') if b['id'] == identity
             and b['status'] == 'online' and b.get('pose')), None), 30, 'Both bodies must register')
    assert not any(r['status'] in ('active', 'recovery_required') for r in request('/v1/rounds')), \
        'Finish or explicitly abandon the previous round before recording'
    clean_owned_conditions(container)
    staging = api['approve']({'title': 'Stage rover for adaptive route evaluation', 'command': {
        'type': 'navigate', 'destination': 'inspection_bay', 'max_speed_mps': .3}})
    assert staging['assigned_body_id'] == ROVER, 'An unrelated body took the staging mission'
    staged = wait(lambda: api['mission_result'](staging['id']), 90, 'Rover staging did not finish')
    assert staged['status'] == 'succeeded', staged
    semantic_map = request('/v1/navigation/map')
    assert semantic_map['id'] == 'warehouse_adaptive', 'Run with the reviewed adaptive map'
    places = {place['id']: place for place in semantic_map['places']}
    wait(lambda: distance(next(b['pose'] for b in request('/v1/bodies') if b['id'] == ROVER),
                          places['inspection_bay']['pose']) <= places['inspection_bay']['arrival_radius_m'],
         10, 'Staging did not reach the reviewed source region')
    obstacle = insert_barrier(container, case_name)
    # Allow the actual sensor and dynamic costmap to observe the inserted geometry.
    if obstacle:
        time.sleep(.7)
    objective = {'route': {'source_body_id': ROVER, 'source_place_id': 'inspection_bay',
        'destination_place_id': 'upper_inspection', 'destination_capability': 'inspect'},
        'inspect_source': True, 'inspect_destination': True}
    proposal = request('/v1/navigation/plans', objective)
    assert proposal['status'] == 'pending' and proposal['plan'], proposal.get('failure')
    assert [leg['segment_id'] for leg in proposal['plan']['legs']] == ['bay_to_transfer', 'stairs_to_upper']
    started = time.monotonic()
    recorded_at = now()
    current = request(f'/v1/navigation/plans/{proposal["id"]}/approve', {'digest': proposal['digest']})
    original_round_id = current['id']
    poses, physics, events, seen, missions = [], [], [], {}, {}
    replan = replan_approved = replan_round = condition = first_observation = None
    raw_scan = scan_record = None
    handoff = handoff_approved = transfer_options = None
    context_seen = False
    held_pose = transfer_pose = None
    held_drift = transfer_drift = 0.
    block_seen_s = replan_proposal_ms = replan_approved_s = None
    completion_s = None
    sampler_stop, sampler_errors = threading.Event(), []

    def elapsed():
        return round(time.monotonic() - started, 3)

    def event(title, detail, kind='mission'):
        events.append({'t': elapsed(), 'title': title, 'detail': detail, 'kind': kind})
        print(f'{elapsed():6.1f}s {title}: {detail}', flush=True)

    def sample_physics():
        next_sample = time.monotonic()
        while not sampler_stop.is_set():
            try:
                physics.append({'t': elapsed(), **gateway(paths[QUAD])['physics']})
            except (OSError, ValueError, KeyError) as error:
                sampler_errors.append(str(error))
            next_sample = max(next_sample + .05, time.monotonic())
            sampler_stop.wait(max(0, next_sample - time.monotonic()))

    def sample():
        states = {body: gateway(path) for body, path in paths.items()}
        for body, state in states.items():
            if state.get('pose'):
                poses.append({'t': elapsed(), 'body_id': body, **state['pose'], 'status': state['state']})
        return states

    sampler = threading.Thread(target=sample_physics, daemon=True)
    sampler.start()
    event('Original objective approved', 'Inspect the bay, follow the direct aisle, transfer to Go1 and inspect the upper station.', 'approval')
    deadline = time.monotonic() + 480
    try:
        while time.monotonic() < deadline:
            current = next(round_ for round_ in request('/v1/rounds') if round_['id'] == original_round_id)
            missions = {mission['id']: mission for mission in request('/v1/missions')
                        if mission['id'] in current['mission_ids']}
            states = sample()
            for identity, mission in missions.items():
                if seen.get(identity) != mission['status']:
                    seen[identity] = mission['status']
                    event(mission['title'], f'{mission["assigned_body_id"]}: {mission["status"]}')
            snapshot = request('/v1/navigation/conditions')
            candidates = [item for item in snapshot['conditions'] if item['status'] == 'blocked'
                          and item.get('body_id') == ROVER and item['segment_id'] == 'bay_to_transfer'
                          and item.get('command_id') in {m.get('active_command_id') for m in missions.values()}]
            if condition is None and candidates:
                assert expects_block, 'Nominal run falsely reported a blocked route'
                condition = max(candidates, key=lambda item: item['revision'])
                block_seen_s, held_pose = elapsed(), states[ROVER]['pose']
                assert condition['evidence']['sensor'] == 'laser_scan'
                assert condition['evidence']['blocked_samples'] >= 3
                assert condition['evidence']['distance_m'] <= .95
                assert re.fullmatch(r'[A-Za-z0-9_-]{1,100}', condition['event_id'])
                raw_scan = (run_dir / 'rover' / (condition['event_id'] + '-scan.json')).read_bytes()
                assert hashlib.sha256(raw_scan).hexdigest() == condition['evidence']['scan_sha256']
                scan = json.loads(raw_scan)
                assert len(scan['ranges']) == 360 and sum(value is not None for value in scan['ranges']) >= 3
                assert all(value is None or math.isfinite(value) for value in scan['ranges'])
                scan_record = {'file': 'adaptive-blockage-scan.json',
                    'sha256': condition['evidence']['scan_sha256'], 'samples': len(scan['ranges']),
                    'sensor_frame_id': scan['sensor_frame_id'],
                    'scope': 'Original canonical laser scan bytes retained by the body; hash-bound to the authenticated condition report.'}
                assert distance(held_pose, places['inspection_bay']['pose']) <= places['inspection_bay']['arrival_radius_m']
                event('Physical aisle blockage observed', 'The rover’s live lidar report closed the direct segment and held the round; no alternate command was approved.', 'condition')
            if current['status'] == 'failed':
                raise AssertionError('Adaptive round failed instead of holding/replanning')
            if (replan_approved and current['status'] == 'recovery_required'
                    and current['current_step'] < len(current['steps']) - 2):
                held = missions.get(current['current_mission_id'], {})
                raise AssertionError('The reviewed detour required another hold: ' + str(held.get('status_detail')))
            if current['status'] == 'completed':
                completion_s = elapsed()
                break
            if condition and replan is None and current['status'] == 'recovery_required':
                assert current['current_step'] == 1, 'The source inspection must be the only completed step'
                first_observation = next(item for item in request('/v1/observations?limit=100')
                    if item['mission_id'] in current['mission_ids'] and item['body_id'] == ROVER)
                assert first_observation['outcome'] == 'detected'
                tick = time.monotonic()
                replan = request(f'/v1/rounds/{original_round_id}/replan-proposal', {'digest': current['digest']})
                replan_proposal_ms = round((time.monotonic() - tick) * 1000, 3)
                assert replan['status'] == 'pending' and replan['plan'], replan
                assert len(replan['completed_steps']) == 1
                assert replan['retained_observation_ids'] == [first_observation['id']]
                assert replan['source_place_id'] == 'inspection_bay'
                assert replan['blocked_segment_ids'] == ['bay_to_transfer']
                assert [leg['segment_id'] for leg in replan['plan']['legs']] == [
                    'bay_to_west_bypass', 'west_bypass_to_transfer', 'stairs_to_upper']
                assert replan['step_body_ids'] == [ROVER, ROVER, QUAD, QUAD]
                event('Remaining route prepared for review', 'Keep the completed bay inspection and its image; propose the west aisle while the source authorization fence remains active.', 'replan')
                try:
                    request(f'/v1/replans/{replan["id"]}/approve', {'digest': replan['digest']})
                except urllib.error.HTTPError as error:
                    assert error.code == 422
                else:
                    raise AssertionError('Replan bypassed the old command expiry fence')
            if replan and not replan_approved:
                assert states[QUAD]['state'] != 'running'
                held_drift = max(held_drift, distance(states[ROVER]['pose'], held_pose))
                assert held_drift < .08, 'Source moved while replan was awaiting approval'
                permitted = datetime.fromisoformat(replan['not_before_at'].replace('Z', '+00:00'))
                if datetime.now(timezone.utc).timestamp() >= permitted.timestamp() + .5:
                    replan_round = request(f'/v1/replans/{replan["id"]}/approve', {'digest': replan['digest']})
                    assert replan_round['id'] == original_round_id and replan_round['current_step'] == 1
                    assert len(replan_round['steps']) == 5
                    assert replan_round['steps'][0] == proposal['steps'][0]
                    replan_approved = next(item for item in request('/v1/replans') if item['id'] == replan['id'])
                    assert replan_approved['status'] == 'approved'
                    replan_approved_s = elapsed()
                    event('Revised remainder approved', 'The same objective continues through the west aisle after the full stop fence; completed work and original evidence remain.', 'approval')
            if current['status'] == 'recovery_required' and current['current_step'] == len(current['steps']) - 2 and handoff is None:
                transfer_options = request(f'/v1/rounds/{original_round_id}/transfer-options')
                assert transfer_options['required'] and transfer_options['ready'], transfer_options
                assert transfer_options['recommended_target_body_id'] == QUAD
                assert states[QUAD]['state'] != 'running'
                assert distance(states[ROVER]['pose'], places['stair_transfer']['pose']) <= places['stair_transfer']['arrival_radius_m']
                if first_observation is None:
                    first_observation = next(item for item in request('/v1/observations?limit=100')
                        if item['mission_id'] in current['mission_ids'] and item['body_id'] == ROVER)
                handoff = request(f'/v1/rounds/{original_round_id}/handoff-proposal', {'target_body_id': QUAD})
                assert handoff['retained_observation_ids'] == [first_observation['id']]
                assert len(handoff['completed_steps']) == len(current['steps']) - 2
                transfer_pose = states[ROVER]['pose']
                event('Capability transfer prepared', transfer_options['reason'], 'handoff')
            if handoff and not handoff_approved:
                assert states[QUAD]['state'] != 'running'
                permitted = datetime.fromisoformat(handoff['not_before_at'].replace('Z', '+00:00'))
                if datetime.now(timezone.utc) >= permitted:
                    handoff_approved = request(f'/v1/handoffs/{handoff["id"]}/approve', {'digest': handoff['digest']})
                    event('Go1 continuation approved', 'The retained source image accompanies the final stair traversal and upper inspection.', 'approval')
            if transfer_pose:
                transfer_drift = max(transfer_drift, distance(states[ROVER]['pose'], transfer_pose))
                assert transfer_drift < .15, 'Source moved after its completed approach and transfer'
            if handoff_approved and not context_seen:
                latest = next(item for item in request('/v1/handoffs') if item['id'] == handoff['id'])
                if latest['context_acknowledged_at']:
                    handoff_approved, context_seen = latest, True
                    event('Go1 verified retained image', 'The receiving body validated the signed evidence references and original JPEG before local actuation.', 'memory')
            time.sleep(.25)
        else:
            raise AssertionError('Adaptive mission exceeded its recording deadline')
        assert handoff_approved and context_seen and first_observation
        assert bool(replan_approved) == expects_block
        assert current['id'] == original_round_id and current['anomaly_count'] == 0
        source_inspections = [mission for mission in missions.values() if mission['command'] == proposal['steps'][0]['command']]
        assert len(source_inspections) == 1 and source_inspections[0]['status'] == 'succeeded', 'Completed inspection was repeated or lost'
        observations = [item for item in request('/v1/observations?limit=100') if item['mission_id'] in current['mission_ids']]
        assert len(observations) == 2 and all(item['outcome'] == 'detected' for item in observations)
        assert next(item for item in observations if item['id'] == first_observation['id']) == first_observation
        traversals = [mission for mission in missions.values() if mission['command']['type'] == 'traverse_route' and mission['status'] == 'succeeded']
        expected_segments = {'bay_to_west_bypass', 'west_bypass_to_transfer', 'stairs_to_upper'} if expects_block else {'bay_to_transfer', 'stairs_to_upper'}
        assert {mission['command']['traversal']['segment_id'] for mission in traversals} == expected_segments
        for mission in traversals:
            if 'stairs' in mission['command']['traversal']['required_capabilities']:
                assert mission['assigned_body_id'] == QUAD
        final = sample()[QUAD]
        metrics = final['physics']
        assert distance(final['pose'], places['upper_inspection']['pose']) <= places['upper_inspection']['arrival_radius_m']
        assert set(metrics['contact_steps']) == {'step0', 'step1', 'step2'}
        assert not metrics['fallen'] and not metrics['torso_contact'] and metrics['max_motor_torque'] <= 33.501
        assert len({contact['foot'] for contact in metrics['foot_contacts'] if contact['normal_force_n'] > 1}) >= 3
        event('Adaptive objective completed', 'Both original inspections remain attributed to their bodies; the revised route preserved completed work and all three physical step contacts.', 'complete')
        until = time.monotonic() + 4
        while time.monotonic() < until:
            stable = sample()[QUAD]
            assert distance(stable['pose'], final['pose']) < .05 and not stable['physics']['fallen']
            time.sleep(.1)
        sampler_stop.set()
        sampler.join(timeout=3)
        assert not sampler.is_alive() and not sampler_errors, sampler_errors
        distances = {}
        for body in paths:
            trail = [pose for pose in poses if pose['body_id'] == body]
            distances[body] = round(sum(distance(a, b) for a, b in zip(trail, trail[1:])), 2)
        public_observations, artifacts = [], []
        output = ROOT / 'apps/control-center/public/demo'
        if raw_scan:
            artifacts.append((output / scan_record['file'], raw_scan))
        for index, observation in enumerate(sorted(observations, key=lambda item: item['captured_at'])):
            evidence = request(f'/v1/observations/{observation["id"]}/evidence')
            raw = base64.b64decode(evidence['image_base64'], validate=True)
            assert hashlib.sha256(raw).hexdigest() == observation['image_sha256']
            filename = f'adaptive-observation-{index + 1}.jpg'
            artifacts.append((output / filename, raw))
            public_observations.append({**observation, 'image': filename})
        final_plan = replan_approved['plan'] if replan_approved else proposal['plan']
        final_owners = [ROVER] + replan_approved['step_body_ids'] if replan_approved else proposal['step_body_ids']
        recording = {'schema': 'lattice.adaptive-route.v1', 'recorded_at': recorded_at,
            'duration_s': elapsed(), 'mission_duration_s': completion_s, 'outcome': current['status'],
            'round_id': original_round_id, 'route_plan_id': current['route_plan_id'],
            'digest': current['digest'], 'objective': objective, 'map': semantic_map,
            'initial_plan': proposal['plan'], 'plan': final_plan, 'steps': current['steps'],
            'step_body_ids': final_owners, 'anomaly_count': current['anomaly_count'],
            'poses': poses, 'events': events, 'observations': public_observations,
            'distance_by_body_m': distances, 'conditions': request('/v1/navigation/conditions'),
            'condition_observation': condition, 'lidar_scan': scan_record,
            'replan': replan_approved, 'obstacle': obstacle,
            'adaptation': {'case_name': case_name, 'blocked_segment_id': condition['segment_id'] if condition else None,
                'completed_steps_preserved': 1 if replan_approved else 0, 'repeated_inspections': 0,
                'block_observed_s': block_seen_s, 'replan_proposal_ms': replan_proposal_ms,
                'replan_approved_s': replan_approved_s,
                'hold_to_approval_s': round(replan_approved_s - block_seen_s, 3) if replan_approved else None,
                'source_drift_while_held_m': round(held_drift, 4),
                'post_transfer_source_drift_m': round(transfer_drift, 4)},
            'transfer_recommendation': transfer_options,
            'handoff': {'id': handoff_approved['id'], 'source_body_id': ROVER, 'target_body_id': QUAD,
                'context_digest': handoff_approved['context']['digest'],
                'completed_steps': len(current['steps']) - 2, 'remaining_steps': 2,
                'context_acknowledged_at': handoff_approved['context_acknowledged_at'],
                'not_before_at': handoff_approved['not_before_at'], 'approved_at': handoff_approved['approved_at']},
            'quadruped': {'engine': 'MuJoCo 3.3.7', 'controller': 'Walk These Ways Go1',
                'step_count': 3, 'riser_height_m': .05, 'contact_steps': metrics['contact_steps'],
                'max_tilt_rad': metrics['max_tilt'], 'max_motor_torque_nm': metrics['max_motor_torque'],
                'final_base_z_m': metrics['base_z'], 'final_navigation_z_m': final['pose']['z'],
                'foot_contacts_at_completion': metrics['foot_contacts']},
            'scope': 'Physical Gazebo lidar blockage and reviewed replanning; Go1 uses a separate MuJoCo physics world with aligned semantic coordinates.'}
        result = {'case_name': case_name, 'staging_mission': staged, 'physics_provenance': provenance,
            'proposal': proposal, 'round': current, 'missions': list(missions.values()),
            'handoff': handoff_approved, 'replan': replan_approved, 'recording': recording, 'physics': physics}
        atomic_json(run_dir / 'adaptive-route-result.json', result)
        if os.getenv('LATTICE_ADAPTIVE_PUBLISH', '1') == '1':
            assert expects_block, 'Only a verified adaptive case may replace the public adaptive tour'
            output.mkdir(parents=True, exist_ok=True)
            for path, raw in artifacts:
                path.write_bytes(raw)
                path.chmod(0o644)
            atomic_json(output / 'adaptive-route.json', recording)
            (output / 'adaptive-route.json').chmod(0o644)
        if path := os.getenv('LATTICE_ADAPTIVE_RESULT_POINTER'):
            atomic_json(Path(path), {'run_dir': str(run_dir), 'result': str(run_dir / 'adaptive-route-result.json')})
        print(json.dumps({'result': 'passed', 'case_name': case_name, 'mission_duration_s': completion_s,
            'recording_duration_s': recording['duration_s'], 'poses': len(poses), 'physics_samples': len(physics),
            'distances_m': distances, 'adaptation': recording['adaptation']}, indent=2))
    except Exception as error:
        sampler_stop.set()
        sampler.join(timeout=3)
        atomic_json(run_dir / 'adaptive-route-failed.json', {'error': str(error), 'proposal': proposal,
            'round': current, 'missions': list(missions.values()), 'replan': replan, 'handoff': handoff,
            'condition': condition, 'poses': poses, 'physics': physics, 'events': events,
            'sampler_errors': sampler_errors, 'obstacle': obstacle})
        raise


if __name__ == '__main__':
    main()
