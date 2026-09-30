from __future__ import annotations

from urllib.parse import urlparse

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from __SERVICE_PACKAGE__ import __version__


class DatabaseSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="__SERVICE_ENV_PREFIX__",
        case_sensitive=False,
        extra="ignore",
    )

    database_url: str

    @field_validator("database_url")
    @classmethod
    def validate_database_url(cls, value: str) -> str:
        parsed = urlparse(value)
        if (
            parsed.scheme not in {"postgresql", "postgresql+psycopg"}
            or not parsed.username
            or not parsed.path.strip("/")
        ):
            raise ValueError("database_url must identify a PostgreSQL database and user")
        return value


class ApiSettings(DatabaseSettings):
    service_version: str = Field(
        default=__version__,
        min_length=1,
        validation_alias="W_SERVICE_VERSION",
    )
    service_revision: str = Field(
        default="unknown",
        min_length=1,
        validation_alias="W_SERVICE_REVISION",
    )
    host: str = "0.0.0.0"
    port: int = Field(default=__SERVICE_PORT__, ge=1, le=65535)
    workers: int = Field(default=1, ge=1, le=32)


class WorkerSettings(DatabaseSettings):
    pass
