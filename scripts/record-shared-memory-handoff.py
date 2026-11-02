#!/usr/bin/env python3
"""Record measured two-rover continuation; run through the durable multi-rover runner.

Creates an approved round and explicitly approves its frozen handoff after the
source expiry window. Only real gateway telemetry and accepted camera evidence
are exported. A failed run never replaces the public demonstration recording.
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
import time
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
api = runpy.run_path(str(ROOT / 'scripts/smoke-navigation.py'))
request, wait = api['request'], api['wait']
A, B = 'gazebo-rover-a', 'gazebo-rover-b'


def gateway(path):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(2)
        client.connect(path)
        client.sendall(b'{"op":"status"}\n')
        return json.loads(client.makefile('r').readline())


def main():
    assert request('/v1/auth/config')['durable'], 'Use the durable multi-rover runner'
    paths = {A: os.environ['LATTICE_ROVER_A_SOCKET'], B: os.environ['LATTICE_ROVER_B_SOCKET']}
    run_dir = Path(os.environ['LATTICE_MULTI_RUN_DIR'])
    for path in paths.values():
        wait(lambda: (s if (s := gateway(path))['ready'] and s.get('pose') else None), 90, 'Both rovers must localize')
    assert not any(r['status'] in ('active', 'recovery_required') for r in request('/v1/rounds')), 'Finish or recover the previous round before recording'
    steps = [
        {'title': 'Rover A verifies the inspection bay', 'command': {'type': 'inspect', 'location': 'inspection_bay'}, 'continue_on_missing_marker': False},
        {'title': 'Continue to the loading dock', 'command': {'type': 'navigate', 'destination': 'loading_dock', 'max_speed_mps': .3}, 'continue_on_missing_marker': False},
        {'title': 'Inspect the loading dock', 'command': {'type': 'inspect', 'location': 'loading_dock'}, 'continue_on_missing_marker': True},
        {'title': 'Return the continuing rover to charge', 'command': {'type': 'navigate', 'destination': 'charging_station', 'max_speed_mps': .3}, 'continue_on_missing_marker': False},
    ]
    proposal = request('/v1/rounds', {'steps': steps})
    start = time.monotonic()
    recording = {'schema': 'lattice.handoff.v1', 'recorded_at': datetime.now(timezone.utc).isoformat(), 'round_id': proposal['id'], 'digest': proposal['digest'], 'steps': steps}
    current = request(f'/v1/rounds/{proposal["id"]}/approve', {'digest': proposal['digest']})
    assert current['assigned_body_id'] == A, 'Use a clean two-rover fleet with A selected first'
    poses, events, seen = [], [], {}
    review = None
    approved = None
    stopped = None
    first_observation = None
    completed_ids = []
    stopped_after = None
    max_drift = 0.0
    context_seen = False

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

    event('One objective approved', 'Four bounded steps; the completed bay inspection will stay with the mission.', 'approval')
    deadline = time.monotonic() + 480
    while time.monotonic() < deadline:
        current = next(r for r in request('/v1/rounds') if r['id'] == proposal['id'])
        missions = {m['id']: m for m in request('/v1/missions') if m['id'] in current['mission_ids']}
        states = sample()
        for identity, mission in missions.items():
            if seen.get(identity) != mission['status']:
                seen[identity] = mission['status']
                event(mission['title'], f'{mission["assigned_body_id"]}: {mission["status"]}', 'anomaly' if mission['status'] == 'failed' else 'mission')
        if current['status'] in ('failed', 'completed'):
            assert current['status'] == 'completed', f'Round failed: {current["id"]}'
            break
        if current['current_step'] == 1 and review is None and states[A]['state'] == 'running':
            completed_ids = [i for i, m in missions.items() if m['status'] == 'succeeded']
            assert len(completed_ids) == 1
            first_observation = next(o for o in request('/v1/observations?limit=100') if o['mission_id'] == completed_ids[0])
            assert first_observation['outcome'] == 'detected' and first_observation['body_id'] == A
            frozen_at = time.monotonic()
            review = request(f'/v1/rounds/{current["id"]}/handoff-proposal', {'target_body_id': B})
            assert review['retained_observation_ids'] == [first_observation['id']]
            assert len(review['completed_steps']) == 1 and len(review['remaining_steps']) == 3
            event('Rover A held for handoff', 'Its original image and completed step are frozen into the continuation review.', 'handoff')
            try:
                request(f'/v1/handoffs/{review["id"]}/approve', {'digest': review['digest']})
            except urllib.error.HTTPError as error:
                assert error.code == 422
            else:
                raise AssertionError('Handoff dispatched before source command expiry')
        if review and not approved:
            assert states[B]['state'] != 'running', 'Target moved before approval'
            if stopped is None and states[A]['state'] == 'failed':
                stopped = states[A]['pose']
                stopped_after = round(time.monotonic() - frozen_at, 3)
                assert stopped_after < 5, 'Source watchdog did not stop promptly'
                event('Source motion stopped', f'Observed after {stopped_after}s; approval still waits for the old signed deadline.', 'safety')
            if stopped:
                drift = math.hypot(states[A]['pose']['x'] - stopped['x'], states[A]['pose']['y'] - stopped['y'])
                max_drift = max(max_drift, drift)
                assert drift < .15, 'Source moved after stop'
            ready = datetime.fromisoformat(review['not_before_at'].replace('Z', '+00:00'))
            if datetime.now(timezone.utc) >= ready and stopped:
                approved = request(f'/v1/handoffs/{review["id"]}/approve', {'digest': review['digest']})
                assert approved['status'] == 'approved'
                event('Rover B continuation approved', 'The same objective resumes at its unfinished second step with the original camera evidence.', 'approval')
        if approved and not context_seen:
            latest = next(h for h in request('/v1/handoffs') if h['id'] == review['id'])
            if latest['context_acknowledged_at']:
                approved = latest
                context_seen = True
                event('Rover B verified shared memory', 'The body fetched the retained JPEG, checked its signed hash, and acknowledged the context before ROS dispatch.', 'memory')
        time.sleep(.25)
    else:
        raise AssertionError('Two-rover round exceeded recording deadline')
    assert approved and context_seen and first_observation and stopped
    observations = [o for o in request('/v1/observations?limit=100') if o['mission_id'] in current['mission_ids']]
    assert len(observations) == 2 and current['anomaly_count'] == 1
    assert next(o for o in observations if o['id'] == first_observation['id']) == first_observation
    assert all(missions[i]['status'] == 'succeeded' for i in completed_ids)
    assert all(m['assigned_body_id'] == B for m in missions.values() if m.get('continuation'))
    assert sum(m['command'] == steps[0]['command'] for m in missions.values()) == 1, 'Completed inspection repeated'
    final = sample()[B]['pose']
    assert math.hypot(final['x'] + 3, final['y'] + 2) < .5
    event('Objective completed across two bodies', 'A’s verified bay observation remains available; B recorded the dock anomaly and returned to charge.', 'complete')
    output = ROOT / 'apps/control-center/public/demo'
    artifacts = []
    public_observations = []
    for index, observation in enumerate(sorted(observations, key=lambda o: o['captured_at'])):
        evidence = request(f'/v1/observations/{observation["id"]}/evidence')
        raw = base64.b64decode(evidence['image_base64'], validate=True)
        assert hashlib.sha256(raw).hexdigest() == observation['image_sha256']
        name = f'handoff-observation-{index + 1}.jpg'
        artifacts.append((output / name, raw))
        public_observations.append({**observation, 'image': name})
    distances = {}
    for body in paths:
        trail = [p for p in poses if p['body_id'] == body]
        distances[body] = round(sum(math.hypot(b['x'] - a['x'], b['y'] - a['y']) for a, b in zip(trail, trail[1:])), 2)
    recording.update({'duration_s': elapsed(), 'outcome': current['status'], 'anomaly_count': current['anomaly_count'], 'poses': poses, 'events': events, 'observations': public_observations, 'distance_by_body_m': distances,
        'handoff': {'id': approved['id'], 'source_body_id': A, 'target_body_id': B, 'context_digest': approved['context']['digest'], 'completed_steps': len(approved['completed_steps']), 'remaining_steps': len(approved['remaining_steps']), 'source_stop_observed_after_s': stopped_after, 'post_stop_drift_m': round(max_drift, 4), 'context_acknowledged_at': approved['context_acknowledged_at'], 'not_before_at': approved['not_before_at'], 'approved_at': approved['approved_at']}})
    # Publish the JSON last, so an incomplete run cannot appear as a successful tour.
    for path, raw in artifacts:
        path.write_bytes(raw)
        path.chmod(0o644)
    (output / 'handoff.json').write_text(json.dumps(recording, indent=2) + '\n')
    (output / 'handoff.json').chmod(0o644)
    (run_dir / 'handoff-result.json').write_text(json.dumps({'round': current, 'handoff': approved, 'recording': recording}, indent=2) + '\n')
    print(json.dumps({'result': 'passed', 'duration_s': recording['duration_s'], 'distances_m': distances, 'source_stop_observed_after_s': stopped_after, 'post_stop_drift_m': round(max_drift, 4), 'observations': len(observations), 'poses': len(poses)}, indent=2))


if __name__ == '__main__':
    main()
