#!/usr/bin/env python3
"""Record a real Gazebo inspection round, including a deliberate core restart.
Run only through LATTICE_SHOWCASE=1 scripts/run-durable-warehouse.sh.
Exports camera evidence and measured telemetry; never synthesizes a robot trace.
"""
import base64
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import runpy
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
api = runpy.run_path(str(ROOT / 'scripts/smoke-navigation.py'))
watchdog = runpy.run_path(str(ROOT / 'scripts/smoke-watchdog.py'))
request, wait, gateway = api['request'], api['wait'], watchdog['gateway']


def main():
    assert os.environ.get('LATTICE_DATABASE_URL'), 'Use the durable warehouse runner'
    pid = int(os.environ['LATTICE_CORE_PID'])
    assert Path(f'/proc/{pid}/exe').resolve() == ROOT / 'target/debug/lattice-core-api'
    run_dir = Path(os.environ['LATTICE_ROS_SOCKET']).parent
    wait(api['body'], 90, 'Rover did not localize')
    steps = [
        {'title': 'Verify the inspection bay', 'command': {'type': 'inspect', 'location': 'inspection_bay'}, 'continue_on_missing_marker': False},
        {'title': 'Check the loading dock', 'command': {'type': 'inspect', 'location': 'loading_dock'}, 'continue_on_missing_marker': True},
        {'title': 'Return to the charging station', 'command': {'type': 'navigate', 'destination': 'charging_station', 'max_speed_mps': .3}, 'continue_on_missing_marker': False},
    ]
    proposal = request('/v1/rounds', {'steps': steps})
    start = time.monotonic()
    recorded_at = datetime.now(timezone.utc).isoformat()
    approved = request(f'/v1/rounds/{proposal["id"]}/approve', {'digest': proposal['digest']})
    poses, events, seen = [], [], {}
    replacement = None
    recovery = None
    retained = {}
    key = request('/v1/security/verification-key')

    def elapsed():
        return round(time.monotonic() - start, 3)

    def event(title, detail, kind='mission'):
        events.append({'t': elapsed(), 'title': title, 'detail': detail, 'kind': kind})
        print(f'{elapsed():6.1f}s {title}: {detail}', flush=True)

    def sample():
        state = gateway()
        if state.get('pose'):
            p = state['pose']
            poses.append({'t': elapsed(), 'x': p['x'], 'y': p['y'], 'yaw': p['yaw'], 'mission_id': current.get('current_mission_id') or '', 'status': state['state']})
        return state

    event('Round approved', 'A single digest binds all three steps and the missing-marker continuation policy.', 'approval')
    current = approved
    deadline = time.monotonic() + 360
    try:
        while time.monotonic() < deadline:
            current = next(r for r in request('/v1/rounds') if r['id'] == proposal['id'])
            missions = {m['id']: m for m in request('/v1/missions') if m['id'] in current['mission_ids']}
            state = sample()
            for identity, m in missions.items():
                if seen.get(identity) != m['status']:
                    seen[identity] = m['status']
                    event(m['title'], m['status'], 'anomaly' if m['status'] == 'failed' else 'mission')
                if m.get('evidence'):
                    retained[identity] = m['evidence']
            if current['status'] in ('failed', 'completed'):
                assert current['status'] == 'completed', f'Round failed: {current}'
                break
            if current['current_step'] == 2 and state['state'] == 'running' and recovery is None:
                initial = state['pose']
                # Record real motion on the return leg before interrupting its core.
                until = time.monotonic() + 12
                while time.monotonic() < until:
                    time.sleep(.25)
                    moving = sample()
                    if math.hypot(moving['pose']['x'] - initial['x'], moving['pose']['y'] - initial['y']) > .25:
                        break
                else:
                    raise AssertionError('Return leg did not move before restart')
                event('Core interrupted during motion', 'The body must stop and the interrupted round must remain held.', 'recovery')
                killed_at = time.monotonic()
                os.kill(pid, signal.SIGKILL)
                with (run_dir / 'showcase-core.log').open('w') as log:
                    replacement = subprocess.Popen([str(ROOT / 'target/debug/lattice-core-api')], stdout=log, stderr=log)
                while time.monotonic() - killed_at < 5:
                    stopped = sample()
                    if stopped['state'] == 'failed':
                        break
                    time.sleep(.05)
                else:
                    raise AssertionError('Old motion continued after core restart')
                stop_elapsed = time.monotonic() - killed_at
                def healthy():
                    if replacement.poll() is not None:
                        raise AssertionError('Replacement core exited; inspect showcase-core.log')
                    try:
                        return request('/health')
                    except OSError:
                        return None
                wait(healthy, 10, 'Replacement core did not start')
                held = next(r for r in request('/v1/rounds') if r['id'] == proposal['id'])
                assert held['status'] == 'recovery_required'
                assert request('/v1/security/verification-key') == key
                persisted = {m['id']: m for m in request('/v1/missions')}
                assert all(persisted[i]['evidence'] == e for i, e in retained.items())
                for _ in range(16):
                    time.sleep(.25)
                    held_state = sample()
                drift = math.hypot(held_state['pose']['x'] - stopped['pose']['x'], held_state['pose']['y'] - stopped['pose']['y'])
                assert drift < .12 and held_state['state'] == 'failed'
                assert request('/v1/missions/reassign', {}) == []
                event('Recovery requires review', 'Camera evidence and history survived. No automatic motion resumed.', 'recovery')
                p = request(f'/v1/missions/{held["current_mission_id"]}/recovery-proposal', {})
                assert 'round' in p['input']['rationale']
                resumed = request(f'/v1/proposals/{p["id"]}/approve', {'digest': p['digest']})
                assert resumed['id'] != held['current_mission_id']
                event('Recovery approved', 'A fresh reviewed command resumes the remaining round step.', 'approval')
                recovery = {'stop_observed_after_s': round(stop_elapsed, 3), 'post_stop_drift_m': round(drift, 4), 'automatic_resume': False, 'operator_approved_recovery': 'succeeded'}
            time.sleep(.25)
        else:
            raise AssertionError('Round exceeded recording deadline')
        assert recovery and len(retained) == 2 and current['anomaly_count'] == 1
        final = sample()['pose']
        assert math.hypot(final['x'] + 3, final['y'] + 2) < .5
        event('Round completed', 'Two stations inspected, one marker anomaly retained, and the rover returned to charge.', 'complete')
        output = ROOT / 'apps/control-center/public/demo'
        output.mkdir(parents=True, exist_ok=True)
        evidence = []
        for index, (identity, value) in enumerate(retained.items()):
            raw = base64.b64decode(value['image_base64'], validate=True)
            assert hashlib.sha256(raw).hexdigest() == value['image_sha256']
            filename = f'inspection-{index + 1}.jpg'
            (output / filename).write_bytes(raw)
            evidence.append({'title': missions[identity]['title'], 'outcome': missions[identity]['status'], 'image': filename, **{k: v for k, v in value.items() if k != 'image_base64'}})
        assert evidence[0]['detections'] and not evidence[1]['detections']
        distance = sum(math.hypot(b['x'] - a['x'], b['y'] - a['y']) for a, b in zip(poses, poses[1:]))
        recording = {'schema': 'lattice.walkthrough.v1', 'recorded_at': recorded_at, 'duration_s': elapsed(), 'distance_m': round(distance, 2), 'round_id': current['id'], 'digest': current['digest'], 'outcome': current['status'], 'anomaly_count': current['anomaly_count'], 'steps': steps, 'poses': poses, 'events': events, 'evidence': evidence, 'recovery': recovery}
        (output / 'walkthrough.json').write_text(json.dumps(recording, indent=2) + '\n')
        (run_dir / 'showcase-round.json').write_text(json.dumps({'round': current, 'missions': list(missions.values()), 'recording': recording}, indent=2) + '\n')
        print(json.dumps({'result': 'passed', 'poses': len(poses), 'distance_m': recording['distance_m'], 'duration_s': recording['duration_s'], 'recovery': recovery}, indent=2))
    finally:
        if replacement and replacement.poll() is None:
            replacement.terminate()
            replacement.wait(timeout=10)


if __name__ == '__main__':
    main()
