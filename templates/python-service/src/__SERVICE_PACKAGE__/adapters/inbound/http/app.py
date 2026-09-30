from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

from fastapi import FastAPI, Response

from __SERVICE_PACKAGE__ import __version__
from __SERVICE_PACKAGE__.adapters.inbound.http.dto import (
    HealthResponse,
    VersionResponse,
)
from __SERVICE_PACKAGE__.adapters.inbound.http.protocol import install_http_protocol


class ReadinessProbe(Protocol):
    def check(self) -> bool: ...


@dataclass(frozen=True, slots=True)
class HttpDependencies:
    readiness: ReadinessProbe
    service_version: str = __version__
    commit_sha: str = "unknown"


def create_app(dependencies: HttpDependencies) -> FastAPI:
    app = FastAPI(title="__SERVICE_NAME__", version=dependencies.service_version)
    install_http_protocol(app, logging.getLogger("__SERVICE_PACKAGE__.http"))

    @app.get("/health/live", response_model=HealthResponse)
    def liveness() -> HealthResponse:
        return HealthResponse(status="ok")

    @app.get("/health/ready", response_model=HealthResponse)
    def readiness(response: Response) -> HealthResponse:
        ready = dependencies.readiness.check()
        if not ready:
            response.status_code = 503
        return HealthResponse(status="ok" if ready else "unavailable")

    @app.get("/version", response_model=VersionResponse)
    def version() -> VersionResponse:
        return VersionResponse(
            service="__SERVICE_NAME__",
            version=dependencies.service_version,
            commit_sha=dependencies.commit_sha,
        )

    return app
