# Local inference service

CPU-only intent classification and camera-marker detection. See
[the intelligence demo](../../docs/INTELLIGENCE_DEMO.md) for model cards, evaluation,
training/calibration/test splits, approval contracts and scope.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001
```

This service is untrusted and has no actuator API, body credential or signing key.
It returns proposals and image evidence to Rust. It does not grant approval.
Keep its unauthenticated inference port on loopback or a private Compose network.
The warehouse runner starts it automatically without the development API key.

```bash
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 .venv/bin/python -m unittest discover -s tests -v
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 .venv/bin/python evaluate.py ../../evaluation/local-models.json
```
