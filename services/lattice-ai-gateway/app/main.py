"""Untrusted AI proposal boundary.

No body credentials, command-signing keys, ROS publishers, or actuator APIs
belong in this process.
"""

from enum import StrEnum
from typing import Annotated, Literal

from fastapi import FastAPI
from pydantic import BaseModel, Field, StringConstraints

SemanticName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=100),
]


class Skill(StrEnum):
    """Small proposal vocabulary for the first milestone."""

    NAVIGATE = "navigate"
    INSPECT = "inspect"


class ProposalRequest(BaseModel):
    """Bounded untrusted natural-language input."""

    user_intent: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=3, max_length=500),
    ]
    suggested_location: SemanticName | None = None


class SkillProposal(BaseModel):
    """Typed proposal that still requires Rust policy validation."""

    schema_version: Literal["lattice.skill-proposal.v1"] = "lattice.skill-proposal.v1"
    skill: Skill
    location: SemanticName
    confidence: float = Field(ge=0.0, le=1.0)
    requires_human_approval: Literal[True] = True
    rationale: Annotated[str, StringConstraints(max_length=300)]


app = FastAPI(title="Lattice AI Gateway", version="0.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    """Expose process health and trust level."""

    return {"status": "operational", "trust_level": "untrusted-proposal-only"}


@app.post("/v1/proposals", response_model=SkillProposal)
def propose(request: ProposalRequest) -> SkillProposal:
    """Return a deterministic development proposal.

    A future model integration must still emit this exact bounded schema.
    """

    location = request.suggested_location or "operator_defined_location"
    intent = request.user_intent.lower()
    skill = (
        Skill.INSPECT
        if any(word in intent for word in ("inspect", "check", "look"))
        else Skill.NAVIGATE
    )
    return SkillProposal(
        skill=skill,
        location=location,
        confidence=0.5,
        rationale="Development placeholder; Rust policy validation is still required.",
    )
