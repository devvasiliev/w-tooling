import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  executeBusinessValueCommand,
  parseArguments,
} from "./business-value.mjs";
import { loadEvaluator } from "./business-value/evaluator.mjs";
import { RunStore } from "./business-value/run-store.mjs";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const config = { token: "test-token-value-123456", databaseId: "source-1" };

const setupClient = {
  async request(path) {
    if (path === "/users/me") return { id: "bot-1", name: "W Business Value" };
    if (path.startsWith("/users?")) {
      return { results: [{ id: "bot-1", name: "W Business Value" }], has_more: false };
    }
    if (path === "/data_sources/source-1") {
      return { object: "data_source", id: "source-1", properties: {} };
    }
    throw new Error(`Unexpected request: ${path}`);
  },
};

test("CLI parser не принимает flag за target", () => {
  assert.deepEqual(parseArguments(["setup", "--dry-run", "--strict"]), {
    command: "setup",
    target: "",
    flags: {
      strict: true,
      dryRun: true,
      approved: false,
      runId: "",
      stateDirectory: "",
    },
  });
});

test("setup command возвращает stable reason code", async () => {
  const result = await executeBusinessValueCommand(
    ["setup", "--dry-run", "--strict"],
    { config, client: setupClient, env: {} },
  );
  assert.equal(result.reasonCode, "BUSINESS_VALUE_SETUP_OK");
  assert.equal(result.result.addedPropertyNames.length, 12);
});

test("Business Value не подхватывает общий Notion token и требует mode 600", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-bv-notion-config-"));
  const configPath = join(directory, "notion-business-value.env");
  try {
    await writeFile(
      configPath,
      "NOTION_BACKLOG_DATABASE_ID=11111111111141118111111111111111\n",
      { mode: 0o600 },
    );
    await assert.rejects(
      executeBusinessValueCommand(["setup", "--dry-run", "--strict"], {
        env: {
          W_BV_NOTION_CONFIG_PATH: configPath,
          NOTION_TOKEN: "general-token-must-not-be-used",
        },
      }),
      (error) => error.code === "CONFIG_MISSING",
    );

    await writeFile(
      configPath,
      "NOTION_TOKEN=dedicated-token-value-123456\nNOTION_BACKLOG_DATABASE_ID=11111111111141118111111111111111\n",
    );
    await chmod(configPath, 0o644);
    await assert.rejects(
      executeBusinessValueCommand(["setup", "--dry-run", "--strict"], {
        env: { W_BV_NOTION_CONFIG_PATH: configPath },
      }),
      (error) => error.code === "NOTION_BV_CREDENTIAL_PERMISSIONS",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepare fail-closed без authenticated n8n origin", async () => {
  await assert.rejects(
    executeBusinessValueCommand(["prepare", "W-900700", "--strict"], {
      config,
      client: setupClient,
      env: {},
    }),
    (error) => error.code === "INITIATOR_FORBIDDEN",
  );
});

test("inspect-run возвращает только безопасное представление состояния", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-bv-cli-"));
  const store = new RunStore(directory);
  try {
    await store.write(RUN_ID, {
      schemaVersion: 1,
      runId: RUN_ID,
      taskCode: "W-900701",
      status: "PREPARED",
      reasonCode: "READY",
      sourceFingerprint: "a".repeat(64),
      modelVersion: "BV-MODEL-1",
      baselineVersion: "BV-BASE-1",
      source: { confidential: "не выводить" },
      modelCapability: "secret-capability",
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    });
    const result = await executeBusinessValueCommand(
      ["inspect-run", RUN_ID, "--state-dir", directory, "--strict"],
      { config, client: setupClient, env: {} },
    );
    assert.equal(result.reasonCode, "RUN_INSPECTED");
    assert.equal(result.result.run.runId, RUN_ID);
    assert.deepEqual(result.result.stageTrail, []);
    assert.match(result.human, /Этап:|Текущее состояние:|Следующий шаг:/u);
    const serialized = JSON.stringify(result.result);
    assert.doesNotMatch(serialized, /не выводить|secret-capability/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stage commands имеют typed RUN_NOT_FOUND вместо неявного сбоя", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-bv-cli-missing-"));
  try {
    for (const command of [
      "analyze",
      "score",
      "preview",
      "publish",
      "cancel",
      "inspect-run",
      "cleanup",
    ]) {
      await assert.rejects(
        executeBusinessValueCommand(
          [command, RUN_ID, "--state-dir", directory, "--strict"],
          { config, client: setupClient, env: {} },
        ),
        (error) => error.code === "RUN_NOT_FOUND",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("analyze отклоняет несовпадающий evaluator digest до model output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-bv-cli-evaluator-"));
  const store = new RunStore(directory);
  const evaluator = await loadEvaluator();
  try {
    await store.write(RUN_ID, {
      schemaVersion: 1,
      runId: RUN_ID,
      taskCode: "W-900702",
      status: "PREPARED",
      source: { taskType: "Задача", title: "Проверить расчёт" },
      preflight: {
        evaluationData: { result: "Проверяемый результат" },
        includedTaskCodes: ["W-900702"],
        excludedTaskCodes: [],
        unknownReach: false,
      },
      modelVersion: evaluator.notionVersion,
      baselineVersion: evaluator.tuple.baselineVersion,
      evaluator,
      modelCapability: "a".repeat(64),
    });
    await assert.rejects(
      executeBusinessValueCommand(
        ["analyze", RUN_ID, "--state-dir", directory, "--strict"],
        {
          config,
          client: setupClient,
          env: {
            W_BV_ALLOW_CODEX_SUBSCRIPTION: "true",
            W_BV_CODEX_URL: "http://codex.local",
          },
          fetchImpl: async () => ({
            ok: true,
            async json() {
              return {
                evaluator,
                evaluatorDigest: "b".repeat(64),
                result: {},
              };
            },
          }),
        },
      ),
      (error) => error.code === "EVALUATOR_MISMATCH",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
