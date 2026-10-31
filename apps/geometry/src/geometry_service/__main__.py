"""Run the service: ``python -m geometry_service``. ``HOST``/``PORT`` bind it; logs are one JSON object a line."""

from __future__ import annotations

import json
import logging
import os


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {"level": record.levelname, "logger": record.name, "message": record.getMessage()}
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry)


def main() -> None:
    import uvicorn

    handler = logging.StreamHandler()
    handler.setFormatter(_JsonFormatter())
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper(), handlers=[handler], force=True)
    uvicorn.run(
        "geometry_service.app:app",
        host=os.environ.get("HOST", "0.0.0.0"),  # noqa: S104 - a container binds every interface
        port=int(os.environ.get("PORT", "8100")),
        log_config=None,
        access_log=False,
    )


if __name__ == "__main__":
    main()
