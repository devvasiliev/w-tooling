"""Исполняемый публичный HTTP-процесс, собранный composition root сервиса."""

from __future__ import annotations

import ipaddress
import socket

import uvicorn
from fastapi import FastAPI

from __SERVICE_PACKAGE__.adapters.inbound.http.app import create_app
from __SERVICE_PACKAGE__.bootstrap.container import build_api_dependencies
from __SERVICE_PACKAGE__.bootstrap.logging import configure_logging
from __SERVICE_PACKAGE__.bootstrap.settings import ApiSettings


def resolve_trusted_proxy_ips(hosts: list[str]) -> list[str]:
    """Разрешает настроенные proxy hosts в точные IP до запуска listener."""

    resolved: set[str] = set()
    for host in hosts:
        try:
            resolved.add(str(ipaddress.ip_address(host)))
            continue
        except ValueError:
            pass
        try:
            addresses = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise RuntimeError(f"trusted reverse proxy не разрешается: {host}") from exc
        host_addresses = {str(ipaddress.ip_address(address[4][0])) for address in addresses}
        if not host_addresses:
            raise RuntimeError(f"trusted reverse proxy не имеет IP: {host}")
        resolved.update(host_addresses)
    return sorted(resolved)


def create_application() -> FastAPI:
    """Собирает FastAPI factory после настройки единого структурного логирования."""

    configure_logging()
    return create_app(build_api_dependencies(ApiSettings()))  # type: ignore[call-arg]


def main() -> None:
    """Запускает публичный listener с параметрами процесса из проверенных настроек."""

    settings = ApiSettings()  # type: ignore[call-arg]
    trusted_proxy_ips = resolve_trusted_proxy_ips(settings.trusted_proxy_hosts)
    uvicorn.run(
        "__SERVICE_PACKAGE__.bootstrap.api:create_application",
        factory=True,
        host=settings.host,
        port=settings.port,
        workers=settings.workers,
        log_config=None,
        access_log=False,
        proxy_headers=bool(trusted_proxy_ips),
        forwarded_allow_ips=trusted_proxy_ips,
    )


if __name__ == "__main__":
    main()
