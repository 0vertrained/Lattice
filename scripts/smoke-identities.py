#!/usr/bin/env python3
"""Real HTTP authorization, robot revocation, round sequencing and revision-fencing tests.
Requires an empty disposable LATTICE_TEST_DATABASE_URL. Uses a local test RSA issuer.
"""
import base64
from datetime import datetime,timezone
import hashlib
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from cryptography.hazmat.primitives.asymmetric import rsa,padding
from cryptography.hazmat.primitives import hashes
ROOT=Path(__file__).resolve().parents[1]
CLIENT=urllib.request.build_opener(urllib.request.ProxyHandler({}))
ISSUER='http://127.0.0.1:18181'
PRIVATE=rsa.generate_private_key(public_exponent=65537,key_size=2048)
def b64(value):return base64.urlsafe_b64encode(value).rstrip(b'=').decode()
public=PRIVATE.public_key().public_numbers()
JWK={'kty':'RSA','use':'sig','alg':'RS256','kid':'test-key','n':b64(public.n.to_bytes((public.n.bit_length()+7)//8,'big')),'e':b64(public.e.to_bytes(3,'big'))}
class Provider(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  body=json.dumps({'keys':[JWK]}).encode();self.send_response(200);self.send_header('content-type','application/json');self.send_header('content-length',str(len(body)));self.end_headers();self.wfile.write(body)
def token(role='operator',**overrides):
 now=int(time.time());claims={'sub':f'test-{role}','iss':ISSUER,'aud':'lattice-api','iat':now,'exp':now+300,'realm_access':{'roles':[f'lattice-{role}']},**overrides}
 header=b64(json.dumps({'alg':'RS256','kid':'test-key'}).encode());payload=b64(json.dumps(claims).encode());data=f'{header}.{payload}'.encode()
 return f'{data.decode()}.{b64(PRIVATE.sign(data,padding.PKCS1v15(),hashes.SHA256()))}'
def req(path,data=None,credential=None,expected=200,port=18180,headers=None):
 headers={'content-type':'application/json',**(headers or {})}
 if credential:headers['authorization']='Bearer '+credential
 request=urllib.request.Request(f'http://127.0.0.1:{port}'+path,data=None if data is None else json.dumps(data).encode(),headers=headers)
 try:response=CLIENT.open(request,timeout=6)
 except urllib.error.HTTPError as e:response=e
 with response:
  raw=response.read();assert response.status==expected,(path,response.status,expected,raw[:140]);return json.loads(raw) if raw and response.headers.get_content_type()=='application/json' else None
def body_input(identity):return {'id':identity,'display_name':'Identity test rover','kind':'rover','capabilities':['navigate','inspect'],'adapter_version':'test-1'}
def report(m,status,credential,evidence=None,port=18180):
 return req(f'/v1/missions/{m["id"]}/commands/{m["active_command_id"]}/result',{'command_id':m['active_command_id'],'body_id':m['assigned_body_id'],'status':status,'progress_pct':100 if status=='succeeded' else 0,'detail':'test result','reported_at':datetime.now(timezone.utc).isoformat(),'evidence':evidence},credential,port=port)
with tempfile.TemporaryDirectory(prefix='lattice-identity-') as directory:
 work=Path(directory);key=work/'signing.key';key.write_bytes(secrets.token_bytes(32));key.chmod(0o600)
 server=ThreadingHTTPServer(('127.0.0.1',18181),Provider);threading.Thread(target=server.serve_forever,daemon=True).start()
 env={**os.environ,'LATTICE_AUTH_MODE':'oidc','LATTICE_OIDC_ISSUER':ISSUER,'LATTICE_OIDC_JWKS_URL':ISSUER+'/jwks','LATTICE_OIDC_AUDIENCE':'lattice-api','LATTICE_OIDC_CLIENT_ID':'lattice-ui','LATTICE_DATABASE_URL':os.environ['LATTICE_TEST_DATABASE_URL'],'LATTICE_SIGNING_KEY_FILE':str(key),'LATTICE_ALLOW_CORE_TAKEOVER':'1','NO_PROXY':os.environ.get('NO_PROXY','')+',localhost,127.0.0.1'}
 processes=[];log=(work/'core.log').open('w+')
 def start(port):
  with socket.socket() as sock:sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);sock.bind(('127.0.0.1',port))
  p=subprocess.Popen([str(ROOT/'target/debug/lattice-core-api')],env={**env,'LATTICE_BIND_ADDRESS':f'127.0.0.1:{port}'},stdout=log,stderr=log);processes.append(p)
  for _ in range(100):
   if p.poll() is not None:log.flush();log.seek(0);raise AssertionError(log.read())
   try:req('/ready',port=port);return p
   except (OSError,AssertionError):time.sleep(.05)
  raise AssertionError('core startup timed out')
 try:
  start(18180);admin,operator,viewer=token('admin'),token(),token('viewer')
  req('/v1/missions',expected=401)
  req('/v1/missions',headers={'x-lattice-api-key':'a'*32},expected=401)
  for invalid in [operator[:-8]+'AAAAAAAA',token(exp=int(time.time())-20),token(aud='another-api'),token(iss='https://untrusted.example'),token(iat=int(time.time())+60),token(exp=None)]:req('/v1/missions',credential=invalid,expected=401)
  req('/v1/missions',credential=viewer)
  req('/v1/proposals',{'title':'Forbidden viewer task','command':{'type':'inspect','location':'inspection_bay'}},viewer,403)
  req('/v1/devices',credential=operator,expected=403)
  req('/v1/bodies/register',body_input('robot-alpha'),admin,403)
  device=req('/v1/devices',{'body_id':'robot-alpha','label':'Test device','expires_in_days':1},admin,201)
  robot=device['token'];req('/v1/bodies/register',body_input('robot-alpha'),robot,201)
  req('/v1/bodies/register',body_input('robot-beta'),robot,403)
  req('/v1/bodies/robot-beta/commands/next',credential=robot,expected=403)
  req('/v1/proposals',{'title':'Forbidden robot task','command':{'type':'inspect','location':'inspection_bay'}},robot,403)
  req('/v1/devices',credential=robot,expected=403)
  req('/v1/devices/'+device['credential']['id']+'/revoke',{},admin,204)
  req('/v1/security/verification-key',credential=robot,expected=401)
  robot=req('/v1/devices',{'body_id':'robot-alpha','label':'Rotated device','expires_in_days':1},admin,201)['token']
  req('/v1/bodies/register',body_input('robot-alpha'),robot,201)
  steps=[{'title':'Inspect station','command':{'type':'inspect','location':'inspection_bay'},'continue_on_missing_marker':True},{'title':'Return to charge','command':{'type':'navigate','destination':'charging_station','max_speed_mps':.3},'continue_on_missing_marker':False}]
  invalid=[dict(steps[1],continue_on_missing_marker=True),steps[0]]
  req('/v1/rounds',{'steps':invalid},operator,422)
  review=req('/v1/rounds',{'steps':steps},operator,201)
  req('/v1/rounds/'+review['id']+'/approve',{'digest':'0'*64},operator,422)
  req('/v1/rounds/'+review['id']+'/approve',{'digest':review['digest'],'steps':steps},operator,422)
  req('/v1/rounds/'+review['id']+'/approve',{'digest':review['digest']},viewer,403)
  approved=req('/v1/rounds/'+review['id']+'/approve',{'digest':review['digest']},operator)
  assert req('/v1/rounds/'+review['id']+'/approve',{'digest':review['digest']},operator)['current_mission_id']==approved['current_mission_id']
  command=req('/v1/bodies/robot-alpha/commands/next',credential=robot);first=next(m for m in req('/v1/missions',credential=operator) if m['id']==approved['current_mission_id'])
  # A capture/navigation failure has no image and must stop even with missing-marker continuation approved.
  report(first,'failed',robot)
  assert next(r for r in req('/v1/rounds',credential=operator) if r['id']==review['id'])['status']=='failed'
  req('/v1/bodies/robot-alpha/commands/next',credential=robot,expected=204)
  review=req('/v1/rounds',{'steps':steps},operator,201);approved=req('/v1/rounds/'+review['id']+'/approve',{'digest':review['digest']},operator)
  command=req('/v1/bodies/robot-alpha/commands/next',credential=robot);first=next(m for m in req('/v1/missions',credential=operator) if m['id']==approved['current_mission_id'])
  image=bytes.fromhex('ffd8ffe000104a46494600010100000100010000ffd9')
  evidence={'model_id':'transport-fixture','captured_at_ms':int(time.time()*1000),'frame_sha256':'a'*64,'image_sha256':hashlib.sha256(image).hexdigest(),'image_base64':base64.b64encode(image).decode(),'confidence_domain':'Transport fixture, not a perception test','detections':[]}
  report(first,'failed',robot,evidence);report(first,'failed',robot,evidence)
  round_now=next(r for r in req('/v1/rounds',credential=operator) if r['id']==review['id']);assert round_now['current_step']==1 and len(round_now['mission_ids'])==2 and round_now['anomaly_count']==1
  command=req('/v1/bodies/robot-alpha/commands/next',credential=robot);req('/v1/bodies/robot-alpha/commands/next',credential=robot,expected=204)
  # A new revision claims ownership; the old process remains alive but loses read/write authority.
  start(18182);req('/ready',expected=503);req('/v1/missions',credential=operator,expected=503)
  held=next(r for r in req('/v1/rounds',credential=operator,port=18182) if r['id']==review['id']);assert held['status']=='recovery_required'
  assert req('/v1/proposals',credential=operator,port=18182)==[]
  req('/v1/bodies/robot-alpha/commands/next',credential=robot,port=18182,expected=204)
  req('/v1/bodies/robot-alpha/heartbeat',{'status':'online','battery':100,'location':'warehouse','pose':None},robot,port=18182)
  p=req(f'/v1/missions/{held["current_mission_id"]}/recovery-proposal',{},operator,port=18182,expected=201)
  assert 'round' in p['input']['rationale']
  resumed=req(f'/v1/proposals/{p["id"]}/approve',{'digest':p['digest']},operator,port=18182)
  current=next(r for r in req('/v1/rounds',credential=operator,port=18182) if r['id']==review['id']);assert current['current_mission_id']==resumed['id'] and current['status']=='active'
  req('/v1/bodies/robot-alpha/commands/next',credential=robot,port=18182)
  report(resumed,'succeeded',robot,port=18182)
  assert next(r for r in req('/v1/rounds',credential=operator,port=18182) if r['id']==review['id'])['status']=='completed'
  print('PASS: JWT verification failures, viewer/operator/admin boundaries, device binding/revocation, immutable rounds, conditional anomaly continuation, idempotent advancement, live revision fencing, round recovery')
 finally:
  for p in processes:
   if p.poll() is None:p.terminate();p.wait(timeout=10)
  server.shutdown();server.server_close();log.close()
