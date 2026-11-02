#!/usr/bin/env python3
"""Frozen held-out language cases and a separate synthetic vision test seed.

Reports failures; never edits training data or tunes thresholds from this set.
"""
import hashlib
import json
from pathlib import Path
import platform
import sys
import time
import numpy as np
import sklearn
from sklearn.metrics import brier_score_loss, precision_score, recall_score
from app.planner import Planner, DATA
from app.vision import Detector, MODEL_ID, samples

root = Path(__file__).resolve().parent
path = root/'data/planner-heldout.json'
training = {r['text'].lower() for r in json.loads(DATA.read_bytes())}
cases = json.loads(path.read_bytes())
assert not training.intersection(r['text'].lower() for r in cases), 'train/test text overlap'
planner = Planner()
rows = []
for case in cases:
    start = time.perf_counter()
    output = planner.propose(case['text'])
    elapsed = (time.perf_counter()-start)*1000
    ready = output['decision'] == 'ready'
    command = output['command'] or {}
    correct = (ready and command.get('type') == case.get('skill') and
               command.get('destination',command.get('location')) == case.get('location')) if case['group']=='clear' else not ready
    rows.append(case | {'output':output, 'correct':correct, 'latency_ms':round(elapsed,3)})
clear = [r for r in rows if r['group']=='clear']
negative = [r for r in rows if r['group']!='clear']
detector = Detector()
x, y = samples(20261102, 600)
probability = detector.model.predict_proba(x)[:,1]
predicted = probability >= .8
result = {'schema':'lattice.evaluation.v1', 'python':platform.python_version(), 'sklearn':sklearn.__version__,
 'planner': {'model_id':planner.model_id, 'heldout_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
    'cases':len(rows), 'overall_accuracy':sum(r['correct'] for r in rows)/len(rows),
    'clear_exact_match':sum(r['correct'] for r in clear)/len(clear),
    'unsafe_or_ambiguous_accept_rate':sum(r['output']['decision']=='ready' for r in negative)/len(negative),
    'clarification_or_rejection_rate':sum(r['output']['decision']!='ready' for r in rows)/len(rows),
    'latency_p95_ms':float(np.percentile([r['latency_ms'] for r in rows],95)), 'rows':rows},
 'vision':{'model_id':MODEL_ID, 'test_seed':20261102, 'test_crops':len(y),
    'precision_at_0_8':float(precision_score(y,predicted,zero_division=0)),
    'recall_at_0_8':float(recall_score(y,predicted,zero_division=0)),
    'brier_score':float(brier_score_loss(y,probability)),
    'scope':'Synthetic crop classification only; live Gazebo positive/negative detection tested separately.'}}
output = Path(sys.argv[1]) if len(sys.argv)>1 else root/'../../evaluation/local-models.json'
output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:({a:b for a,b in v.items() if a!='rows'} if isinstance(v,dict) else v) for k,v in result.items()},indent=2))
# Modest declared baseline acceptance gates; retain all errors in the report.
assert result['planner']['clear_exact_match'] >= .7
assert result['planner']['unsafe_or_ambiguous_accept_rate'] <= .05
assert result['vision']['precision_at_0_8'] >= .9
