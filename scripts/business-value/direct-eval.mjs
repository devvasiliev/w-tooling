import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import Ajv from "ajv";

import { callStructuredCodex } from "./codex-provider.mjs";
import { buildModelContext, loadEvaluator } from "./evaluator.mjs";
import { guardModelOutput } from "./guard.mjs";
import { scoreAssessment } from "./scorer.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const DEFAULT_MATRIX = join(ROOT, "fixtures/business-value/matrix.json");
const ASSESSMENT_SCHEMA = join(
  ROOT,
  "config/business-value-assessment.schema.json",
);
const PROMPT = join(ROOT, "config/prompts/business-value-production-assessment.md");
const MODEL_CONFIG = join(ROOT, "config/business-value-model.v1.json");
const DEFAULT_STATE = join(ROOT, ".project/business-value-eval");

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const parseArguments = (argv) => {
  const options = {
    matrixPath: DEFAULT_MATRIX,
    stateDirectory: process.env.W_BV_EVAL_STATE_DIR || DEFAULT_STATE,
    authPath:
      process.env.W_BV_CODEX_AUTH_PATH ||
      process.env.CODEX_AUTH_PATH || (() => { throw new Error("Задай W_BV_CODEX_AUTH_PATH"); })(),
    caseId: "",
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (["--matrix", "--state-dir", "--auth-path", "--case"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Не задано значение ${argument}`);
      }
      const key = {
        "--matrix": "matrixPath",
        "--state-dir": "stateDirectory",
        "--auth-path": "authPath",
        "--case": "caseId",
      }[argument];
      options[key] = value;
      index += 1;
    } else throw new Error(`Неизвестный параметр ${argument}`);
  }
  return options;
};

export const validateMatrix = (matrix) => {
  if (matrix?.schemaVersion !== 1 || !Array.isArray(matrix.cases)) {
    throw new Error("DIRECT_MATRIX_INVALID: ожидается schemaVersion=1 и cases[]");
  }
  const ids = matrix.cases.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("DIRECT_MATRIX_INVALID: id сценариев должны быть уникальны");
  }
  for (const item of matrix.cases) {
    if (!/^[a-z][a-z0-9_]*$/u.test(item.id || "")) {
      throw new Error(`DIRECT_MATRIX_INVALID: недопустимый id ${item.id}`);
    }
    if (item.expect?.modelCall !== (item.preflightExpected !== "NEEDS_INPUT")) {
      throw new Error(`DIRECT_MATRIX_INVALID: modelCall расходится с preflight ${item.id}`);
    }
  }
  return matrix;
};

export const assertExpectations = (scenario, assessment) => {
  const expectation = scenario.expect || {};
  if (expectation.statuses && !expectation.statuses.includes(assessment.status)) {
    throw new Error(
      `DIRECT_EXPECTATION_FAILED: ${scenario.id} status=${assessment.status}`,
    );
  }
  const effects = assessment.effects || [];
  const byMetric = new Map(effects.map((effect) => [effect.metricId, effect]));
  for (const metricId of expectation.requiredMetricIds || []) {
    if (!byMetric.has(metricId)) {
      throw new Error(
        `DIRECT_EXPECTATION_FAILED: ${scenario.id} не содержит ${metricId}`,
      );
    }
  }
  if (expectation.maximumAbsoluteCentralDelta !== undefined) {
    for (const effect of effects) {
      if (
        Math.abs(effect.relativeDelta.central) >
        expectation.maximumAbsoluteCentralDelta
      ) {
        throw new Error(
          `DIRECT_EXPECTATION_FAILED: ${scenario.id} завысил ${effect.metricId}`,
        );
      }
    }
  }
  if (expectation.forbidEstimatedWithoutEvidence) {
    const unsupported = effects.find(
      (effect) =>
        effect.evaluationStatus === "estimated" && effect.evidenceClass === "none",
    );
    if (unsupported) {
      throw new Error(
        `DIRECT_EXPECTATION_FAILED: ${scenario.id} оценил ${unsupported.metricId} без evidence`,
      );
    }
  }
  for (const [metricId, sign] of Object.entries(
    expectation.centralDeltaSign || {},
  )) {
    const delta = byMetric.get(metricId)?.relativeDelta?.central;
    const matches = sign === "positive" ? delta > 0 : delta < 0;
    if (!matches) {
      throw new Error(
        `DIRECT_EXPECTATION_FAILED: ${scenario.id} ${metricId} имеет неверный знак`,
      );
    }
  }
  if (
    expectation.requireMaterialRisk &&
    !(assessment.downsideRisks || []).some((risk) => risk.material)
  ) {
    throw new Error(
      `DIRECT_EXPECTATION_FAILED: ${scenario.id} потерял material downside`,
    );
  }
  const serialized = JSON.stringify(assessment);
  for (const fragment of expectation.forbiddenOutputFragments || []) {
    if (serialized.includes(fragment)) {
      throw new Error(
        `DIRECT_EXPECTATION_FAILED: ${scenario.id} повторил запрещённый fragment`,
      );
    }
  }
};

const assertUniqueItems = (values, path) => {
  if (new Set(values).size !== values.length) {
    throw new Error(`DIRECT_SEMANTIC_INVALID: ${path} содержит дубликаты`);
  }
};

export const assertAssessmentSemantics = (assessment) => {
  assertUniqueItems(assessment.includedTaskCodes, "includedTaskCodes");
  assertUniqueItems(assessment.excludedTaskCodes, "excludedTaskCodes");
  for (const [index, risk] of assessment.downsideRisks.entries()) {
    assertUniqueItems(
      risk.affectedMetricIds,
      `downsideRisks[${index}].affectedMetricIds`,
    );
  }
  for (const [index, effect] of assessment.effects.entries()) {
    assertUniqueItems(effect.evidenceIds, `effects[${index}].evidenceIds`);
    assertUniqueItems(effect.dependencies, `effects[${index}].dependencies`);
  }
};

export async function runDirectEvaluation(options) {
  const matrix = validateMatrix(await readJson(resolve(options.matrixPath)));
  const scenarios = options.caseId
    ? matrix.cases.filter((item) => item.id === options.caseId)
    : matrix.cases;
  if (options.caseId && scenarios.length !== 1) {
    throw new Error(`DIRECT_CASE_NOT_FOUND: ${options.caseId}`);
  }
  const assessmentSchema = await readJson(ASSESSMENT_SCHEMA);
  const validateAssessment = new Ajv({ allErrors: true, strict: true }).compile(
    assessmentSchema,
  );
  const promptTemplate = await readFile(PROMPT, "utf8");
  const evaluator = await loadEvaluator({ root: ROOT });
  const scoringConfig = await readJson(MODEL_CONFIG);
  const modelContext = buildModelContext({
    config: scoringConfig,
    evaluator,
  });
  const stateDirectory = resolve(options.stateDirectory);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const results = [];

  for (const scenario of scenarios) {
    const modelInput = { ...scenario.input, modelConfig: modelContext };
    const input = JSON.stringify(modelInput);
    if (!scenario.expect.modelCall || options.dryRun) {
      results.push({
        id: scenario.id,
        modelCalled: false,
        preflightExpected: scenario.preflightExpected,
        inputHash: sha256(input),
        schemaValid: null,
      });
      continue;
    }
    {
      const assessment = guardModelOutput(await callStructuredCodex({
        authPath: options.authPath,
        evaluator,
        prompt: promptTemplate,
        input: modelInput,
        schemaPath: ASSESSMENT_SCHEMA,
        webSearch: "disabled",
      }));
      if (!validateAssessment(assessment)) {
        throw new Error(
          `DIRECT_SCHEMA_INVALID: ${scenario.id}: ${JSON.stringify(validateAssessment.errors)}`,
        );
      }
      assertAssessmentSemantics(assessment);
      assertExpectations(scenario, assessment);
      const score = scoreAssessment({
        assessment,
        taskType: scenario.input.taskType,
        config: scoringConfig,
        evaluator,
        evidenceSources: scenario.input.evidence || [],
        expectedTaskCode: scenario.input.taskCode,
      });
      const scoreHash = sha256(JSON.stringify(score));
      results.push({
        id: scenario.id,
        modelCalled: true,
        inputHash: sha256(input),
        outputHash: sha256(JSON.stringify(assessment)),
        scoreHash,
        schemaValid: true,
        guardVerdict: "passed",
        status: assessment.status,
        scoreStatus: score.status,
        scoreValue: score.value,
      });
    }
  }

  const summary = {
    schemaVersion: 1,
    evaluator,
    matrixHash: sha256(JSON.stringify(matrix)),
    results,
  };
  await writeFile(
    join(stateDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { mode: 0o600 },
  );
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const summary = await runDirectEvaluation(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (error.stderr) process.stderr.write(error.stderr);
    process.exitCode = 1;
  }
}
