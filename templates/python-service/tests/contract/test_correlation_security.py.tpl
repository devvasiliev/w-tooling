from __future__ import annotations

import json
import logging
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.types import Message, Receive, Scope, Send

from __SERVICE_PACKAGE__.adapters.inbound.http.protocol import (
    CorrelationMiddleware,
    install_http_protocol,
)


class CorrelationSecurityTest(unittest.IsolatedAsyncioTestCase):
    async def test_disconnect_does_not_invent_response_or_success_log(self) -> None:
        logger = logging.getLogger("correlation.disconnect")
        sent: list[Message] = []

        async def downstream(scope: Scope, receive: Receive, send: Send) -> None:
            self.assertEqual((await receive())["type"], "http.disconnect")

        async def receive() -> Message:
            return {"type": "http.disconnect"}

        async def send(message: Message) -> None:
            sent.append(message)

        scope: Scope = {
            "type": "http", "method": "POST", "path": "/upload", "headers": [],
            "query_string": b"", "scheme": "http",
        }
        with self.assertNoLogs(logger, level="INFO"):
            await CorrelationMiddleware(downstream, logger=logger)(scope, receive, send)
        self.assertEqual(sent, [])

    def test_log_uses_routed_path_despite_host_and_keeps_correlation(self) -> None:
        logger = logging.getLogger("correlation.path")
        app = FastAPI()
        install_http_protocol(app, logger)
        with TestClient(app) as client, self.assertLogs(logger, level="INFO") as captured:
            response = client.get(
                "/missing", headers={"Host": "example.test/spoof", "X-Correlation-ID": "probe"},
            )
        event = json.loads(captured.records[0].getMessage())
        self.assertEqual(response.status_code, 404)
        self.assertEqual(event["path"], "/missing")
        self.assertEqual(event["status"], 404)
        self.assertEqual(event["correlation_id"], "probe")
        self.assertEqual(response.headers["X-Correlation-ID"], "probe")
        self.assertEqual(response.json()["error"]["code"], "ROUTE_NOT_FOUND")
