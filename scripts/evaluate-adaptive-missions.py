#!/usr/bin/env python3
"""Run actual nominal and physical-blockage missions in fresh simulator scenes.

Each case owns its processes/container through the normal durable runner. The
database and signing identity are retained. Failed cases stop the suite without
discarding held work. No sensor result is supplied by this evaluator.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]


def write(path, report):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'evaluation/adaptive-missions.json')
    parser.add_argument('--clear-events-from', type=Path,
                        help='explicitly authorize clearing only the exact prior simulator-owned event in this successful result')
    parser.add_argument('--development-failure', type=Path, action='append', default=[],
                        help='retain a prior measured development failure separately from the final scenario matrix')
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    allowed = []
    if args.clear_events_from:
        previous = json.loads(args.clear_events_from.read_text())
        assert previous['round']['status'] == 'completed'
        assert previous['recording']['schema'] == 'lattice.adaptive-route.v1'
        condition = previous['recording']['condition_observation']
        if condition:
            assert condition['body_id'] == 'gazebo-rover' and condition['status'] == 'blocked'
            allowed.append(condition['event_id'])
    report = {'schema': 'lattice.adaptive-mission-evaluation.v1',
        'recorded_at': datetime.now(timezone.utc).isoformat(),
        'scope': 'Actual Gazebo lidar and navigation plus MuJoCo Go1, in separate aligned physics worlds. Review approval is exercised by the recorder; no obstacle observation or completion is mocked.',
        'development_findings': [], 'cases': []}
    for path in args.development_failure:
        raw = path.read_bytes()
        failure = json.loads(raw)
        failed_missions = [mission for mission in failure['missions'] if mission['status'] == 'failed']
        assert failed_missions, 'A development failure needs an actual retained failed mission'
        report['development_findings'].append({
            'source_proof_sha256': hashlib.sha256(raw).hexdigest(),
            'source_proof_file': str(path), 'round_id': failure['round']['id'],
            'retained_failures': [{'mission_id': mission['id'], 'reason': mission['status_detail']}
                                  for mission in failed_missions],
            'condition_observed': failure.get('condition') is not None,
            'scope': 'Development acceptance failure retained separately; not counted as a completed final scenario.'})
    directory = Path(tempfile.mkdtemp(prefix='adaptive-evaluation-', dir=ROOT / 'target'))
    for case_name in ('nominal', 'blocked_center', 'blocked_offset'):
        print('Starting actual mission case: ' + case_name, flush=True)
        pointer = directory / (case_name + '-result.json')
        log = directory / (case_name + '.log')
        env = {**os.environ, 'LATTICE_ADAPTIVE_SHOWCASE': '1', 'LATTICE_ADAPTIVE_CASE': case_name,
            'LATTICE_ADAPTIVE_PUBLISH': '1' if case_name == 'blocked_center' else '0',
            'LATTICE_ADAPTIVE_CLEAR_EVENT_IDS': json.dumps(allowed),
            'LATTICE_ADAPTIVE_RESULT_POINTER': str(pointer)}
        with log.open('w') as stream:
            result = subprocess.run([str(ROOT / 'scripts/run-durable-adaptive-warehouse.sh')],
                cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT)
        if result.returncode != 0:
            report['cases'].append({'case_name': case_name, 'observed': 'failed',
                'exit_code': result.returncode, 'log_file': str(log.relative_to(ROOT))})
            write(args.output, report)
            raise SystemExit(f'Case failed; retained state requires review. Inspect {log}')
        proof_path = Path(json.loads(pointer.read_text())['result'])
        proof_bytes = proof_path.read_bytes()
        proof = json.loads(proof_bytes)
        recording = proof['recording']
        assert recording['outcome'] == 'completed'
        assert recording['adaptation']['repeated_inspections'] == 0
        assert len(recording['observations']) == 2
        expected_replan = case_name != 'nominal'
        assert bool(recording['replan']) == expected_replan
        if expected_replan:
            assert recording['replan']['round_id'] == recording['round_id']
            assert recording['adaptation']['completed_steps_preserved'] == 1
            assert recording['condition_observation']['evidence']['blocked_samples'] >= 3
        report['cases'].append({'case_name': case_name, 'observed': 'completed',
            'expected_replan': expected_replan, 'observed_replan': bool(recording['replan']),
            'round_id': recording['round_id'], 'map_digest': recording['plan']['map_digest'],
            'mission_duration_s': recording['mission_duration_s'],
            'recording_duration_s': recording['duration_s'],
            'pose_samples': len(recording['poses']), 'physics_samples': len(proof['physics']),
            'distance_by_body_m': recording['distance_by_body_m'],
            'adaptation': recording['adaptation'], 'obstacle': recording['obstacle'],
            'observation_hashes': [item['image_sha256'] for item in recording['observations']],
            'lidar_evidence': recording['condition_observation']['evidence'] if expected_replan else None,
            'source_proof_sha256': hashlib.sha256(proof_bytes).hexdigest(),
            'source_proof_file': str(proof_path.relative_to(ROOT))})
        if condition := recording['condition_observation']:
            allowed.append(condition['event_id'])
        write(args.output, report)
        print(f'PASS {case_name}: {recording["mission_duration_s"]:.3f}s, '
              f'replan={expected_replan}, completed inspections repeated=0', flush=True)
    report['summary'] = {'cases': len(report['cases']), 'completed': len(report['cases']),
        'expected_replans': 2, 'observed_replans': sum(case['observed_replan'] for case in report['cases']),
        'repeated_completed_inspections': sum(case['adaptation']['repeated_inspections'] for case in report['cases'])}
    write(args.output, report)
    print('Actual mission evaluation passed: ' + str(args.output), flush=True)


if __name__ == '__main__':
    main()
