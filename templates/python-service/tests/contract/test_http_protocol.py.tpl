from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from __SERVICE_PACKAGE__.adapters.inbound.http.app import HttpDependencies, create_app


class ReadinessProbe:
    def __init__(self, ready: bool) -> None:
        self.ready = ready

    def check(self) -> bool:
        return self.ready


class HttpProtocolTest(unittest.TestCase):
    def test_health_response_is_typed_and_correlated(self) -> None:
        client = TestClient(create_app(HttpDependencies(readiness=ReadinessProbe(True))))

        response = client.get("/health/live", headers={"X-Correlation-ID": "test-request"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})
        self.assertEqual(response.headers["X-Correlation-ID"], "test-request")

    def test_readiness_uses_typed_unavailable_response(self) -> None:
        client = TestClient(create_app(HttpDependencies(readiness=ReadinessProbe(False))))

        response = client.get("/health/ready", headers={"X-Correlation-ID": "test-request"})

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "unavailable"})
        self.assertEqual(response.headers["X-Correlation-ID"], "test-request")

    def test_protocol_error_uses_nested_envelope(self) -> None:
        client = TestClient(create_app(HttpDependencies(readiness=ReadinessProbe(True))))

        response = client.get("/missing", headers={"X-Correlation-ID": "test-request"})

        self.assertEqual(response.status_code, 404)
        self.assertEqual(
            response.json(),
            {
                "error": {
                    "code": "ROUTE_NOT_FOUND",
                    "message": "маршрут не найден",
                    "correlation_id": "test-request",
                }
            },
        )
        self.assertEqual(response.headers["X-Correlation-ID"], "test-request")

    def test_version_exposes_image_revision(self) -> None:
        client = TestClient(
            create_app(
                HttpDependencies(
                    readiness=ReadinessProbe(True),
                    service_version="9.8.7-test",
                    commit_sha="0123456789abcdef",
                )
            )
        )

        response = client.get("/version")

        self.assertEqual(
            response.json(),
            {
                "service": "__SERVICE_NAME__",
                "version": "9.8.7-test",
                "commit_sha": "0123456789abcdef",
            },
        )


if __name__ == "__main__":
    unittest.main()
