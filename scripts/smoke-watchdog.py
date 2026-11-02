#!/usr/bin/env python3
"""Suspend the supplied local body agent, verify stop/failure, then resume it.

Run only against the isolated warehouse demo. Requires LATTICE_BODY_PID and
LATTICE_ROS_SOCKET in addition to the navigation smoke test's API settings.
"""
import json
import os
from pathlib import Path
import runpy
import signal
import socket
import time

api = runpy.run_path(str(Path(__file__).with_name('smoke-navigation.py')))
request, wait = api['request'], api['wait']


def gateway():
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(2)
        client.connect(os.environ['LATTICE_ROS_SOCKET'])
        client.sendall(b'{"op":"status"}\n')
        return json.loads(client.makefile('r').readline())


def main():
    pid = int(os.environ['LATTICE_BODY_PID'])
    executable = Path(f'/proc/{pid}/exe').resolve().name
    assert executable == 'lattice-ros2-body', 'refusing to suspend an unrelated process'
    mission = api['approve']({'title':'Connection watchdog check', 'command':{
        'type':'navigate','destination':'charging_station','max_speed_mps':.3}})
    wait(lambda: gateway()['state']=='running', 15, 'goal never started')
    time.sleep(1)
    stopped_at = time.monotonic()
    os.kill(pid, signal.SIGSTOP)
    try:
        state = wait(lambda: (s if (s:=gateway())['state']=='failed' else None), 5,
                     'gateway did not stop on body loss')
        assert state['detail']=='core/body connection watchdog', state
    finally:
        os.kill(pid, signal.SIGCONT)
    elapsed = time.monotonic()-stopped_at
    failed = wait(lambda: api['mission_result'](mission['id']), 10, 'failure not reported after reconnection')
    assert failed['status']=='failed', failed
    time.sleep(1)
    assert gateway()['state']=='failed', 'stopped goal resumed on reconnection'
    print(json.dumps({'watchdog':'passed','failure_report':'passed',
                     'automatic_resume':False,'stop_observed_after_s':round(elapsed,3)},indent=2))


if __name__ == '__main__':
    main()
