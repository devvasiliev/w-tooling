# Harness experiments

Эксперимент отвечает на один вопрос: улучшает ли конкретное изменение цепочки
результат на повторяемом пуле задач. Candidate описывает точный вариант, а не
намерение или свободный текст.

## Candidate manifest

Все input artifacts лежат внутри source repository. Например:

```text
candidate-assets/
├── cycle-skill-after.md
├── rubric-v1.md
└── evaluation-v1.md
```

Manifest:

```json
{
  "title": "Явный checkpoint перед handoff",
  "hypothesis": "Checkpoint уменьшит число повторных попыток",
  "target_repository": "w-tooling",
  "changes": [
    {
      "layer": "skills",
      "operation": "replace",
      "target": "templates/workspace-skills/cycle-optimizer/SKILL.md",
      "content_path": "candidate-assets/cycle-skill-after.md",
      "summary": "Перед handoff требовать checkpoint с evidence"
    }
  ],
  "rubric": {
    "version": "rubric-1",
    "path": "candidate-assets/rubric-v1.md"
  },
  "evaluation": {
    "version": "eval-1",
    "path": "candidate-assets/evaluation-v1.md"
  },
  "quality_criteria": ["Handoff принят без исправлений"],
  "regression_scenarios": ["Обычная tooling-задача"],
  "negative_scenarios": ["Разовая задача без общего пула"]
}
```

Допустимые `operation`: `add`, `replace`, `delete`. Для `delete`
`content_path` не передаётся. Допустимые layers: `task`, `rules`,
`skills`, `agents`, `tooling`.

```sh
npm run task:cycle -- experiment create W-434 \
  --repo w-tooling \
  --candidate candidate.json \
  --baseline <target-commit-sha>
```

Если `--baseline` отсутствует, используется текущий `HEAD` target repository.
Команда проверяет, что commit существует именно там. Immutable candidate
встраивает:

- target repository и полный baseline commit;
- для каждого target — operation, mode, before/after bytes и SHA-256;
- Git object исходного файла;
- версии, bytes и digest rubric/evaluation;
- task class, facets, quality criteria и сценарии;
- title и hypothesis, определяющие человекочитаемый вариант;
- `variant_fingerprint` точного overlay/rubric/evaluation.

Изменение identity-полей manifest, embedded content либо bytes/version
rubric/evaluation создаёт новый `candidate_ref` вида
`repository:CODE-N:<digest>`. Пути временных input artifacts не входят в
identity, если итоговые bytes совпадают. После создания эти artifacts можно
и нужно удалить до evidence run, если target совпадает с source repository.

## Применение варианта

CLI не меняет target автоматически. Подготовь target repository на baseline
кандидата и примени точные bytes/mode overlay. Перед записью evidence команда
проверяет:

- target `HEAD` равен baseline;
- каждый add/replace/delete совпадает с immutable candidate;
- variant fingerprint совпадает;
- path-filtered target snapshot в точности содержит overlay targets;
- зафиксированы нормализованные changed paths, tracked diff identity и полный
  fingerprint target worktree.

Если task owner и target — разные репозитории, полный target checkout должен
содержать только overlay. Если это две задачи одного репозитория, перед первым run:

1. удали временные candidate assets и candidate overlay;
2. создай task checkpoint с изменениями только проверяемой задачи;
3. примени immutable overlay;
4. запиши evidence.

Harness хранит task-only checkpoint и отдельный path-filtered target snapshot.
Фактический same-repository checkout должен быть их точным объединением; task и
overlay paths не могут пересекаться. Любой новый или изменившийся path после
checkpoint считается confounder, завершается typed error и не создаёт evidence.
Следующие runs той же задачи переиспользуют тот же task-only fingerprint.

## Локальный evidence

Каждая задача записывает результат только в собственное досье:

```sh
npm run task:cycle -- experiment record W-500 \
  --repo catalog-service \
  --candidate-ref w-tooling:W-434:<digest> \
  --scenario fresh-task \
  --scenario-id create-python-module \
  --run-key W-500-attempt-1 \
  --result pass \
  --summary "Задача принята без корректировок" \
  --evidence "W-500/review.md"
```

Scenarios:

- `replay` — кандидат объясняет или улучшает исходный сбой;
- `regression` — прежние успешные задачи не деградируют;
- `negative` — skill не навязывает процесс неподходящей задаче;
- `fresh-task` — другая задача того же класса и обязательных facets.

Record связывает результат с candidate variant, раздельными target/task
worktree snapshots, проверочным снимком их фактического объединения, changed
paths, tracked diff identity и digest rubric/evaluation. Логический exact run задаётся
`candidate_ref + owner + scenario + scenario-id + run-key`. Повторная запись
этого run отклоняется даже после изменения worktree.

## Решение человека

```sh
npm run task:cycle -- experiment decision W-500 \
  --repo catalog-service \
  --candidate-ref w-tooling:W-434:<digest> \
  --decision-id human-review-1 \
  --decision approved \
  --summary "Результат соответствует критериям качества"
```

Решение принадлежит текущей задаче и связано с immutable candidate через
`candidate_ref`. `approved` разрешён только после replay, regression, negative
и fresh-task pass без fail/rejected. Решение хранит digest показанного человеку
technical evidence-set. Любой добавленный validation record меняет этот digest
и требует нового human approval. `rejected` доступен на любом этапе. Решение не
мутирует source dossier.

## Read-only projection

```sh
npm run task:cycle -- experiment status w-tooling:W-434:<digest>
npm run task:cycle -- experiment list
npm run task:cycle -- experiment list --class tooling --facet agent-workflow
```

Human-readable status показывает title, hypothesis, source, target/baseline,
task pool, variant, следующий gate, evidence, target/task changed paths и diff
identity, а также blockers. `--json` отдаёт тот же результат как машинный второй
слой.

Статус `ready-for-promotion` требует пяти gates:

1. replay pass;
2. regression pass;
3. negative pass;
4. fresh-task pass в другой задаче того же пула;
5. human approval.

Любой `fail` или `rejected` переводит кандидата в terminal-состояние. Проекция
не предлагает недостижимый human approval и показывает точный следующий шаг:
создать нового кандидата с новым digest. Promotion выполняется отдельной задачей в
репозитории канонического владельца; projection остаётся read-only.
