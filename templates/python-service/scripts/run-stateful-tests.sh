#!/usr/bin/env bash
# Управляет жизненным циклом интеграционных тестов с PostgreSQL и сервисами в Docker.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

compose_file="$repository_root/compose.stateful.yaml"
services_file="$repository_root/tests/stateful-services.txt"
project_default="$(basename "$repository_root" | tr '[:upper:]_' '[:lower:]-')-stateful"
project_name="${W_STATEFUL_PROJECT:-$project_default}"

dependency_services=()
bootstrap_services=()
cleanup_required=0

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

read_services() {
  local raw
  local line
  [[ -f "$services_file" ]] || fail "Не найден $services_file."
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    line="${raw%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    if [[ "$line" == run:* ]]; then
      line="${line#run:}"
      [[ "$line" =~ ^[a-z0-9][a-z0-9-]*$ ]] \
        || fail "Недопустимый bootstrap service в $services_file: $line"
      bootstrap_services+=("$line")
      continue
    fi
    [[ "$line" =~ ^[a-z0-9][a-z0-9-]*$ ]] \
      || fail "Недопустимый dependency service в $services_file: $line"
    dependency_services+=("$line")
  done < "$services_file"
  ((${#dependency_services[@]} > 0)) \
    || fail "$services_file не содержит stateful dependencies."
}

dependency_image() {
  local fingerprint
  fingerprint="$(
    for path in \
      Dockerfile \
      pyproject.toml \
      requirements-build.lock \
      requirements-dev.lock \
      requirements-lock-tool.lock \
      requirements-test.lock \
      requirements.lock
    do
      git hash-object "$path"
    done | git hash-object --stdin
  )"
  printf '%s\n' "${W_STATEFUL_TEST_IMAGE:-$(basename "$repository_root")-stateful-test:${fingerprint:0:16}}"
}

require_tools() {
  command -v docker >/dev/null 2>&1 || fail "Docker не найден."
  command -v git >/dev/null 2>&1 || fail "Git не найден."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin недоступен."
}

ensure_image() {
  if docker image inspect "$W_STATEFUL_TEST_IMAGE" >/dev/null 2>&1; then
    printf 'Stateful dependency image готов: %s\n' "$W_STATEFUL_TEST_IMAGE"
    return
  fi
  printf 'Собирается stateful dependency image: %s\n' "$W_STATEFUL_TEST_IMAGE"
  docker build --target test --tag "$W_STATEFUL_TEST_IMAGE" .
}

stateful_up() {
  local started_at=$SECONDS
  "${compose[@]}" up --detach --wait "${dependency_services[@]}" || return
  if [[ -n "${bootstrap_services[*]-}" ]]; then
    for service in "${bootstrap_services[@]}"; do
      "${compose[@]}" run --rm --no-deps "$service" || return
    done
  fi
  printf 'Stateful dependencies готовы за %s с.\n' "$((SECONDS - started_at))"
}

stateful_suite() {
  local started_at=$SECONDS
  ensure_image || return
  "${compose[@]}" run --rm --no-deps test-runner \
    python scripts/run-stateful-suite.py || return
  printf 'Stateful suite завершён за %s с.\n' "$((SECONDS - started_at))"
}

stateful_down() {
  "${compose[@]}" down --volumes --remove-orphans
}

cleanup_on_exit() {
  local status=$?
  local cleanup_status=0
  trap - EXIT
  if ((cleanup_required)); then
    cleanup_required=0
    stateful_down || cleanup_status=$?
  fi
  if ((status == 0 && cleanup_status != 0)); then
    status=$cleanup_status
  fi
  exit "$status"
}

stateful_clean() {
  cleanup_required=1
  trap cleanup_on_exit EXIT
  stateful_up
  stateful_suite
  cleanup_required=0
  trap - EXIT
  stateful_down
}

stateful_stability() {
  local repeat="${W_STATEFUL_REPEAT:-20}"
  local iteration=1
  [[ "$repeat" =~ ^[0-9]+$ ]] && ((repeat >= 2)) \
    || fail "W_STATEFUL_REPEAT должен быть целым числом не меньше 2."
  cleanup_required=1
  trap cleanup_on_exit EXIT
  stateful_up
  while ((iteration <= repeat)); do
    printf 'Stateful stability: прогон %s/%s.\n' "$iteration" "$repeat"
    stateful_suite
    iteration=$((iteration + 1))
  done
  cleanup_required=0
  trap - EXIT
  stateful_down
}

require_tools
read_services
export W_STATEFUL_TEST_IMAGE
W_STATEFUL_TEST_IMAGE="$(dependency_image)"
compose=(
  docker compose
  --project-name "$project_name"
  --file "$compose_file"
)

case "${1:-}" in
  up)
    stateful_up
    ;;
  image)
    ensure_image
    ;;
  test)
    stateful_up
    stateful_suite
    ;;
  clean)
    stateful_clean
    ;;
  stability)
    stateful_stability
    ;;
  down)
    stateful_down
    ;;
  *)
    fail "Использование: $0 up|image|test|clean|stability|down"
    ;;
esac
