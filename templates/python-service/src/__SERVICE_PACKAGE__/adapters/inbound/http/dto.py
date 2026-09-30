"""HTTP transport DTO."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class TransportDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")


class HealthResponse(TransportDTO):
    status: Literal["ok", "unavailable"]


class VersionResponse(TransportDTO):
    service: str
    version: str
    commit_sha: str


class ErrorDetail(TransportDTO):
    code: str
    message: str
    correlation_id: str


class ErrorResponse(TransportDTO):
    error: ErrorDetail
