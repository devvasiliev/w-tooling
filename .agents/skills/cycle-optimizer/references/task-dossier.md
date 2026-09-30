# Task dossier

Команды запускаются из checkout tooling. Основной вывод человекочитаем;
`--json` включает машинный второй уровень.

## Структура

```text
<repo>/.project/task-runs/CODE-N/
├── contract.md       # стабильный контракт задачи
├── current.md        # одна изменяемая точка продолжения
├── journal.md        # append-only история значимых событий
├── review.md         # последний явный разбор
├── state.json        # машинное состояние
├── integrity.json    # отдельная целостность dossier
├── events/           # неизменяемые структурные события
├── checkpoints/      # неизменяемые человекочитаемые снимки
└── experiments/
    ├── candidates/   # неизменяемые source records
    └── evidence/     # локальные append-only проверки и решения
```

Пустые `experiments/` могут отсутствовать после clean checkout: writers создают
их лениво через symlink-safe path validation, а read-only projection трактует
отсутствующий registry как пустой.

Досье принадлежит задаче в конкретном Git-репозитории. Другая задача не
может дописывать его.

## Создание

```sh
npm run task:cycle -- task init W-434 \
  --repo w-tooling \
  --title "Создание долговременной памяти" \
  --class tooling \
  --facet agent-workflow \
  --facet memory \
  --quality "Senior-разработчик восстанавливает состояние без чата" \
  --scope "Human-readable task dossier" \
  --non-goal "Автоматическое изменение harness" \
  --check "npm test"
```

Классы: `feature`, `bugfix`, `refactor`, `tooling`, `template`, `migration`,
`research`, `incident`, `other`. Facets — короткие `lower-kebab-case` признаки
пула, а не случайные теги реализации.

Если scope или acceptance изменились после старта, не правь `contract.md` или
`state.json` вручную. Запиши versioned delta:

```sh
npm run task:cycle -- task amend W-434 \
  --repo w-tooling \
  --summary "Добавлены persona-агенты" \
  --facet persona-agents \
  --quality "Product reviewer проверяет бизнес-требования продуктовой фичи" \
  --scope "Три read-only persona-агента в зарегистрированных checkout"
```

Команда обновляет human contract и machine state в одной locked mutation, а
immutable event хранит exact additions/removals, исходные позиции удалённых
пунктов, revision и before/after digests. Повтор существующего добавления и
удаление отсутствующего пункта отклоняются.

Если прежнее требование отменено, убери его точной строкой и при необходимости
сразу добавь актуальную замену:

```sh
npm run task:cycle -- task amend W-434 \
  --repo w-tooling \
  --summary "Уточнена безопасная граница агента" \
  --remove-quality "Echo-remover сам изменяет репозиторий" \
  --quality "Echo-remover возвращает read-only findings и patch-plan"
```

История отменённого решения остаётся в immutable event ledger. В эффективном
`contract.md` остаются только действующие требования.

## Значимое событие

```sh
npm run task:cycle -- task event W-434 \
  --repo w-tooling \
  --type human-correction \
  --phase "Проектирование" \
  --summary "Уточнён обязательный slash-вызов" \
  --impact "Skill должен быть виден как /cycle-optimizer" \
  --provenance reconstructed
```

Типы событий: `phase-start`, `phase-finish`, `milestone`, `failure`, `decision`,
`human-correction`, `scope-change`, `verification`, `handoff`, `blocker`,
`blocker-resolved`, `cleanup`, `resume`. Событие `blocker` требует
`--blocker <причина>`. Следующие события сохраняют активный blocker; снять его
можно только отдельным `blocker-resolved`. Второй blocker не заменяет активный.
Для legacy dossier один раз выполни `task migrate-blockers CODE-N --repo <name>`:
старые anomalies останутся в ledger, а новые события начнут строгую state
machine с зафиксированной sequence-границы. Передавай `--duration-minutes` только
для реально измеренного времени. Для `handoff` используй
`--result accepted|rejected|incomplete`.

## Checkpoint и продолжение

```sh
npm run task:cycle -- task checkpoint W-434 \
  --repo w-tooling \
  --stage "Реализация" \
  --expected "CLI и skill готовы к полной проверке" \
  --actual "Точечные тесты проходят" \
  --next "Запустить полный npm test" \
  --rollback "Удалить новые workspace-only artifacts" \
  --cleanup "Удалить временный candidate manifest" \
  --evidence "node --test scripts/cycle-harness.test.mjs"

npm run task:cycle -- task resume W-434 --repo w-tooling
```

Checkpoint без повторных `--blocker`, `--rollback` и `--cleanup` наследует их
effective значения из `current.md`. Новый blocker через checkpoint не создаётся.

Git fingerprint включает commit, branch/detached state, digest tracked diff и
состояние каждого changed path: тип, mode, content SHA-256 и index entries.
Обычные file↔directory refactor фиксируются как directory state плюс состояния
затронутых child paths; special entries по-прежнему отклоняются.
Исключается только `.project/task-runs/**`, поэтому checkpoint не создаёт drift
самому себе. `resume` отдельно показывает смену HEAD/ветки и added, removed,
changed paths, включая повторную правку уже грязного файла.

Изменение досье проверяется отдельным `integrity.json`. После него CLI сверяет
полную schema и согласованность mutable `state.json` с append-only ledger:
sequence, chronology, lifecycle, последний event и число checkpoints. Ошибка
возвращает стабильные `code`, `stage`, expected/actual и следующий шаг.
Sequence, время и lifecycle следующего event проверяются до записи checkpoint,
review, candidate или evidence, поэтому откат системных часов не оставляет
частично созданный артефакт. `current.md` получает свежий worktree snapshot при
каждом значимом событии; immutable checkpoint остаётся снимком своего этапа.
Worktree preflight review/candidate/evidence/decision также завершается до
первой записи и затем переиспользуется event mutation.
Ledger также воспроизводит blocker state machine и цепочку contract amendments.

## Разбор

```sh
npm run task:cycle -- task review W-434 \
  --repo w-tooling \
  --outcome partial \
  --summary "Нужна fresh-task проверка" \
  --worked "Checkpoint восстановил состояние" \
  --failed "Первый handoff потребовал уточнения" \
  --hypothesis "Явный rubric уменьшит число исправлений" \
  --next-action "Проверить кандидата на следующей tooling-задаче"
```

Review не меняет harness и не запускается автоматически после каждого события.
Если blocker активен, `current.md` сохраняет ближайший шаг его разрешения;
ретроспективные действия остаются в `review.md`.
