#!/usr/bin/env python3
"""Crash a real core against an isolated PostgreSQL database; no robot required.
LATTICE_TEST_DATABASE_URL must point to an empty disposable database.
"""
import base64
import concurrent.futures
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
KEY = secrets.token_hex(32)
PORT = int(os.environ.get('LATTICE_TEST_CORE_PORT', '18000'))
BASE = f'http://127.0.0.1:{PORT}'
CLIENT = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def request(path, payload=None, expected=200):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={'content-type':'application/json', 'x-lattice-api-key':KEY})
    try:
        response = CLIENT.open(req, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        assert response.status == expected, (path, response.status, raw.decode()[:250])
        return (json.loads(raw) if raw else None), response.headers

def proposal(title, command=None):
    return request('/v1/proposals', {'title':title, 'command':command or {'type':'navigate','destination':'loading_dock','max_speed_mps':.3}}, 201)[0]
def approve(p, expected=200):
    return request(f'/v1/proposals/{p["id"]}/approve', {'digest':p['digest']}, expected)[0]
def result(m, status, evidence=None):
    return request(f'/v1/missions/{m["id"]}/commands/{m["active_command_id"]}/result', {'body_id':m['assigned_body_id'], 'command_id':m['active_command_id'], 'status':status,'progress_pct':25,'detail':'integration fixture','reported_at':datetime.now(timezone.utc).isoformat(),'evidence':evidence})[0]
def heartbeat():
    return request('/v1/bodies/recovery-rover/heartbeat', {'status':'online','battery':100,'location':'warehouse','pose':{'x':0,'y':0,'yaw':0}})[0]

with tempfile.TemporaryDirectory(prefix='lattice-recovery-') as directory:
    work = Path(directory)
    keyfile = work/'signing.key'
    keyfile.write_bytes(secrets.token_bytes(32)); keyfile.chmod(0o600)
    env = {**os.environ, 'LATTICE_DEV_API_KEY':KEY,'LATTICE_BIND_ADDRESS':f'127.0.0.1:{PORT}', 'LATTICE_DATABASE_URL':os.environ['LATTICE_TEST_DATABASE_URL'], 'LATTICE_SIGNING_KEY_FILE':str(keyfile)}
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        sock.bind(('127.0.0.1',PORT))
    log = (work/'core.log').open('w+')
    process = None
    def start(expect_failure=False):
        global process
        process = subprocess.Popen([str(ROOT/'target/debug/lattice-core-api')],env=env,stdout=log,stderr=log)
        if expect_failure:
            assert process.wait(timeout=10) != 0
            return
        for _ in range(100):
            if process.poll() is not None:
                log.flush();log.seek(0);raise AssertionError(log.read())
            try:
                request('/health')
                return
            except (OSError, AssertionError): time.sleep(.05)
        raise AssertionError('core did not become healthy')
    def crash():
        process.kill();process.wait(timeout=5)
    try:
        start()
        key1, headers = request('/v1/security/verification-key'); epoch1=headers['x-lattice-core-epoch']
        request('/v1/bodies/register', {'id':'recovery-rover','display_name':'Recovery rover','kind':'rover','capabilities':['navigate','inspect'],'adapter_version':'test-1'},201)
        p = proposal('Crash during navigation')
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            approvals = list(pool.map(lambda _:approve(p),range(8)))
        assert len({m['id'] for m in approvals}) == 1
        m = approvals[0]
        old_command = request('/v1/bodies/recovery-rover/commands/next')[0]
        request('/v1/bodies/recovery-rover/commands/next',expected=204)
        result(m,'running')
        inspection = approve(proposal('Retain committed inspection evidence', {'type':'inspect','location':'inspection_bay'}))
        request('/v1/bodies/recovery-rover/commands/next')
        # A transport fixture, not a perception-accuracy test. Failure permits no detections.
        jpeg = bytes.fromhex('ffd8ffe000104a46494600010100000100010000ffd9')
        evidence = {'model_id':'transport-fixture','captured_at_ms':int(time.time()*1000),'frame_sha256':'a'*64,'image_sha256':hashlib.sha256(jpeg).hexdigest(),'image_base64':base64.b64encode(jpeg).decode(),'confidence_domain':'Persistence test fixture only','detections':[]}
        result(inspection,'failed',evidence)
        stale = proposal('Unapproved review from previous boot')
        audit_before = request('/v1/audit')[0]
        crash();start()
        key2, headers = request('/v1/security/verification-key')
        assert key1 == key2 and headers['x-lattice-core-epoch'] != epoch1
        missions = {m['id']:m for m in request('/v1/missions')[0]}
        assert missions[m['id']]['status'] == 'recovery_required'
        assert missions[inspection['id']]['evidence'] == evidence
        assert request('/v1/audit')[0][:len(audit_before)] == audit_before
        assert approve(p)['id'] == m['id']
        approve(stale,422)
        assert request('/v1/missions/reassign',{})[0] == []
        request('/v1/bodies/recovery-rover/commands/next',expected=204)
        assert result(m,'succeeded')['status'] == 'recovery_required'
        heartbeat()
        review = request(f'/v1/missions/{m["id"]}/recovery-proposal',{},201)[0]
        competing = request(f'/v1/missions/{m["id"]}/recovery-proposal',{},201)[0]
        request(f'/v1/proposals/{review["id"]}/approve',{'digest':'0'*64},422)
        resumed=approve(review);approve(competing,422)
        assert approve(review)['id']==resumed['id']
        new_command=request('/v1/bodies/recovery-rover/commands/next')[0]
        assert new_command['envelope']['sequence'] > old_command['envelope']['sequence']
        assert new_command['envelope']['command_id'] != old_command['envelope']['command_id']
        request('/v1/bodies/recovery-rover/commands/next',expected=204)
        result(resumed,'succeeded'); result(resumed,'succeeded')
        crash()
        original_seed=keyfile.read_bytes()
        keyfile.write_bytes(secrets.token_bytes(32));start(expect_failure=True)
        keyfile.unlink();start(expect_failure=True)
        keyfile.write_bytes(original_seed);keyfile.chmod(0o644);start(expect_failure=True)
        keyfile.chmod(0o600);start()
        assert request('/v1/security/verification-key')[0] == key1
        print('PASS: HTTP concurrent approval, abrupt restart, stable identity, evidence/audit retention, no replay, explicit recovery, stale-result isolation, key failure checks')
    finally:
        if process and process.poll() is None: process.terminate();process.wait(timeout=10)
        log.close()
