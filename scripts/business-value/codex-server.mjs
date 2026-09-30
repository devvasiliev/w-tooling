#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import Ajv from "ajv";

import { BusinessValueError } from "./errors.mjs";
import {
  buildModelContext,
  canonicalJson,
  loadEvaluator,
} from "./evaluator.mjs";
import { guardModelOutput } from "./guard.mjs";
import { assertEvidenceMatchesBrief } from "./evidence.mjs";
import { callStructuredCodex, checkCodexHealth } from "./codex-provider.mjs";
import { SerialTaskQueue } from "./serial-queue.mjs";
import {
  assertExactKeys,
  capabilityKey,
  errorPayload,
  readRequestJson,
  RUN_ID_PATTERN,
  verifyModelCapability,
  writeJson,
} from "./server-utils.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const readText = (path) => readFile(resolve(ROOT, path), "utf8");
const readJson = async (path) => JSON.parse(await readText(path));
const evaluator = await loadEvaluator({ root: ROOT });
const authPath = process.env.W_BV_CODEX_AUTH_PATH || "/var/lib/codex/auth.json";

const resources = await Promise.all([
  readJson("config/business-value-codex-envelope.schema.json"),
  readJson("config/business-value-research-brief.schema.json"),
  readJson("config/business-value-evidence.schema.json"),
  readJson("config/business-value-assessment.schema.json"),
  readJson("config/business-value-model.v1.json"),
  readJson("config/runtime-build-manifest.json"),
  readText("config/prompts/business-value-research-brief.md"),
  readText("config/prompts/business-value-external-research.md"),
  readText("config/prompts/business-value-production-assessment.md"),
]);
const [envelopeSchema, briefSchema, evidenceSchema, assessmentSchema, modelConfig, runtimeManifest, briefPrompt, researchPrompt, assessmentPrompt] = resources;
const expectedModelContext = buildModelContext({ config: modelConfig, evaluator });
const ajv = new Ajv({ allErrors: true, strict: true });
const validateEnvelope = ajv.compile(envelopeSchema);
const contracts = {
  brief: {
    path: "/v1/brief",
    allowedKeys: ["runId", "source", "modelConfig", "modelVersion", "baselineVersion", "evaluatorDigest"],
    schemaPath: resolve(ROOT, "config/business-value-research-brief.schema.json"),
    validate: ajv.compile(briefSchema),
    prompt: briefPrompt,
    webSearch: "disabled",
  },
  research: {
    path: "/v1/research",
    allowedKeys: ["runId", "brief", "evaluatorDigest"],
    schemaPath: resolve(ROOT, "config/business-value-evidence.schema.json"),
    validate: ajv.compile(evidenceSchema),
    prompt: researchPrompt,
    webSearch: "live",
  },
  analyze: {
    path: "/v1/analyze",
    allowedKeys: ["runId", "source", "evidence", "modelConfig", "modelVersion", "baselineVersion", "evaluatorDigest"],
    schemaPath: resolve(ROOT, "config/business-value-assessment.schema.json"),
    validate: ajv.compile(assessmentSchema),
    prompt: assessmentPrompt,
    webSearch: "disabled",
  },
};
const byPath = new Map(Object.entries(contracts).map(([stage, value]) => [value.path, { stage, ...value }]));
const consumedCapabilities = new Map();
const codexQueue = new SerialTaskQueue();

const authorize = (request, stage, runId, body) => {
  const now = Date.now();
  for (const [key, expiresAt] of consumedCapabilities) {
    if (expiresAt <= now) consumedCapabilities.delete(key);
  }
  const proof = verifyModelCapability({
    headers: request.headers,
    stage,
    runId,
    body,
    now,
  });
  const key = capabilityKey(proof.signature, stage, runId);
  if (consumedCapabilities.has(key)) {
    throw new BusinessValueError("MODEL_CAPABILITY_REUSED", "Model capability уже использован для stage");
  }
  consumedCapabilities.set(key, proof.expiresAt);
};

const assertEvaluator = (body) => {
  if (body.evaluatorDigest !== evaluator.digest) {
    throw new BusinessValueError(
      "EVALUATOR_MISMATCH",
      "Запрос создан другой версией evaluator",
    );
  }
  if (body.modelConfig && canonicalJson(body.modelConfig) !== canonicalJson(expectedModelContext)) {
    throw new BusinessValueError(
      "MODEL_CONFIG_MISMATCH",
      "Запрос использует другую versioned metric config",
    );
  }
};

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      const health = await codexQueue.run(() =>
        checkCodexHealth({ authPath, evaluator }),
      );
      writeJson(response, 200, {
        ok: true,
        service: "business-value-codex",
        sourceDigest: runtimeManifest.sourceDigest,
        ...health,
      });
      return;
    }
    const contract = byPath.get(request.url);
    if (request.method !== "POST" || !contract) {
      writeJson(response, 404, { ok: false, reasonCode: "ROUTE_NOT_FOUND" });
      return;
    }
    const body = await readRequestJson(request);
    assertExactKeys(body, contract.allowedKeys);
    if (!RUN_ID_PATTERN.test(body.runId || "")) {
      throw new BusinessValueError("INVALID_RUN_ID", "Некорректный run id");
    }
    assertEvaluator(body);
    authorize(request, contract.stage, body.runId, body);
    const output = guardModelOutput(
      await codexQueue.run(() =>
        callStructuredCodex({
          authPath,
          evaluator,
          prompt: contract.prompt,
          input: body,
          schemaPath: contract.schemaPath,
          webSearch: contract.webSearch,
        }),
      ),
    );
    if (!contract.validate(output)) {
      throw new BusinessValueError(
        "MODEL_OUTPUT_SCHEMA_INVALID",
        "Model output не прошёл локальную schema",
      );
    }
    if (contract.stage === "research") assertEvidenceMatchesBrief(output, body.brief);
    const envelope = { evaluator, evaluatorDigest: evaluator.digest, result: output };
    if (!validateEnvelope(envelope)) {
      throw new BusinessValueError(
        "EVALUATOR_ENVELOPE_INVALID",
        "Codex transport envelope не прошёл schema",
      );
    }
    writeJson(response, 200, envelope);
  } catch (error) {
    const authFailure = error.code === "CODEX_AUTH_NOT_CHATGPT";
    const status = authFailure ? 503 : error.code?.includes("CAPABILITY") ? 401 : 400;
    writeJson(response, status, errorPayload(error));
  }
});

const port = Number(process.env.PORT || 8081);
server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`business-value-codex listening on ${port}\n`);
});
