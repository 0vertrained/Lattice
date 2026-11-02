#!/usr/bin/env python3
"""Exercise a live Gazebo/ROS stack through the authenticated Lattice API.

Requires LATTICE_DEV_API_KEY, optional LATTICE_CORE_URL and LATTICE_BODY_ID.
This deliberately creates missions and checks real reported map displacement.
"""
import json
import math
import os
import time
import urllib.request
import urllib.error

BASE = os.getenv('LATTICE_CORE_URL', 'http://localhost:8000')
BODY = os.getenv('LATTICE_BODY_ID', 'gazebo-rover')
KEY = os.environ['LATTICE_DEV_API_KEY']
CLIENT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(BASE+path, data=data, headers={
        'x-lattice-api-key': KEY, 'Content-Type': 'application/json'})
    with CLIENT.open(req, timeout=5) as response:
        return json.load(response)


def approve(payload):
    proposal = request('/v1/proposals', payload)
    return request(f"/v1/proposals/{proposal['id']}/approve", {'digest':proposal['digest']})


def wait(predicate, seconds, message):
    deadline = time.monotonic()+seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.5)
    raise AssertionError(message)


def body():
    return next((b for b in request('/v1/bodies') if b['id'] == BODY and b['status'] == 'online' and b['pose'] is not None), None)


def mission_result(identity):
    return next((m for m in request('/v1/missions') if m['id'] == identity and m['status'] in ['succeeded','failed']), None)


def main():
    initial = wait(body, 90, 'rover did not localize/register')
    mission = approve({'title':'Warehouse navigation smoke', 'command':{
        'type':'navigate', 'destination':'loading_dock', 'max_speed_mps':.3}})
    assert mission['assigned_body_id'] == BODY, 'another body took the mission; use an isolated core'
    completed = wait(lambda: mission_result(mission['id']), 120, 'mission did not terminate')
    assert completed['status'] == 'succeeded', completed
    final = body()
    distance = math.hypot(final['pose']['x']-initial['pose']['x'], final['pose']['y']-initial['pose']['y'])
    assert distance > 1, f'no meaningful measured displacement: {distance}'
    assert math.hypot(final['pose']['x']-3.5, final['pose']['y']) < .5, final['pose']
    try:
        approve({'title':'Reject unknown destination', 'command':{
            'type':'navigate', 'destination':'not_in_this_map', 'max_speed_mps':.3}})
    except urllib.error.HTTPError as error:
        assert error.code == 422
    else:
        raise AssertionError('unknown destination passed core policy')
    blocked = approve({'title':'Unreachable occupied shelf', 'command':{
        'type':'navigate', 'destination':'blocked_shelf', 'max_speed_mps':.3}})
    failed = wait(lambda: mission_result(blocked['id']), 130, 'unreachable goal did not terminate')
    assert failed['status'] == 'failed', failed
    print(json.dumps({'unreachable_goal':'failed', 'navigation':'passed','displacement_m':round(distance,3),
        'final_pose':final['pose'],'unknown_destination':'rejected'}, indent=2))


if __name__ == '__main__':
    main()
