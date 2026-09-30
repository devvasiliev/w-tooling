"""Composition root for API and worker dependencies."""

from __future__ import annotations

from dataclasses import dataclass

from __SERVICE_PACKAGE__.adapters.inbound.http.app import HttpDependencies
from __SERVICE_PACKAGE__.bootstrap.settings import ApiSettings, WorkerSettings


@dataclass(frozen=True, slots=True)
class SettingsReadinessProbe:
    database_url: str

    def check(self) -> bool:
        return bool(self.database_url)


@dataclass(frozen=True, slots=True)
class WorkerDependencies:
    database_url: str


def build_api_dependencies(settings: ApiSettings) -> HttpDependencies:
    return HttpDependencies(
        readiness=SettingsReadinessProbe(settings.database_url),
        service_version=settings.service_version,
        commit_sha=settings.service_revision,
    )


def build_worker(settings: WorkerSettings) -> WorkerDependencies:
    return WorkerDependencies(database_url=settings.database_url)
