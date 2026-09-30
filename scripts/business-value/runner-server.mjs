#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import Ajv from "ajv";

import { loadConfig } from "../notion-workflow-lib.mjs";
import { executeBusinessValueCommand } from "../business-value.mjs";
import { AuditLog } from "./audit.mjs";
import { BusinessValueError } from "./errors.mjs";
import { buildModelContext, evaluatorMatches } from "./evaluator.mjs";
import { verifyEvidenceAvailability } from "./evidence.mjs";
import { guardModelOutput, secretFingerprint } from "./guard.mjs";
import { RunStore } from "./run-store.mjs";
import { sanitizeResearchBrief } from "./sanitizer.mjs";
import {
  assertExactKeys,
  createModelCapabilityHeaders,
  errorPayload,
  readRequestJson,
  RUN_ID_PATTERN,
  writeJson,
} from "./server-utils.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const productAliases = (process.env.W_BV_PRODUCT_ALIASES || "").split(",").map(value => value.trim()).filter(Boolean);
if (!productAliases.length) throw new BusinessValueError("PRODUCT_ALIASES_REQUIRED", "Задай W_BV_PRODUCT_ALIASES для обезличивания проекта.");
const STATE_DIRECTORY = resolve(process.env.W_BV_STATE_DIR || "/var/lib/task-business-value");
const CODEX_URL = process.env.W_BV_CODEX_URL || "http://business-value-codex:8081";
const NOTION_CONFIG_PATH = process.env.W_BV_NOTION_CONFIG_PATH || "";
const notionConfig = await loadConfig({
  env: {},
  configPath: NOTION_CONFIG_PATH,
});
if (notionConfig.insecureFileMode) {
  throw new BusinessValueError(
    "NOTION_BV_CREDENTIAL_PERMISSIONS",
    "Dedicated Notion config должен иметь mode 600",
  );
}
const knownNotionSecretHashes = [secretFingerprint(notionConfig.token)];
const readJson = async (path) => JSON.parse(await readFile(resolve(ROOT, path), "utf8"));
const [briefSchema, evidenceSchema, modelConfig, runtimeManifest] = await Promise.all([
  readJson("config/business-value-research-brief.schema.json"),
  readJson("config/business-value-evidence.schema.json"),
  readJson("config/business-value-model.v1.json"),
  readJson("config/runtime-build-manifest.json"),
]);
const ajv = new Ajv({ allErrors: true, strict: true });
const validateBrief = ajv.compile(briefSchema);
const validateEvidence = ajv.compile(evidenceSchema);
const runStore = new RunStore(STATE_DIRECTORY);
const audit = new AuditLog(resolve(STATE_DIRECTORY, "audit"), {
  knownSecrets: [notionConfig.token],
});

const authenticatedActor = (request) => {
  if (request.headers["x-task-run-origin"] !== "n8n-form") {
    throw new BusinessValueError("INITIATOR_FORBIDDEN", "Разрешён только n8n Form Trigger");
  }
  const actor = String(request.headers["x-identity-serviceenticated-user"] || "").trim();
  if (!actor || actor.length > 200) {
    throw new BusinessValueError("INITIATOR_FORBIDDEN", "Не подтверждён пользователь n8n");
  }
  return actor;
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

const callModel = async (path, run, body) => {
  const stage = path.slice("/v1/".length);
  const response = await fetch(`${CODEX_URL}${path}`, {
    method: "POST",
    headers: {
      ...createModelCapabilityHeaders({
        capability: run.modelCapability,
        stage,
        runId: run.runId,
        body,
      }),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(150_000),
  });
  const output = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new BusinessValueError(
      output.reasonCode || "CODEX_SERVICE_FAILED",
      output.message || `Codex service вернул HTTP ${response.status}`,
    );
  }
  if (!evaluatorMatches(run.evaluator, output.evaluator)) {
    throw new BusinessValueError(
      "EVALUATOR_MISMATCH",
      "Codex service использует другую evaluator tuple",
    );
  }
  if (output.evaluatorDigest !== run.evaluator.digest) {
    throw new BusinessValueError(
      "EVALUATOR_MISMATCH",
      "Codex service вернул несовпадающий evaluator digest",
    );
  }
  return output.result;
};

const researchRun = async (runId) => {
  const startedAt = Date.now();
  const run = await runStore.read(runId);
  if (run.status !== "PREPARED") {
    throw new BusinessValueError("RUN_STAGE_INVALID", "Run не готов к research");
  }
  if (process.env.W_BV_ALLOW_CODEX_SUBSCRIPTION !== "true") {
    throw new BusinessValueError(
      "CODEX_SUBSCRIPTION_NOT_ALLOWED",
      "Передача snapshot отдельному Codex-сеансу не разрешена",
    );
  }
  const brief = guardModelOutput(
    await callModel("/v1/brief", run, {
      runId,
      source: modelSource(run),
      modelConfig: buildModelContext({ config: modelConfig, evaluator: run.evaluator }),
      modelVersion: run.modelVersion,
      baselineVersion: run.baselineVersion,
      evaluatorDigest: run.evaluator.digest,
    }),
    { knownSecretHashes: knownNotionSecretHashes },
  );
  if (!validateBrief(brief)) {
    throw new BusinessValueError("RESEARCH_BRIEF_SCHEMA_INVALID", "Research brief не прошёл schema");
  }
  let sanitized;
  try {
    sanitized = sanitizeResearchBrief(brief, {
      confidentialText: JSON.stringify(modelSource(run)),
      productAliases,
    });
  } catch (error) {
    if (error.code !== "EXTERNAL_SEARCH_PRIVACY_BLOCKED") throw error;
    const timestamp = new Date().toISOString();
    await runStore.update(runId, {
      researchBriefHash: createHash("sha256").update(JSON.stringify(brief)).digest("hex"),
      researchReason: error.code,
      status: "RESEARCH_SKIPPED",
      updatedAt: timestamp,
    });
    await audit.stage({
      schemaVersion: 1,
      timestamp,
      runId,
      actor: run.actor,
      stage: "research",
      status: "RESEARCH_SKIPPED",
      reasonCode: error.code,
      durationMs: Math.max(0, Date.now() - startedAt),
      evaluatorDigest: run.evaluator.digest,
      evaluator: run.evaluator.tuple,
      sourceCount: 0,
      evidenceIds: [],
      evidenceUrls: [],
    });
    return { status: "RESEARCH_SKIPPED", reasonCode: error.code, sourceCount: 0 };
  }
  await audit.external(
    { timestamp: new Date().toISOString(), runId, stage: "research", sanitized },
    {
      confidentialText: JSON.stringify(modelSource(run)),
      productAliases,
    },
  );
  const candidateEvidence = guardModelOutput(
    await callModel("/v1/research", run, {
      runId,
      brief: sanitized,
      evaluatorDigest: run.evaluator.digest,
    }),
    {
      knownSecretHashes: knownNotionSecretHashes,
    },
  );
  if (!validateEvidence(candidateEvidence)) {
    throw new BusinessValueError("EVIDENCE_SCHEMA_INVALID", "External evidence не прошёл schema");
  }
  const evidence = await verifyEvidenceAvailability(candidateEvidence);
  const timestamp = new Date().toISOString();
  await runStore.update(runId, {
    researchBriefHash: createHash("sha256").update(JSON.stringify(brief)).digest("hex"),
    sanitizedResearchHash: createHash("sha256").update(JSON.stringify(sanitized)).digest("hex"),
    evidence: [evidence],
    evidenceHash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    status: "RESEARCHED",
    updatedAt: timestamp,
  });
  await audit.stage({
    schemaVersion: 1,
    timestamp,
    runId,
    actor: run.actor,
    stage: "research",
    status: "RESEARCHED",
    reasonCode: "EVIDENCE_VALID",
    durationMs: Math.max(0, Date.now() - startedAt),
    evaluatorDigest: run.evaluator.digest,
    evaluator: run.evaluator.tuple,
    sourceCount: evidence.sources.length,
    evidenceIds: evidence.sources.map((source) => source.id),
    evidenceUrls: evidence.sources.map((source) => source.url),
  });
  return { status: "RESEARCHED", reasonCode: "EVIDENCE_VALID", sourceCount: evidence.sources.length };
};

const commandForStage = {
  analyze: "analyze",
  score: "score",
  preview: "preview",
  publish: "publish",
  cancel: "cancel",
  inspect: "inspect-run",
  cleanup: "cleanup",
};

const server = createServer(async (request, response) => {
  const requestStartedAt = Date.now();
  let actor = "";
  try {
    if (request.method === "GET" && request.url === "/health") {
      if (process.env.W_BV_ALLOW_CODEX_SUBSCRIPTION !== "true") {
        throw new BusinessValueError(
          "CODEX_SUBSCRIPTION_NOT_ALLOWED",
          "Codex subscription execution не разрешён",
        );
      }
      const codexHealth = await fetch(`${CODEX_URL}/health`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!codexHealth.ok) {
        throw new BusinessValueError(
          "CODEX_SERVICE_UNHEALTHY",
          "Codex service не прошёл healthcheck",
        );
      }
      const codexStatus = await codexHealth.json().catch(() => ({}));
      if (codexStatus.sourceDigest !== runtimeManifest.sourceDigest) {
        throw new BusinessValueError(
          "RUNTIME_MANIFEST_DRIFT",
          "Runner и Codex images собраны из разных canonical source",
        );
      }
      writeJson(response, 200, {
        ok: true,
        service: "business-value-runner",
        codex: "healthy",
        sourceDigest: runtimeManifest.sourceDigest,
      });
      return;
    }
    actor = authenticatedActor(request);
    if (request.method === "POST" && request.url === "/v1/runs/prepare") {
      const body = await readRequestJson(request, 4096);
      assertExactKeys(body, ["taskCode"]);
      const runId = randomUUID();
      const output = await executeBusinessValueCommand(
        ["prepare", body.taskCode, "--run-id", runId, "--state-dir", STATE_DIRECTORY, "--strict"],
        {
          env: {
            ...process.env,
            W_BV_RUN_ORIGIN: "n8n-form",
            W_BV_AUTHENTICATED_USER: actor,
          },
        },
      );
      writeJson(response, 200, { ok: true, ...output });
      return;
    }
    const match = request.url?.match(/^\/v1\/runs\/([0-9a-f-]+)\/(research|analyze|score|preview|publish|cancel|inspect|cleanup)$/u);
    if (!match || !RUN_ID_PATTERN.test(match[1])) {
      writeJson(response, 404, { ok: false, reasonCode: "ROUTE_NOT_FOUND" });
      return;
    }
    const [, runId, stage] = match;
    if ((stage === "inspect" ? request.method !== "GET" : request.method !== "POST")) {
      writeJson(response, 405, { ok: false, reasonCode: "METHOD_NOT_ALLOWED" });
      return;
    }
    const run = await runStore.read(runId);
    if (run.actor !== actor) {
      throw new BusinessValueError("RUN_ACTOR_MISMATCH", "Run принадлежит другому пользователю");
    }
    const output = stage === "research"
      ? { reasonCode: "RESEARCH_COMPLETE", human: "Research stage завершён.", result: await researchRun(runId) }
      : await executeBusinessValueCommand(
          [commandForStage[stage], runId, "--state-dir", STATE_DIRECTORY, "--strict"],
          { env: process.env },
        );
    writeJson(response, 200, { ok: true, ...output });
  } catch (error) {
    const runId = request.url?.match(/^\/v1\/runs\/([0-9a-f-]+)\//u)?.[1];
    if (runId && RUN_ID_PATTERN.test(runId)) {
      try {
        const run = await runStore.read(runId);
        await audit.stage({
          schemaVersion: 1,
          timestamp: new Date().toISOString(),
          runId,
          actor: actor || run.actor,
          stage: request.url.split("/").at(-1) || "unknown",
          status: "ERROR",
          reasonCode: error.code || "BUSINESS_VALUE_FAILED",
          durationMs: Math.max(0, Date.now() - requestStartedAt),
          evaluatorDigest: run.evaluator.digest,
          evaluator: run.evaluator.tuple,
          rollback: error.details?.rollback || "not_started",
          impact: "stage остановлен; неподтверждённый результат не публикуется",
        });
      } catch {
        // Ошибка audit не должна скрывать исходную типизированную причину HTTP stage.
      }
    }
    const status = error.code?.includes("INITIATOR")
      ? 403
      : error.code?.includes("UNHEALTHY") || error.code?.includes("AUTH")
        ? 503
        : 400;
    writeJson(response, status, errorPayload(error));
  }
});

const port = Number(process.env.PORT || 8080);
server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`business-value-runner listening on ${port}\n`);
});
