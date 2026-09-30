# Инструменты проекта

Начни с [настройки](setup.md). Остальные инструменты подключай по мере надобности.

| Задача | Где смотреть |
| --- | --- |
| Собрать и установить свою поставку | [w-releases](../../w-releases/README.md), `$integrate-distribution` |
| Создать Python-сервис | [Шаблон и проверки](python-services.md) |
| Выбрать проверки по изменённым файлам | [task:verify](verification-selection.md) |
| Сохранить ход большой задачи | [cycle-optimizer](cycle-optimizer.md) |
| Проверить остатки после рефакторинга | [echo-remover](echo-remover.md) |
| Добавить общий skill и агент | [Конструктор](workspace-harness-scaffold.md) |
| Вести эпики, истории и релизы в Notion | [Расширенный workflow](notion-workflow.md) |
| Оценивать ожидаемый бизнес-эффект | [Business Value](business-value.md) |

Команда проекта задаёт список репозиториев, зависимости и способы установки.
Шаблон содержит tooling и releases; окружение приложения подключается через
скрипт поставки. Локальные секреты, история Git и готовые ZIP в шаблон не входят.
