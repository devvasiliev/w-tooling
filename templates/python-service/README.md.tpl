# __SERVICE_NAME__

Независимый Python DDD-сервис W.

## Быстрая проверка

```sh
make test
```

На Linux команда создаёт локальный `.venv` на Python 3.12, устанавливает build и
dev зависимости строго из hash-locked файлов и повторяет установку только после
их изменения. На macOS она автоматически использует Linux test-stage.
Контейнерный вариант можно запустить явно:

```sh
make test-docker
```

Stateful-проверки не входят в ежедневный `make test`. Для быстрого цикла
инфраструктуру можно оставить поднятой между прогонами:

```sh
make stateful-up
make test-stateful
make test-stateful STATEFUL_TEST=tests.integration.test_example.ExampleTest.test_case
make test-stateful-stability STATEFUL_TEST=tests.integration.test_example.ExampleTest.test_case
make stateful-down
```

`make test-stateful` использует dependency image, ключ которого зависит только
от Dockerfile, `pyproject.toml` и lock-файлов. Текущий checkout подключается
read-only, поэтому изменение исходников не запускает повторную сборку image.
`make test-stateful-clean` выполняет тот же suite с чистого состояния и удаляет
контейнеры, сеть и volumes после успеха или ошибки. Stateful suite завершается
ошибкой при любом `skip`.

`make test-stateful-stability` выполняет выбранный тест 20 раз на одном поднятом
контуре и всегда удаляет инфраструктуру. Число повторов задаётся через
`STATEFUL_REPEAT`; эта проверка запускается отдельно и не замедляет `make test`.

Состав integration modules, сервисов Compose и test-only environment хранится в
`tests/stateful-modules.txt`, `tests/stateful-services.txt` и
`tests/stateful.env`. Compose не публикует порты на host.

Проверка направления импортов входит в обычный unittest-прогон. Для быстрой
диагностики до установки runtime dependencies её можно запустить отдельно:

```sh
python3.12 scripts/check_architecture.py --package __SERVICE_PACKAGE__
```

## Зависимости

Прямые pins редактируются только в `requirements/*.in` и `pyproject.toml`.
Пять generated lock-файлов фиксируют полный transitive graph и SHA-256 hashes
для compiler, build, runtime, test и dev окружений. Их нельзя править вручную.

После изменения input-файла пересобери все locks в закреплённом Linux/Python
3.12 image и проверь их:

```sh
python3 scripts/compile_requirements.py
python3.12 scripts/check_dependency_locks.py
```

`requirements-lock-tool.lock` с зафиксированными `pip` и `pip-tools` сначала
создаёт чистый compiler, поэтому локально установленный resolver не влияет на
результат. Docker stages устанавливают build/runtime/dev зависимости только с
`--require-hashes`.

API и worker запускаются независимо:

```sh
__SERVICE_NAME__-api
__SERVICE_NAME__-worker
```

Обе команды устанавливаются из PEP 621 metadata при сборке wheel. Production
image не использует `PYTHONPATH` на checkout.

Release image получает версию и revision явно:

```sh
docker build \
  --build-arg SERVICE_VERSION=0.1.0 \
  --build-arg SERVICE_REVISION="$(git rev-parse HEAD)" \
  --target production \
  .
```

Release builder подключает `scripts/release/native-buildkit.sh`. На нативном
Linux x86_64 он использует текущий worker; на другой архитектуре автоматически
выбирает Docker context `task-linux-amd64`. Другой нативный worker задаётся через
`W_RELEASE_DOCKER_CONTEXT`. Selector вызывается только при сборке релиза.

`/version` читает `W_SERVICE_VERSION` и `W_SERVICE_REVISION`, которые image
получает из тех же build arguments, что и OCI version/revision labels.

Production-код и данные остаются у прежнего владельца до отдельного cutover.
Перед реализацией capability заполни `docs/traceability.md` от актуального
requirement до реального acceptance test. Legacy указывается только как evidence
с явной классификацией, а не как источник бизнес-правила.
