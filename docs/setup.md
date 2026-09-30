# Настройка проекта

Размести `w-tooling` и `w-releases` рядом. Установи Node.js 22+, npm, Python
3.11+ и Git. Docker понадобится поставкам, которые его используют.

```sh
cd w-tooling
./prepare.sh --code ACME --name "Acme Platform" --install
```

Скрипт сохранит настройки и установит npm-зависимости. Повторный запуск сохраняет
пути и таймауты releases. `--dry-run` показывает план; `--help` перечисляет параметры.
Скилл `$prepare-env` проведёт через те же шаги и поможет с недостающими инструментами.

## Создать базу задач Notion

1. Создай [интеграцию Notion](https://www.notion.so/profile/integrations)
   с правами Read, Insert и Update content.
2. Открой родительскую страницу для базы. В меню Connections добавь интеграцию.
3. В локальном терминале выполни команды ниже. После `read` вставь токен и нажми Enter.

```sh
read -s NOTION_TOKEN
export NOTION_TOKEN
./prepare.sh --create-notion --notion-parent PAGE_URL
./prepare.sh --check
npm run notion -- doctor
```

Замени `PAGE_URL` ссылкой на родительскую страницу. В новой базе появятся Name,
ID, Status, Type, Priority и Parent. Notion сам присваивает ID с выбранным префиксом.
Статусы: Backlog, Analysis, Development, Testing, Ready, Done.

Переменная `NOTION_TOKEN` действует в текущем терминале. Для следующих запусков
задай её снова или сохрани токен через `--token-stdin`: скрипт прочитает stdin
и запишет секрет в игнорируемый `.project/notion-secret.json` с правами 0600.

## Подключить существующую базу

Сначала дай интеграции доступ к базе и задай токен. Укажи её URL и названия полей:

```sh
./prepare.sh --notion-database DATABASE_URL \
  --code-property Ticket --status-property Phase
npm run notion -- doctor
```

Если в базе несколько data sources, укажи URL нужного. Поле кода поддерживает
unique_id, rich_text, title и number. Для текстового или числового кода при создании
задачи нужен `--code ACME-17`; за уникальностью таких кодов следит команда.
Если код хранится в title, значения `--title` и `--code` должны совпадать.
Названия доступных статусов покажет `doctor`. Поле Parent подключается по необходимости.

## Добавить репозиторий

В `config/project.json` добавь запись в `repositories`:

```json
{"name": "search-worker", "path": "search-worker", "role": "service"}
```

Путь считается от `workspaceRoot`. Выполни `npm run agents:sync`, затем
`npm run agents:check`. Скрипт обновит инструкции и skills зарегистрированных
репозиториев. Префикс `W_` в переменных инструментов сохраняется при любом коде проекта.

## Если настройка прервалась

При сохранённом ID базы повтори команду создания. Если результат запроса неизвестен,
найди базу на родительской странице и повтори ту же команду с `--notion-database URL`.
Журнал `.project/notion-setup.json` предотвращает создание дубля. Удаляй его только
после проверки, что базы нет, и решения начать создание заново.

Если остался `.project/prepare.lock`, проверь указанный в нём PID. Удалить lock
можно после завершения этого процесса. Затем повтори настройку и `./prepare.sh --check`.
