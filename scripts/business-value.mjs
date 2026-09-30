#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  loadConfig,
  NotionClient,
  TaskNotionError,
} from "./notion-workflow-lib.mjs";
import { AuditLog, humanRunSummary } from "./business-value/audit.mjs";
import { cleanupRun, recordIncompleteRollback } from "./business-value/cleanup.mjs";
import { BusinessValueError, fail } from "./business-value/errors.mjs";
import {
  buildModelContext,
  evaluatorMatches,
  loadEvaluator,
} from "./business-value/evaluator.mjs";
import { buildSignificantFingerprint } from "./business-value/fingerprint.mjs";
import { guardModelOutput, secretFingerprint } from "./business-value/guard.mjs";
import { NotionBusinessValueAdapter } from "./business-value/notion-adapter.mjs";
import {
  resolveUniqueBotIdentity,
  setupBusinessValueSchema,
} from "./business-value/notion-setup.mjs";
import { PreviewStore } from "./business-value/preview-store.mjs";
import { publishBusinessValue } from "./business-value/publisher.mjs";
import { buildPreview } from "./business-value/renderer.mjs";
import { RunStore } from "./business-value/run-store.mjs";
import { scoreAssessment } from "./business-value/scorer.mjs";
import { createModelCapabilityHeaders } from "./business-value/server-utils.mjs";
import { readTaskSource } from "./business-value/source.mjs";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const DEFAULT_STATE = resolve(ROOT, ".project/business-value");
const MODEL_CONFIG_PATH = resolve(ROOT, "config/business-value-model.v1.json");
const ASSESSMENT_SCHEMA_PATH = resolve(
  ROOT,
  "config/business-value-assessment.schema.json",
);
const PREVIEW_SCHEMA_PATH = resolve(ROOT, "config/business-value-preview.schema.json");

const usage = () => `Команды:
  npm run business-value -- setup (--dry-run|--approved) --strict
  npm run business-value -- prepare CODE-N [--run-id UUID] --strict
  npm run business-value -- analyze UUID --strict
  npm run business-value -- score UUID --strict
  npm run business-value -- preview UUID --strict
  npm run business-value -- publish UUID --strict
  npm run business-value -- cancel UUID --strict
  npm run business-value -- inspect-run UUID --strict
  npm run business-value -- cleanup UUID --strict`;

const parseArguments = (argv) => {
  const [command = "", ...rest] = argv;
  let target = "";
  const flags = { strict: false, dryRun: false, approved: false, runId: "", stateDirectory: "" };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--strict") flags.strict = true;
    else if (argument === "--dry-run") flags.dryRun = true;
    else if (argument === "--approved") flags.approved = true;
    else if (["--run-id", "--state-dir"].includes(argument)) {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) fail("INVALID_ARGUMENT", `Не задан ${argument}`);
      if (argument === "--run-id") flags.runId = value;
      else flags.stateDirectory = value;
      index += 1;
    } else if (!argument.startsWith("--") && !target) target = argument;
    else fail("INVALID_ARGUMENT", `Неизвестный параметр ${argument}`);
  }
  return { command, target, flags };
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isoNow = (clock) => clock().toISOString();

const assertRunEvaluator = (run, currentEvaluator) => {
  if (!evaluatorMatches(run.evaluator, currentEvaluator)) {
    fail("EVALUATOR_MISMATCH", "Run создан другой версией evaluator");
  }
};

const modelSource = (run) => ({
  taskCode: run.taskCode,
  taskType: run.source.taskType,
  title: run.source.title,
  evaluationData: run.preflight.evaluationData,
  includedTaskCodes: run.preflight.includedTaskCodes,
  excludedTaskCodes: run.preflight.excludedTaskCodes,
  unknownReach: run.preflight.unknownReach,
});

const requireN8nInitiator = (env) => {
  if (env.W_BV_RUN_ORIGIN !== "n8n-form" || !env.W_BV_AUTHENTICATED_USER) {
    fail(
      "INITIATOR_FORBIDDEN",
      "Оценку можно начать только из аутентифицированной n8n-формы",
    );
  }
};

const publicRunView = (run) => ({
  runId: run.runId,
  taskCode: run.taskCode,
  status: run.status,
  reasonCode: run.reasonCode || "OK",
  sourceFingerprint: run.sourceFingerprint,
  modelVersion: run.modelVersion,
  baselineVersion: run.baselineVersion,
  evaluatorDigest: run.evaluator?.digest,
  score: run.score
    ? { value: run.score.value, status: run.score.status, confidence: run.score.confidence }
    : null,
  recovery: run.recovery || null,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
});

const appendStageAudit = (audit, run, event, startedAt) =>
  audit.stage({
    schemaVersion: 1,
    timestamp: event.timestamp,
    runId: run.runId,
    actor: run.actor,
    stage: event.stage,
    status: event.status,
    reasonCode: event.reasonCode,
    durationMs: Math.max(0, Date.now() - startedAt),
    evaluatorDigest: run.evaluator.digest,
    evaluator: run.evaluator.tuple,
    ...event,
  });

export async function executeBusinessValueCommand(
  argv,
  {
    env = process.env,
    clock = () => new Date(),
    fetchImpl = globalThis.fetch,
    client: injectedClient,
    config: injectedConfig,
  } = {},
) {
  const commandStartedAt = Date.now();
  const { command, target, flags } = parseArguments(argv);
  const stateDirectory = resolve(flags.stateDirectory || env.W_BV_STATE_DIR || DEFAULT_STATE);
  const [modelConfig, assessmentSchema, previewSchema, evaluator] = await Promise.all([
    readJson(MODEL_CONFIG_PATH),
    readJson(ASSESSMENT_SCHEMA_PATH),
    readJson(PREVIEW_SCHEMA_PATH),
    loadEvaluator({ root: ROOT }),
  ]);
  if (modelConfig.baselineVersion !== evaluator.tuple.baselineVersion) {
    fail("EVALUATOR_BASELINE_MISMATCH", "Evaluator и scoring config используют разные baseline");
  }
  const effectiveModelConfig = {
    ...modelConfig,
    modelVersion: evaluator.notionVersion,
  };
  const modelContext = buildModelContext({ config: modelConfig, evaluator });
  const notionConfigPath = env.W_BV_NOTION_CONFIG_PATH || "";
  if (!injectedConfig && !notionConfigPath) {
    fail(
      "NOTION_BV_CREDENTIAL_MISSING",
      "Не задан отдельный W_BV_NOTION_CONFIG_PATH для Business Value integration",
    );
  }
  if (
    !injectedConfig &&
    env.W_NOTION_CONFIG_PATH &&
    resolve(notionConfigPath) === resolve(env.W_NOTION_CONFIG_PATH)
  ) {
    fail(
      "NOTION_BV_CREDENTIAL_NOT_DEDICATED",
      "Business Value не использует общий Notion credential",
    );
  }
  const config = injectedConfig ||
    (await loadConfig({
      env: {},
      configPath: notionConfigPath,
    }));
  if (!injectedConfig && config.insecureFileMode) {
    fail(
      "NOTION_BV_CREDENTIAL_PERMISSIONS",
      "Dedicated Notion config должен иметь mode 600",
    );
  }
  const client = injectedClient || new NotionClient({ token: config.token, fetchImpl });
  const runStore = new RunStore(stateDirectory);
  const previewStore = new PreviewStore(stateDirectory);
  const audit = new AuditLog(resolve(stateDirectory, "audit"), {
    knownSecrets: [config.token],
  });

  if (command === "setup") {
    const result = await setupBusinessValueSchema(client, config, effectiveModelConfig, {
      dryRun: flags.dryRun,
      approved: flags.approved,
      expectedBotName: env.W_BV_NOTION_BOT_NAME || "W Business Value",
    });
    return {
      reasonCode: "BUSINESS_VALUE_SETUP_OK",
      human: result.dryRun
        ? `Notion schema dry-run: добавить ${result.addedPropertyNames.length}, переименовать ${result.renames.length}.`
        : `Notion schema применена; добавлено ${result.addedPropertyNames.length}, переименовано ${result.renames.length}.`,
      result,
    };
  }

  if (command === "prepare") {
    requireN8nInitiator(env);
    const runId = flags.runId || randomUUID();
    const sourceResult = await readTaskSource(client, config, target);
    const sourceFingerprint = buildSignificantFingerprint(sourceResult.source);
    const timestamp = isoNow(clock);
    const run = {
      schemaVersion: 1,
      runId,
      taskCode: sourceResult.source.taskCode,
      pageId: sourceResult.pageId,
      pageUrl: sourceResult.source.pageUrl || "",
      actor: env.W_BV_AUTHENTICATED_USER,
      origin: "n8n-form",
      status: sourceResult.preflight.modelAllowed ? "PREPARED" : "NEEDS_INPUT",
      reasonCode: sourceResult.preflight.modelAllowed ? "READY" : "NEEDS_INPUT",
      source: sourceResult.source,
      preflight: sourceResult.preflight,
      sourceFingerprint,
      modelVersion: evaluator.notionVersion,
      baselineVersion: modelConfig.baselineVersion,
      evaluator,
      modelCapability: randomBytes(32).toString("hex"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await runStore.write(runId, run);
    await appendStageAudit(audit, run, {
      timestamp,
      stage: "prepare",
      status: run.status,
      reasonCode: run.reasonCode,
      taskCode: run.taskCode,
      inputFingerprint: sourceFingerprint,
      preflight: run.preflight,
      modelCalls: 0,
      searchCalls: 0,
    }, commandStartedAt);
    return {
      reasonCode: run.reasonCode,
      human: sourceResult.preflight.modelAllowed
        ? `Карточка ${run.taskCode} подготовлена; run id ${runId}.`
        : `Для ${run.taskCode} нужны данные: ${sourceResult.preflight.questions.join(" ")}`,
      result: publicRunView(run),
    };
  }

  if (!target) fail("RUN_ID_REQUIRED", "Укажи run id");

  if (command === "analyze") {
    const run = await runStore.read(target);
    assertRunEvaluator(run, evaluator);
    if (!["PREPARED", "RESEARCHED", "RESEARCH_SKIPPED"].includes(run.status)) {
      fail("RUN_STAGE_INVALID", "Run не готов к анализу");
    }
    if (env.W_BV_ALLOW_CODEX_SUBSCRIPTION !== "true") {
      fail(
        "CODEX_SUBSCRIPTION_NOT_ALLOWED",
        "Передача snapshot отдельному Codex-сеансу не разрешена",
      );
    }
    if (!env.W_BV_CODEX_URL) fail("CODEX_ENDPOINT_MISSING", "Не задан W_BV_CODEX_URL");
    const requestBody = {
      runId: run.runId,
      source: modelSource(run),
      evidence: run.evidence || [],
      modelConfig: modelContext,
      modelVersion: run.modelVersion,
      baselineVersion: run.baselineVersion,
      evaluatorDigest: run.evaluator.digest,
    };
    const response = await fetchImpl(`${env.W_BV_CODEX_URL}/v1/analyze`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...createModelCapabilityHeaders({
          capability: run.modelCapability,
          stage: "analyze",
          runId: run.runId,
          body: requestBody,
        }),
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) fail("CODEX_CALL_FAILED", `Codex endpoint вернул HTTP ${response.status}`);
    const envelope = await response.json();
    if (!evaluatorMatches(run.evaluator, envelope.evaluator)) {
      fail("EVALUATOR_MISMATCH", "Codex endpoint использует другую evaluator tuple");
    }
    if (envelope.evaluatorDigest !== run.evaluator.digest) {
      fail("EVALUATOR_MISMATCH", "Codex endpoint вернул несовпадающий evaluator digest");
    }
    const assessment = guardModelOutput(envelope.result, {
      knownSecretHashes: [secretFingerprint(config.token)],
    });
    const validate = new Ajv({ allErrors: true, strict: true }).compile(assessmentSchema);
    if (!validate(assessment)) fail("MODEL_OUTPUT_SCHEMA_INVALID", "Model output не прошёл schema");
    const timestamp = isoNow(clock);
    const updated = await runStore.update(target, (current) => ({
      ...current,
      assessment,
      assessmentHash: hash(assessment),
      status: "ANALYZED",
      updatedAt: timestamp,
    }));
    await appendStageAudit(audit, updated, {
      timestamp,
      stage: "analyze",
      status: "ANALYZED",
      reasonCode: "MODEL_OUTPUT_VALID",
      inputHash: hash({ source: modelSource(run), evidence: run.evidence || [], modelConfig: modelContext }),
      outputHash: updated.assessmentHash,
      evidenceIds: (run.evidence || []).flatMap((item) =>
        (item.sources || [item]).map((source) => source.id).filter(Boolean),
      ),
    }, commandStartedAt);
    return { reasonCode: "MODEL_OUTPUT_VALID", human: `Run ${target}: analysis schema подтверждена.`, result: publicRunView(updated) };
  }

  if (command === "score") {
    const run = await runStore.read(target);
    assertRunEvaluator(run, evaluator);
    if (!run.assessment) fail("RUN_STAGE_INVALID", "В run отсутствует assessment");
    const evidenceSources = (run.evidence || []).flatMap(
      (item) => item.sources || [item],
    );
    const score = scoreAssessment({
      assessment: run.assessment,
      taskType: run.source.taskType,
      config: modelConfig,
      evaluator: run.evaluator,
      evidenceSources,
      expectedTaskCode: run.taskCode,
    });
    const timestamp = isoNow(clock);
    const updated = await runStore.update(target, (current) => ({
      ...current,
      score,
      status: "SCORED",
      updatedAt: timestamp,
    }));
    await appendStageAudit(audit, updated, {
      timestamp,
      stage: "score",
      status: "SCORED",
      reasonCode: score.status,
      value: score.value,
      scoreHash: hash(score),
    }, commandStartedAt);
    return { reasonCode: score.status, human: `Run ${target}: ${score.statusLabel}, Business Value ${score.value ?? "не публикуется"}.`, result: publicRunView(updated) };
  }

  if (command === "preview") {
    const run = await runStore.read(target);
    assertRunEvaluator(run, evaluator);
    if (!run.score) fail("RUN_STAGE_INVALID", "В run отсутствует mechanical score");
    if (["BLOCKED", "NEEDS_INPUT"].includes(run.score.status)) {
      fail("PREVIEW_BLOCKED", "Для оценки нужны дополнительные данные");
    }
    const adapter = new NotionBusinessValueAdapter({ client, config, taskCode: run.taskCode });
    await adapter.initialize();
    const current = await adapter.readPublicationState(run.pageId);
    if (current.fingerprint !== run.sourceFingerprint) fail("SOURCE_CONFLICT", "Карточка изменилась после prepare");
    const calculatedAt = isoNow(clock);
    const expiresAt = new Date(clock().getTime() + 30 * 60 * 1000).toISOString();
    const evidence = (run.evidence || []).flatMap((item) => item.sources || [item]);
    const preview = buildPreview({
      runId: target,
      taskCode: run.taskCode,
      taskType: run.source.taskType,
      sourceFingerprint: run.sourceFingerprint,
      score: run.score,
      previous: {
        value: current.visibleBusinessValue,
        status: current.displayStatus,
        confidence: current.bvFields["BV уверенность"],
        fields: current.bvFields,
      },
      evidence,
      warnings: ["Reference baseline является симуляцией, а не прогнозом."],
      expiresAt,
      calculatedAt,
    });
    const validate = new Ajv({ allErrors: true, strict: true }).compile(previewSchema);
    if (!validate(preview)) fail("PREVIEW_SCHEMA_INVALID", "Preview не прошёл schema");
    await previewStore.write(target, preview);
    const updated = await runStore.update(target, {
      previewHash: hash(preview),
      status: "PREVIEW_READY",
      updatedAt: calculatedAt,
    });
    await appendStageAudit(audit, updated, {
      timestamp: calculatedAt,
      stage: "preview",
      status: "PREVIEW_READY",
      reasonCode: "PREVIEW_READY",
      previewHash: updated.previewHash,
      evidenceUrls: preview.sourceUrls,
    }, commandStartedAt);
    return { reasonCode: "PREVIEW_READY", human: `Run ${target}: preview готов до ${expiresAt}.`, result: preview };
  }

  if (command === "publish") {
    const run = await runStore.read(target);
    assertRunEvaluator(run, evaluator);
    if (run.status !== "PREVIEW_READY") fail("RUN_STAGE_INVALID", "Run не ожидает публикации");
    const adapter = new NotionBusinessValueAdapter({ client, config, taskCode: run.taskCode });
    await adapter.initialize();
    const botIdentity = await resolveUniqueBotIdentity(client, {
      expectedName: env.W_BV_NOTION_BOT_NAME || "W Business Value",
    });
    const result = await publishBusinessValue({
      adapter,
      previewStore,
      runId: target,
      pageId: run.pageId,
      modelConfig: {
        ...effectiveModelConfig,
        evaluatorDigest: evaluator.digest,
      },
      botIdentity,
      now: clock(),
      recoveryRecorder: (recovery) => recordIncompleteRollback(runStore, target, recovery),
    });
    const timestamp = isoNow(clock);
    const updated = await runStore.update(target, { status: "PUBLISHED", publication: result, updatedAt: timestamp });
    await appendStageAudit(audit, updated, {
      timestamp,
      stage: "publish",
      status: "PUBLISHED",
      reasonCode: "PUBLISHED",
      value: result.value,
      managedBlockId: result.managedBlockId,
      rollback: "not_required",
    }, commandStartedAt);
    return { reasonCode: "PUBLISHED", human: `Run ${target}: Business Value ${result.value} опубликован.`, result };
  }

  if (command === "cancel") {
    await runStore.read(target);
    await previewStore.cancel(target);
    const timestamp = isoNow(clock);
    const updated = await runStore.update(target, { status: "CANCELLED", updatedAt: timestamp });
    await appendStageAudit(audit, updated, {
      timestamp,
      stage: "decision",
      status: "CANCELLED",
      reasonCode: "USER_CANCELLED",
      rollback: "not_required",
    }, commandStartedAt);
    return { reasonCode: "USER_CANCELLED", human: `Run ${target}: preview отменён, Notion не изменён.`, result: publicRunView(updated) };
  }

  if (command === "inspect-run") {
    const run = await runStore.read(target);
    const stageTrail = await audit.readInternal(target);
    const last = stageTrail.at(-1);
    const human = humanRunSummary({
      stage: last?.stage || "prepare",
      expected: "последовательный stage trail и подтверждённое текущее состояние",
      actual: `${run.status}; событий audit: ${stageTrail.length}`,
      currentState: run.status,
      rollback: run.recovery?.status || last?.rollback || "не требовался",
      impact: run.status === "PUBLISHED"
        ? `Business Value ${run.score?.value ?? "неизвестен"} опубликован`
        : "неподтверждённая оценка не считается опубликованной",
      reasonCode: run.reasonCode || last?.reasonCode || "OK",
      nextStep: run.status === "PREVIEW_READY"
        ? `подтвердить publish или cancel для ${target}`
        : `проверить следующий допустимый stage для ${target}`,
      detailsPath: `${resolve(stateDirectory, "audit/internal.jsonl")}#${target}`,
    });
    return {
      reasonCode: "RUN_INSPECTED",
      human,
      result: { run: publicRunView(run), stageTrail },
    };
  }

  if (command === "cleanup") {
    const run = await runStore.read(target);
    const adapter = new NotionBusinessValueAdapter({ client, config, taskCode: run.taskCode });
    await adapter.initialize();
    const result = await cleanupRun({ runStore, adapter, runId: target });
    const updated = await runStore.read(target);
    await appendStageAudit(audit, updated, {
      timestamp: isoNow(clock),
      stage: "cleanup",
      status: result.status,
      reasonCode: "CLEANED",
      rollback: "recovery_resolved",
    }, commandStartedAt);
    return { reasonCode: "CLEANED", human: `Run ${target}: cleanup завершён.`, result };
  }

  fail("UNKNOWN_COMMAND", command ? `Неизвестная команда ${command}` : usage());
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  try {
    const output = await executeBusinessValueCommand(argv, dependencies);
    process.stdout.write(`${output.reasonCode}\n${output.human}\n${JSON.stringify(output.result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const code = error.code || "BUSINESS_VALUE_FAILED";
    const summary = humanRunSummary({
      stage: argv[0] || "cli",
      expected: "штатное завершение команды",
      actual: error.message || "неизвестная ошибка",
      currentState: "проверь inspect-run; неподтверждённая публикация не считается успешной",
      rollback: error.details?.rollback || "не применялся",
      impact: "автоматическое продолжение остановлено",
      reasonCode: code,
      nextStep: argv[1] ? `npm run business-value -- inspect-run ${argv[1]} --strict` : usage(),
      detailsPath: ".project/business-value/audit/internal.jsonl",
    });
    process.stderr.write(`${code}\n${summary}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runCli();
}

export { parseArguments, publicRunView, requireN8nInitiator };
