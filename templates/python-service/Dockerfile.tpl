ARG SERVICE_VERSION=0.1.0
ARG SERVICE_REVISION=unknown

FROM python:3.12.14-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134 AS build

WORKDIR /build

COPY requirements-build.lock ./
RUN python -m pip install --no-cache-dir --require-hashes --requirement requirements-build.lock

COPY pyproject.toml README.md ./
COPY src ./src
RUN python -m pip wheel --no-cache-dir --no-deps --no-build-isolation --wheel-dir /wheels .

FROM python:3.12.14-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134 AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN groupadd --system task && useradd --system --gid task --home /nonexistent task

COPY requirements.lock ./
RUN python -m pip install --no-cache-dir --require-hashes --requirement requirements.lock

COPY pyproject.toml README.md ./
COPY --from=build /wheels /wheels
RUN python -m pip install --no-cache-dir --no-deps --no-index /wheels/*.whl \
    && rm -rf /wheels
COPY migrations ./migrations

RUN chmod -R a+rX /app
USER task
EXPOSE __SERVICE_PORT__

CMD ["__SERVICE_NAME__-api"]

FROM runtime AS test

USER root
COPY requirements-build.lock requirements-lock-tool.lock requirements-test.lock requirements-dev.lock ./
COPY requirements ./requirements
RUN python -m pip install --no-cache-dir --require-hashes --requirement requirements-dev.lock
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY Dockerfile release.env ./
ENV MYPY_CACHE_DIR=/tmp/mypy-cache \
    PYTHONPYCACHEPREFIX=/tmp/python-cache \
    RUFF_CACHE_DIR=/tmp/ruff-cache
RUN chmod -R a+rX /app
USER task

CMD ["python", "-m", "unittest", "discover", "-s", "tests", "-v"]

FROM runtime AS production

ARG SERVICE_VERSION
ARG SERVICE_REVISION

LABEL org.opencontainers.image.version="${SERVICE_VERSION}" \
    org.opencontainers.image.revision="${SERVICE_REVISION}"

ENV W_SERVICE_VERSION="${SERVICE_VERSION}" \
    W_SERVICE_REVISION="${SERVICE_REVISION}"
