# Python-сервисы

Шаблон создаёт самостоятельный сервис с DDD-структурой, тестами и сборкой поставки.
Общие проверки сравнивают подключённые сервисы по
[конфигу](../config/python-service-conformance.json). Начальный список пуст.

## Создать сервис

Из `w-tooling` выполни:

```sh
npm run create-python-service -- \
  --target ../search-worker --service-name search-worker --package search_worker \
  --port 8080 --bounded-context "Поиск" \
  --requirement "Notion: ссылка на требование поиска" \
  --capability indexing --dry-run
```

Проверь план и замени `--dry-run` на `--verify`. Целевой каталог должен быть пустым;
допускаются `.git`, `.idea`, `.codex` и `AGENTS.md`. Генератор сохраняет существующий
код. Имя репозитория задаётся в kebab-case, имя Python-пакета в snake_case.

До реализации заполни цепочку в карте требований сервиса:

```text
требование → владелец → сценарий → инвариант → контракт → приёмочный тест
```

Генератор создаёт структуру; бизнес-правила определяет команда по актуальным
требованиям. При переносе прежнего поведения проверь полный путь пользователя.
Поведение без требования сначала классифицируй: обязательная совместимость,
заменяемая техническая деталь, устаревшее правило или вопрос владельцу продукта.

## Добавить возможность в сервис

```sh
npm run create-python-capability -- \
  --target ../search-worker --package search_worker --capability indexing \
  --bounded-context "Поиск" --requirement "Notion: ссылка на требование поиска" \
  --http --persistence --verify
```

Команда добавит недостающие каталоги возможности и карту в `docs/capabilities/`.
HTTP и persistence появляются по указанным флагам. Пользовательский код сохраняется;
для зарегистрированного сервиса обновляется конфиг общей проверки.

## Где писать код

| Каталог в `src/<package>/` | Ответственность |
| --- | --- |
| `domain/` | Бизнес-правила; зависимости только из стандартной библиотеки |
| `application/` | Сценарии, локальные ports и внутренние контракты |
| `adapters/inbound/` | HTTP, события и CLI; каждому виду свой каталог |
| `adapters/outbound/` | БД и внешние системы |
| `bootstrap/` | Сборка приложения, настройки и логирование |

Зависимости направлены так: `bootstrap → adapters → application → domain`.
ORM-модели и транспортные DTO остаются в adapters. Общий runtime-пакет с бизнес-
сущностями между сервисами не создаётся. Framework и доменные библиотеки выбирает
владелец сервиса.

API и worker имеют отдельные точки входа `bootstrap/api.py` и `bootstrap/worker.py`.
API собирается через `create_application()`; настройки API, worker и БД разделены.
Общий HTTP-профиль включает `X-Correlation-ID`, типизированные DTO и ошибки вида
`{"error":{"code":"...","message":"...","correlation_id":"..."}}`.
Readiness возвращает 200 с `status=ok` или 503 с `status=unavailable`.
`/version` читает `W_SERVICE_VERSION` и `W_SERVICE_REVISION`; значения совпадают
с OCI labels образа. Профиль `auth-client-ip` подключается с обоснованием в конфиге.

## Зависимости и качество кода

Сервисы используют CPython 3.12, `pyproject.toml` и установку своего wheel.
Версия Docker-образа и общие pins закреплены в шаблоне и конфиге проверки.
Изменение общего pin требует обновления профиля и проверки подключённых сервисов.

Редактируй `requirements/*.in`, затем запускай в сервисе:

```sh
python3 scripts/compile_requirements.py
python3 scripts/check_dependency_locks.py
```

Первая команда пересобирает locks в закреплённом Linux-образе. Runtime, test, dev,
build и lock-tool имеют отдельные locks с точными версиями и SHA-256; при сборке
они устанавливаются с `--require-hashes`. Инструменты тестирования и сборки остаются
за пределами production image.

Код использует `from __future__ import annotations`, `T | None`, `StrEnum`,
а для неизменяемых dataclass по умолчанию `frozen=True, slots=True`.
HTTP DTO используют Pydantic v2 с `extra="forbid"`. Настройки читаются через
`BaseSettings`; зависимости передаются явно. Ruff проверяет стиль, mypy работает
в strict mode. Импорты указывают модуль-владелец.

Перед сдачей выполни проверки сервиса: locks, Ruff format/lint, mypy и тесты.
Архитектурные и unit-тесты работают без БД и сети. Отдельно проверь миграции
из пустой и последней поддерживаемой БД, совместимость API/событий с предыдущей
версией и сборку образа из чистого checkout. Runtime-учётная запись БД имеет
доступ к схемам своего сервиса. Общая проверка: `npm run python-services:check`
из `w-tooling`.

## Собрать поставку

Сервис владеет `scripts/release/distribution.json`, скриптом установки и содержимым
ZIP. Общие скрипты сборки копируются в сервис, поэтому сборка из отдельного checkout
работает самостоятельно. Они собирают и проверяют образ `linux/amd64`, упаковывают
файлы и checksums. Версия и SHA передаются через `SERVICE_VERSION`, `SERVICE_REVISION`.

После изменения общего механизма в `w-tooling` выполни:

```sh
npm run python-services:sync-release
npm run python-services:check
```

Синхронизация обновляет файлы из `canonicalReleaseFiles`. Сервисные manifests,
миграции и deploy-скрипты остаются у сервиса. Для установки подключи поставку
по [контракту w-releases](../../w-releases/docs/distribution-contract.md)
и проверь её запуск и откат в своём окружении.
