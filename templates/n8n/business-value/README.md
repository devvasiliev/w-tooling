# n8n: оценка Business Value

Опциональный runtime расширенного Notion workflow. Он включает n8n, отдельный
Notion runner и Codex service. Версии и digest образов закреплены в compose
и Dockerfile. Схема базы описана в `docs/notion-workflow.md` checkout tooling.

## Настройка

Из checkout tooling установи runtime и сохрани абсолютный путь:

```sh
export W_TOOLING_DIR="$PWD"
npm run business-value:runtime -- deploy
```

По умолчанию файлы устанавливаются в `.project/business-value-runtime`.
Владелец проекта выбирает baseline в `config/business-value-model.v1.json`
и передаёт названия продукта через `W_BV_PRODUCT_ALIASES`, разделяя их запятыми.
Runner использует этот список при обезличивании внешнего research.
Часовой пояс контейнеров задаётся через `W_TIMEZONE`; по умолчанию используется UTC.

Для Codex создай отдельный каталог credentials и выполни login:

```sh
mkdir -p "$HOME/.config/w/codex-business-value"
chmod 700 "$HOME/.config/w/codex-business-value"
CODEX_HOME="$HOME/.config/w/codex-business-value" codex login --device-auth
export W_BV_CODEX_AUTH_PATH="$HOME/.config/w/codex-business-value/auth.json"
chmod 600 "$W_BV_CODEX_AUTH_PATH"
export W_CODEX_UID="$(id -u)"
export W_CODEX_GID="$(id -g)"
```

В Notion подключи отдельную internal integration `W Business Value` к базам
выбранного процесса. Создай приватный файл и укажи его абсолютный путь в
`W_BV_NOTION_CONFIG_PATH`:

```dotenv
NOTION_TOKEN=YOUR_INTEGRATION_TOKEN
NOTION_BACKLOG_DATABASE_ID=YOUR_TASKS_DATABASE_ID
NOTION_BUSINESS_REQUIREMENTS_DATABASE_ID=YOUR_REQUIREMENTS_DATABASE_ID
```

Выдай файлу права 0600. Секреты хранятся за пределами Git. Codex получает только
свой auth.json, runner получает только Notion env. n8n хранит credentials
собственного интерфейса в `data/`; резервируй этот каталог целиком после остановки.

## Запуск

После задания переменных окружения:

```sh
cd "$W_TOOLING_DIR/.project/business-value-runtime"
node "$W_TOOLING_DIR/scripts/business-value/runtime-manifest.mjs" check "$PWD"
node "$W_TOOLING_DIR/scripts/business-value/n8n-workflow.mjs" validate workflow.json
docker compose config --quiet
docker compose up -d --build
docker compose exec n8n n8n audit
node "$W_TOOLING_DIR/scripts/business-value/n8n-workflow.mjs" import workflow.json
```

Интерфейс доступен на `http://127.0.0.1:5678`. После проверки credentials,
health сервисов и runtime manifest workflow публикуется командой:

```sh
node "$W_TOOLING_DIR/scripts/business-value/n8n-workflow.mjs" publish workflow.json
```

Публикация проверяет `sourceDigest` работающих образов. После изменения исходников
повтори deploy runtime и сборку образов. Состояние: `docker compose ps`;
журнал: `docker compose logs -f`; остановка: `docker compose stop`.
