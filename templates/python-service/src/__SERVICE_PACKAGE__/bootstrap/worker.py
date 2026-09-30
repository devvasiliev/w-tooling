from __future__ import annotations

import json
import logging

from __SERVICE_PACKAGE__.bootstrap.container import build_worker
from __SERVICE_PACKAGE__.bootstrap.logging import configure_logging
from __SERVICE_PACKAGE__.bootstrap.settings import WorkerSettings

LOGGER = logging.getLogger("__SERVICE_PACKAGE__.worker")


def main() -> None:
    configure_logging()
    dependencies = build_worker(WorkerSettings())  # type: ignore[call-arg]
    LOGGER.info(
        json.dumps(
            {
                "event": "worker_started_without_handlers",
                "database_configured": bool(dependencies.database_url),
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
