#!/usr/bin/env bash

# Выбирает нативный исполнитель BuildKit Linux x86_64 для воспроизводимых образов.

project_release_select_native_buildkit() {
  local canonical_context="task-linux-amd64"
  local context="${W_RELEASE_DOCKER_CONTEXT:-}"
  local platform=""

  if [[ -n "$context" ]]; then
    docker --context "$context" info >/dev/null 2>&1 || \
      fail "release Docker context недоступен: $context"
    export DOCKER_CONTEXT="$context"
  else
    platform="$(docker info --format '{{.OSType}}/{{.Architecture}}' 2>/dev/null || true)"
    if [[ "$platform" != "linux/x86_64" ]]; then
      docker --context "$canonical_context" info >/dev/null 2>&1 || \
        fail "нативный Linux x86_64 worker недоступен; настрой Docker context $canonical_context или W_RELEASE_DOCKER_CONTEXT"
      export DOCKER_CONTEXT="$canonical_context"
    fi
  fi

  platform="$(docker info --format '{{.OSType}}/{{.Architecture}}' 2>/dev/null)" || \
    fail "Docker/BuildKit worker недоступен"
  [[ "$platform" == "linux/x86_64" ]] || \
    fail "release build требует нативный Linux x86_64 worker, выбран $platform"
  docker buildx version >/dev/null 2>&1 || fail "docker buildx недоступен"
  docker buildx inspect --bootstrap >/dev/null 2>&1 || fail "BuildKit worker не готов"

  printf 'Release BuildKit worker: context=%s platform=%s\n' \
    "${DOCKER_CONTEXT:-current}" "$platform"
}
