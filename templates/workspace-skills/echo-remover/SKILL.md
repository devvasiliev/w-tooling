---
name: echo-remover
description: Audit and remove stale transition artifacts after a completed refactor, migration, cutover, ownership transfer, rename, removal, or replacement. Use when the operator selects Echo Remover from the Desktop slash list, mentions $echo-remover, or when the primary agent has completed replacement semantics and must clean the repository in scope before independent validation. Do not trigger from legacy-like words alone or for ordinary additive work.
---

# Echo Remover

Оставь в активном контуре только текущее поведение. Не превращай поиск старых
слов в механическое удаление.

В Desktop оператор может выбрать Echo Remover из списка `/`. В CLI он открывает
`/skills` либо явно упоминает `$echo-remover`; буквальная команда
`/echo-remover` интерфейсом CLI не поддерживается.

## Когда запускать

Запусти skill в одном из двух случаев:

1. Оператор прямо выбрал Echo Remover или упомянул `$echo-remover`.
2. В текущей задаче завершена замена поведения: refactor, migration, cutover,
   ownership transfer, rename, removal или replacement. Запуск выполняется после
   реализации и её обычных проверок, но до независимой финальной валидации.

Не запускай его после обычной additive feature, локального bugfix или правки
текста без замены прежнего пути. Слова `legacy`, `old`, `migration`, `раньше`,
`теперь` и номер старой задачи являются только подсказками для поиска.

## Граница безопасности

- Установи код задачи и один repository-owner через `$route-task`.
- Не меняй соседние checkout. Для их cleanup нужен собственный контракт задачи.
- Custom agent `echo-remover` всегда read-only: он ищет, классифицирует и
  возвращает patch-plan. Основной агент применяет доказанные изменения.
- Named binding подтверждается только `agent_type=echo-remover` или
  эквивалентной runtime-метаданной. `task_name`, чтение TOML и prompt injection
  этого не доказывают.
- Если selector профиля недоступен, не подменяй его generic subagent. Основной
  агент выполняет тот же audit сам и пишет
  `PROFILE_BINDING: unavailable (echo-remover)`.
- `PROFILE_BINDING` — обязательное первое поле каждого результата. Пиши
  `PROFILE_BINDING: echo-remover` только при подтверждении runtime-метаданными;
  во всех остальных случаях пиши `PROFILE_BINDING: unavailable (echo-remover)`.
- Независимый validator не запускает remover и не пишет файлы. Он получает уже
  применённый cleanup и evidence.

## 1. Подготовь вход аудита

Передай read-only профилю либо используй сам:

- Код задачи и точный repository boundary;
- что было заменено и какой результат считается текущим;
- task diff и актуальные requirements/specs;
- известные прежние и новые owners, names, paths, commands и flags;
- designated archive, если его существование является текущим контрактом;
- обязательные acceptance и regression checks.

Если текущего владельца нельзя доказать или источники истины конфликтуют,
результат — `blocked`. Не угадывай.

## 2. Проведи read-only audit

Сначала установи source of truth по актуальным требованиям, active API, реально
вызываемому коду, runtime config и acceptance tests. Затем:

1. Изучи task diff и все изменённые active docs, code, tests, scripts и config.
2. Найди старые и новые термины через `rg`, но классифицируй по назначению.
3. Проверь imports, callers, reverse dependencies, routes, package scripts, CI,
   flags и runtime config старого артефакта.
4. Для каждого совпадения выбери одну классификацию:
   - `current-contract` — действующее поведение, rollback, compatibility,
     миграция или доменная лексика;
   - `designated-history` — явно обозначенный обязательный audit archive;
   - `echo` — остаток завершённого перехода без действующих callers;
   - `uncertain` — владелец, назначение или зависимости не доказаны.
5. Верни `PROFILE_BINDING` первым полем, затем `verdict`, `source_of_truth`,
   `findings`, `remove_or_rewrite`, `retain`, `search_and_dependencies`,
   `checks`, `next_step`.

`cleanup-required` допустим только при доказанном новом владельце и отсутствии
действующих callers. Любой `uncertain`, влияющий на удаление, означает
`blocked`.

Исторический материал допустим только в уже существующем designated archive,
обязательность которого доказана текущим audit-контрактом. Не создавай и не
предлагай новый архив для найденного эха. Если echo находится в active README,
runbook, spec, test, code, script или config, удали его либо перепиши
предложение как самодостаточный present-state contract. Не сохраняй, не
сокращай, не переноси и не превращай echo в историческую справку.

Убирай сравнительные маркеры завершённого перехода вроде `уже`, `теперь` и
`ранее`, когда они не являются частью действующей операции. Рабочую механику
release и rollback сохраняй.

## 3. Примени patch-plan основным агентом

При `clean` ничего не меняй. При `blocked` зафиксируй точный конфликт и останови
cleanup.

При `cleanup-required` основной агент заново проверяет evidence и применяет
только доказанные пункты в repository in scope:

- active README, runbook и spec переписывает как описание текущего состояния;
- мёртвые commands, flags, scripts, tests и compatibility code удаляет вместе с
  их внутренними ссылками;
- действующие rollback, adapters, migrations и audit records сохраняет;
- у временного действующего контракта оставляет owner и проверяемое условие
  удаления;
- найденное эхо не сохраняет как сокращённую историческую справку и не переносит
  в новый active doc или новый «архив».

Если у задачи есть активное Cycle Optimizer dossier, запиши значимый cleanup и
evidence обычным event. Не создавай dossier только ради Echo Remover.

## 4. Проверь результат

1. Повтори поиск старых names, owners, paths, commands и flags.
2. Повтори проверку callers и reverse dependencies.
3. Запусти checks из patch-plan и обязательные проверки задачи.
4. Передай независимому read-only validator task diff, source of truth,
   remover-findings, сохранённые контракты, повторный поиск и результаты checks.
5. После correction снова передай результат тому же validator. Remover повторяй
   только если correction изменила replacement boundary или создала новое эхо.

Финальный отчёт основного агента содержит `PROFILE_BINDING`, итоговый `verdict`,
что удалено или переписано, что намеренно сохранено, evidence поиска, checks и
verdict независимого validator.
