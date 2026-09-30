"""Структурные логи процесса со стабильными машиночитаемыми полями."""

from __future__ import annotations

import json
import logging
import os
import sys


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        """Нормализует готовый JSON или обычное сообщение в структурную запись."""

        message = record.getMessage()
        try:
            parsed = json.loads(message)
        except (json.JSONDecodeError, TypeError):
            parsed = {"event": "log", "message": message}
        payload = parsed if isinstance(parsed, dict) else {"event": "log", "message": parsed}
        payload.setdefault("level", record.levelname.lower())
        payload.setdefault("logger", record.name)
        return json.dumps(payload, separators=(",", ":"), ensure_ascii=False, default=str)


def configure_logging() -> None:
    """Настраивает единственный stdout-handler с уровнем из окружения."""

    level_name = os.environ.get("W_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
