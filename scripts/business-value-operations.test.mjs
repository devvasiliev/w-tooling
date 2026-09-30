import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuditLog, humanRunSummary } from "./business-value/audit.mjs";
import { cleanupRun, recordIncompleteRollback } from "./business-value/cleanup.mjs";
import { buildManagedToggle } from "./business-value/managed-section.mjs";
import { RunStore } from "./business-value/run-store.mjs";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";

test("audit редактирует secrets, а внешний log запрещает W/product/verbatim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-bv-audit-"));
  const secret = "known-secret-123456789";
  const audit = new AuditLog(directory, { knownSecrets: [secret] });
  try {
    await audit.internal({
      runId: RUN_ID,
      stage: "model",
      message: `token=secret-value-987654 and ${secret} person@example.com`,
    });
    const internal = await readFile(join(directory, "internal.jsonl"), "utf8");
    assert.doesNotMatch(internal, /secret-value|known-secret|person@example/u);
    assert.match(internal, /\[REDACTED\]/u);

    for (const [event, privacy] of [
      [{ query: "W-456 retention" }, {}],
      [{ query: "Acme customer retention" }, { productAliases: ["Acme"] }],
      [
        { query: "закрытый длинный внутренний фрагмент повторяется без изменений" },
        {
          confidentialText:
            "Этот закрытый длинный внутренний фрагмент повторяется без изменений во внешнем запросе",
        },
      ],
    ]) {
      await assert.rejects(
        audit.external(event, privacy),
        (error) => error.code === "EXTERNAL_AUDIT_PRIVACY_BLOCKED",
      );
    }
    await assert.rejects(readFile(join(directory, "external-search.jsonl"), "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stage audit имеет полный контракт и читается только по exact run id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-bv-stage-audit-"));
  const audit = new AuditLog(directory);
  try {
    await audit.stage({
      schemaVersion: 1,
      timestamp: "2026-09-01T12:00:00.000Z",
      runId: RUN_ID,
      actor: "owner@example.test",
      stage: "prepare",
      status: "PREPARED",
      reasonCode: "READY",
      durationMs: 12,
      evaluatorDigest: "a".repeat(64),
      evaluator: { evaluatorVersion: "BV-EVALUATOR-1" },
      preflight: { modelAllowed: true },
    });
    assert.equal((await audit.readInternal(RUN_ID)).length, 1);
    assert.equal(
      (await audit.readInternal("223e4567-e89b-42d3-a456-426614174000")).length,
      0,
    );
    await assert.rejects(
      audit.stage({ runId: RUN_ID, stage: "score" }),
      (error) => error.code === "AUDIT_STAGE_INVALID",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("human summary содержит расследуемый штатный путь", () => {
  const summary = humanRunSummary({
    stage: "publish",
    expected: "один актуальный раздел",
    actual: "Notion вернул конфликт",
    currentState: "старый результат сохранён",
    rollback: "complete",
    impact: "новое число не опубликовано",
    reasonCode: "SOURCE_CONFLICT",
    nextStep: "повторить preview",
    detailsPath: ".project/business-value/audit/internal.jsonl",
  });
  for (const label of [
    "Этап:",
    "Ожидалось:",
    "Фактически:",
    "Текущее состояние:",
    "Rollback:",
    "Влияние:",
    "Причина:",
    "Следующий шаг:",
    "Детали:",
  ]) assert.match(summary, new RegExp(label, "u"));
});

test("cleanup затрагивает только блоки и BV snapshot точного run id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-bv-cleanup-"));
  const runStore = new RunStore(directory);
  const temporary = buildManagedToggle({
    runId: RUN_ID,
    markdown: "Временный результат.",
    temporary: true,
  });
  temporary.id = "temp-block";
  temporary.children = temporary.toggle.children;
  const unrelated = { id: "unrelated", archived: false };
  const state = {
    blocks: new Map([
      [temporary.id, temporary],
      [unrelated.id, unrelated],
    ]),
    fields: { "BV значение": 28 },
  };
  const adapter = {
    async readManaged(id) {
      return state.blocks.get(id);
    },
    async archiveBlock(id, archived) {
      state.blocks.get(id).archived = archived;
    },
    async updateFields(_pageId, fields) {
      state.fields = structuredClone(fields);
    },
  };
  try {
    await runStore.write(RUN_ID, { schemaVersion: 1, runId: RUN_ID });
    await recordIncompleteRollback(runStore, RUN_ID, {
      pageId: "page-1",
      temporaryBlockIds: ["temp-block"],
      restoreFields: { "BV значение": 11 },
      rollbackFailures: [{ stage: "archive_temporary_section" }],
    });
    const result = await cleanupRun({ runStore, adapter, runId: RUN_ID });
    assert.equal(result.status, "CLEANED");
    assert.equal(state.blocks.get("temp-block").archived, true);
    assert.equal(state.blocks.get("unrelated").archived, false);
    assert.deepEqual(state.fields, { "BV значение": 11 });
    assert.equal((await runStore.read(RUN_ID)).recovery.status, "resolved");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
