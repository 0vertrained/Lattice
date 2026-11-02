#!/usr/bin/env python3
"""Restart this runner's core during actual Gazebo motion, then explicitly recover."""
import json
import math
import os
from pathlib import Path
import runpy
import signal
import subprocess
import time

ROOT=Path(__file__).resolve().parents[1]
api=runpy.run_path(str(ROOT/'scripts/smoke-navigation.py'))
watchdog=runpy.run_path(str(ROOT/'scripts/smoke-watchdog.py'))
request,wait,gateway=api['request'],api['wait'],watchdog['gateway']

def main():
    assert os.environ.get('LATTICE_DATABASE_URL'), 'use the durable runner'
    pid=int(os.environ['LATTICE_CORE_PID'])
    assert Path(f'/proc/{pid}/exe').resolve()==ROOT/'target/debug/lattice-core-api', 'refusing to stop an unrelated process'
    wait(api['body'],90,'rover did not localize')
    subprocess.run(['python3',str(ROOT/'scripts/smoke-intelligence.py')],check=True)
    retained={m['id']:m['evidence'] for m in request('/v1/missions') if m.get('evidence')}
    key=request('/v1/security/verification-key')
    initial=gateway()['pose']
    mission=api['approve']({'title':'Recover after a core restart during motion','command':{'type':'navigate','destination':'charging_station','max_speed_mps':.3}})
    wait(lambda: gateway()['state']=='running',15,'navigation never started')
    wait(lambda: math.hypot(gateway()['pose']['x']-initial['x'],gateway()['pose']['y']-initial['y'])>.15,15,'no real motion before restart')
    started=time.monotonic()
    os.kill(pid,signal.SIGKILL)
    run_dir=Path(os.environ['LATTICE_ROS_SOCKET']).parent
    with (run_dir/'recovery-core.log').open('w') as log:
        process=subprocess.Popen([str(ROOT/'target/debug/lattice-core-api')],stdout=log,stderr=log)
        try:
            def healthy():
                if process.poll() is not None: raise AssertionError('replacement core exited; inspect recovery-core.log')
                try: return request('/health')
                except OSError: return None
            wait(healthy,10,'replacement core did not start')
            restarted=time.monotonic()-started
            stopped=wait(lambda: (s if (s:=gateway())['state']=='failed' else None),3,'old motion continued after restart')
            stop_elapsed=time.monotonic()-started
            assert request('/v1/security/verification-key')==key
            missions={m['id']:m for m in request('/v1/missions')}
            assert missions[mission['id']]['status']=='recovery_required',missions[mission['id']]['status']
            assert all(missions[i]['evidence']==e for i,e in retained.items())
            time.sleep(3)
            now=gateway()
            drift=math.hypot(now['pose']['x']-stopped['pose']['x'],now['pose']['y']-stopped['pose']['y'])
            assert drift<.12 and now['state']=='failed', (drift,now)
            assert request('/v1/missions/reassign',{})==[], 'reassignment bypassed recovery review'
            os.kill(int(os.environ['LATTICE_BODY_PID']),0)
            print('Recovery hold reached; review UI is available.',flush=True)
            time.sleep(min(int(os.environ.get('LATTICE_RECOVERY_REVIEW_PAUSE','0')),60))
            proposal=request(f'/v1/missions/{mission["id"]}/recovery-proposal',{})
            resumed=request(f'/v1/proposals/{proposal["id"]}/approve',{'digest':proposal['digest']})
            assert resumed['id']!=mission['id']
            complete=wait(lambda: api['mission_result'](resumed['id']),120,'reviewed recovery never terminated')
            assert complete['status']=='succeeded',{k:v for k,v in complete.items() if k!='evidence'}
            final=api['body']()['pose']
            assert math.hypot(final['x']+3,final['y']+2)<.5,final
            report={'restart_recovery':'passed','core_available_after_s':round(restarted,3),'stop_observed_after_s':round(stop_elapsed,3),'post_stop_drift_m':round(drift,4),'retained_camera_results':len(retained),'automatic_resume':False,'operator_approved_recovery':'succeeded','final_pose':final}
            (run_dir/'recovery-report.json').write_text(json.dumps(report,indent=2)+'\n')
            print(json.dumps(report,indent=2),flush=True)
        finally:
            process.terminate();process.wait(timeout=10)
if __name__=='__main__': main()
