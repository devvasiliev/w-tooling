"""Сквозная корреляция HTTP, конверты ошибок и обработка исключений."""

from __future__ import annotations

import json
import logging
import re
import time
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from __SERVICE_PACKAGE__.adapters.inbound.http.dto import ErrorDetail, ErrorResponse

CORRELATION_HEADER = "X-Correlation-ID"
CORRELATION_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


class CorrelationMiddleware:
    """Добавляет корреляцию без требования обязательного HTTP-ответа downstream."""

    def __init__(self, app: ASGIApp, *, logger: logging.Logger) -> None:
        """Сохраняет ASGI-приложение и журнал HTTP-границы без обёртки ответа."""
        self._app = app
        self._logger = logger

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Пропускает disconnect без ответа и журналирует только начатый ответ."""

        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        request = Request(scope)
        supplied = request.headers.get(CORRELATION_HEADER, "")
        current_correlation_id = supplied if CORRELATION_ID.fullmatch(supplied) else str(uuid4())
        request.state.correlation_id = current_correlation_id
        started = time.monotonic()
        response_status: int | None = None

        async def correlated_send(message: Message) -> None:
            nonlocal response_status
            if message["type"] == "http.response.start":
                response_status = message["status"]
                MutableHeaders(scope=message)[CORRELATION_HEADER] = current_correlation_id
            await send(message)

        await self._app(scope, receive, correlated_send)
        if response_status is None:
            return
        self._logger.info(
            json.dumps(
                {
                    "event": "http_request",
                    "correlation_id": current_correlation_id,
                    "method": request.method,
                    "path": request.scope["path"],
                    "status": response_status,
                    "duration_ms": round((time.monotonic() - started) * 1000, 2),
                },
                separators=(",", ":"),
            )
        )


def correlation_id(request: Request) -> str:
    """Возвращает установленный correlation id либо безопасный fallback для ранней ошибки."""

    value = getattr(request.state, "correlation_id", None)
    return value if isinstance(value, str) else str(uuid4())


def error_response(request: Request, status: int, code: str, message: str) -> JSONResponse:
    """Собирает единый публичный конверт ошибки с correlation id запроса."""

    payload = ErrorResponse(
        error=ErrorDetail(
            code=code,
            message=message,
            correlation_id=correlation_id(request),
        )
    )
    return JSONResponse(status_code=status, content=payload.model_dump())


def install_http_protocol(app: FastAPI, logger: logging.Logger) -> None:
    """Устанавливает корреляцию запросов и единые конверты HTTP-ошибок."""

    app.add_middleware(CorrelationMiddleware, logger=logger)

    @app.exception_handler(RequestValidationError)
    async def request_validation_error(
        request: Request, _error: RequestValidationError
    ) -> JSONResponse:
        """Скрывает детали Pydantic за стабильной публичной ошибкой валидации."""

        return error_response(request, 422, "VALIDATION_ERROR", "проверка запроса не пройдена")

    @app.exception_handler(HTTPException)
    async def protocol_error(request: Request, error: HTTPException) -> JSONResponse:
        """Преобразует инфраструктурную HTTP-ошибку в контракт сервиса."""

        code = "ROUTE_NOT_FOUND" if error.status_code == 404 else "HTTP_ERROR"
        message = (
            "маршрут не найден" if error.status_code == 404 else "HTTP-запрос завершился ошибкой"
        )
        return error_response(request, error.status_code, code, message)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, error: Exception) -> JSONResponse:
        """Записывает тип неожиданного сбоя и не раскрывает внутренние детали клиенту."""

        logger.error(
            json.dumps(
                {
                    "event": "http_unexpected_error",
                    "correlation_id": correlation_id(request),
                    "error_type": type(error).__name__,
                },
                separators=(",", ":"),
            )
        )
        return error_response(request, 500, "INTERNAL_ERROR", "внутренняя ошибка сервиса")
