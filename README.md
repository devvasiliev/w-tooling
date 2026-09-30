# w-tooling

Здесь настраивают проект и задачи в Notion, подключают репозитории и общие
инструкции для агентов. Сборка и установка поставок находятся в соседнем
[w-releases](../w-releases/README.md).

## Начать работу

Положи оба репозитория в одну директорию. Нужны Node.js 22+, npm, Python 3.11+
и Git. В терминале из `w-tooling` выполни:

```sh
./prepare.sh --code ACME --name "Acme Platform" --install
./prepare.sh --check
```

Замени `ACME` и название своими. Код задаёт префикс задач, например `ACME-17`.
Настройки сохранятся в `config/project.json`.

В Codex можно поручить настройку скиллу:

```text
$prepare-env Настрой проект с кодом ACME и названием Acme Platform.
Создай стандартную базу задач Notion.
```

Агент подготовит окружение и попросит доступ к родительской странице Notion.
Токен вводится в локальном терминале. Порядок действий и восстановление после
сбоя описаны в [настройке проекта](docs/setup.md).

## Каждый день

```sh
npm run notion -- find ACME-17
npm run notion -- create --title "Подготовить поставку"
npm run notion -- status ACME-17 Development
```

Чтобы подключить ещё один репозиторий, добавь его в `repositories` в конфиге
и выполни `npm run agents:sync`. Проверка инструкций: `npm run agents:check`.
Общие правила меняй в `templates/`, skills в `.codex/skills/`, затем повтори sync.

[Остальные инструменты](docs/portability.md) · [Результаты проверок](docs/validation.md)
