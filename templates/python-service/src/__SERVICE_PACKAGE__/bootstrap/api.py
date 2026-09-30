"""Исполняемый публичный HTTP-процесс, собранный composition root сервиса."""

from __future__ import annotations

import uvicorn
from fastapi import FastAPI

from __SERVICE_PACKAGE__.adapters.inbound.http.app import create_app
from __SERVICE_PACKAGE__.bootstrap.container import build_api_dependencies
from __SERVICE_PACKAGE__.bootstrap.logging import configure_logging
from __SERVICE_PACKAGE__.bootstrap.settings import ApiSettings


def create_application() -> FastAPI:
    """Собирает FastAPI factory после настройки единого структурного логирования."""

    configure_logging()
    return create_app(build_api_dependencies(ApiSettings()))  # type: ignore[call-arg]


def main() -> None:
    """Запускает публичный listener с параметрами процесса из проверенных настроек."""

    settings = ApiSettings()  # type: ignore[call-arg]
    uvicorn.run(
        "__SERVICE_PACKAGE__.bootstrap.api:create_application",
        factory=True,
        host=settings.host,
        port=settings.port,
        workers=settings.workers,
        log_config=None,
        access_log=False,
    )


if __name__ == "__main__":
    main()
