"""Untrusted loopback-only inference. Never receives actuator credentials."""
from contextlib import asynccontextmanager
from typing import Annotated
import threading

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from .planner import Planner
from .vision import Detector


@asynccontextmanager
async def lifespan(app):
    app.state.planner = Planner()
    app.state.detector = Detector()
    app.state.inference_lock = threading.Lock()
    yield


app = FastAPI(title='Lattice local inference', version='0.2.0', lifespan=lifespan)


@app.middleware('http')
async def bounded_body(request: Request, call_next):
    # Enforce actual streamed bytes too; Content-Length alone is not a bound.
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > 450_000:
            return JSONResponse({'detail': 'request too large'}, status_code=413)
        chunks.append(chunk)
    request._body = b''.join(chunks)
    return await call_next(request)


class ProposalRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    user_intent: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=500)]


class InspectionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    image_base64: str = Field(max_length=400_000)
    captured_at_ms: int = Field(gt=0)


@app.get('/health')
def health():
    return {'status': 'operational', 'trust_level': 'untrusted-inference-only',
            'planner_model': app.state.planner.model_id}


@app.post('/v1/proposals')
def propose(request: ProposalRequest):
    with app.state.inference_lock:
        return app.state.planner.propose(request.user_intent)


@app.post('/v1/inspections')
def inspect(request: InspectionRequest):
    try:
        with app.state.inference_lock:
            return app.state.detector.inspect(request.image_base64, request.captured_at_ms)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
