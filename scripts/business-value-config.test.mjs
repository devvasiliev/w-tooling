import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv from "ajv";

import {
  buildModelContext,
  evaluatorMatches,
  loadEvaluator,
} from "./business-value/evaluator.mjs";

const readJson = async (relativePath) =>
  JSON.parse(
    await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"),
  );

test("business value model v1 соответствует schema и согласованной шкале", async () => {
  const [schema, model] = await Promise.all([
    readJson("config/business-value-model.schema.json"),
    readJson("config/business-value-model.v1.json"),
  ]);
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  assert.equal(validate(model), true, JSON.stringify(validate.errors));

  const metricIds = model.metrics.map((metric) => metric.id);
  assert.equal(new Set(metricIds).size, metricIds.length);
  assert.equal(
    Number(model.metrics.reduce((total, metric) => total + metric.weight, 0).toFixed(6)),
    10,
  );
  assert.equal(
    Number(
      Object.values(model.conservativeScenarioWeights)
        .reduce((total, value) => total + value, 0)
        .toFixed(6),
    ),
    1,
  );
  assert.deepEqual(model.scoreRange, { minimum: -1000, maximum: 1000 });
});

test("reference baseline v1 использует уменьшенный operating scale", async () => {
  const model = await readJson("config/business-value-model.v1.json");
  const baseline = Object.fromEntries(
    model.metrics.map((metric) => [metric.id, metric.baseline]),
  );

  assert.deepEqual(
    {
      leads: baseline.leads_monthly,
      registrations: baseline.registrations_monthly,
      mau: baseline.mau,
      wau: baseline.wau,
      dau: baseline.dau,
      payingUsers: baseline.paying_users,
      revenue: baseline.gross_revenue_monthly,
      complaints: baseline.complaints_monthly,
      infrastructure: baseline.infrastructure_cost_monthly,
    },
    {
      leads: 400,
      registrations: 100,
      mau: 1000,
      wau: 450,
      dau: 120,
      payingUsers: 80,
      revenue: 120000,
      complaints: 30,
      infrastructure: 25000,
    },
  );
  assert.equal(
    baseline.registrations_monthly,
    baseline.leads_monthly * baseline.registration_conversion,
  );
  assert.equal(
    baseline.gross_revenue_monthly,
    baseline.paying_users * baseline.arppu,
  );
  assert.ok(baseline.dau <= baseline.wau);
  assert.ok(baseline.wau <= baseline.mau);
  assert.equal(baseline.target_audience, 500000);
});

test("business value machine contracts принимают только schema-bound данные", async () => {
  const schemaPaths = [
    "config/business-value-codex-envelope.schema.json",
    "config/business-value-research-brief.schema.json",
    "config/business-value-evidence.schema.json",
    "config/business-value-assessment.schema.json",
    "config/business-value-preview.schema.json",
  ];
  const ajv = new Ajv({ allErrors: true, strict: true });
  for (const schemaPath of schemaPaths) {
    const schema = await readJson(schemaPath);
    assert.equal(typeof ajv.compile(schema), "function");
  }

  const assessmentSchema = await readJson(
    "config/business-value-assessment.schema.json",
  );
  const validateAssessment = new Ajv({ allErrors: true, strict: true }).compile(
    assessmentSchema,
  );
  const valid = await readJson(
    "fixtures/business-value/schema/assessment-valid.json",
  );
  const modelOwnedScore = await readJson(
    "fixtures/business-value/schema/assessment-model-owned-score.json",
  );
  const unknownMetric = await readJson(
    "fixtures/business-value/schema/assessment-unknown-metric.json",
  );

  assert.equal(validateAssessment(valid), true, JSON.stringify(validateAssessment.errors));
  assert.equal(validateAssessment(modelOwnedScore), false);
  assert.ok(
    validateAssessment.errors.some(
      (error) =>
        error.keyword === "additionalProperties" &&
        error.params.additionalProperty === "score",
    ),
  );
  assert.equal(validateAssessment(unknownMetric), false);
  assert.ok(
    validateAssessment.errors.some(
      (error) => error.instancePath.endsWith("/metricId") && error.keyword === "enum",
    ),
  );

  const envelopeSchema = await readJson(
    "config/business-value-codex-envelope.schema.json",
  );
  const validateEnvelope = new Ajv({ allErrors: true, strict: true }).compile(
    envelopeSchema,
  );
  const evaluator = await loadEvaluator();
  const envelope = {
    evaluator,
    evaluatorDigest: evaluator.digest,
    result: valid,
  };
  assert.equal(validateEnvelope(envelope), true, JSON.stringify(validateEnvelope.errors));
  assert.equal(
    validateEnvelope({
      evaluator: { ...evaluator, tuple: { ...evaluator.tuple, modelId: "other" } },
      evaluatorDigest: evaluator.digest,
      result: valid,
    }),
    false,
  );
  assert.equal(
    validateEnvelope({ ...envelope, unexpected: true }),
    false,
  );
});

test("evaluator tuple фиксирует CLI, model, reasoning и hashes контрактов", async () => {
  const evaluator = await loadEvaluator();
  assert.equal(evaluator.tuple.codexCliVersion, "0.150.1");
  assert.equal(evaluator.tuple.modelId, "gpt-5.6-sol");
  assert.equal(evaluator.tuple.reasoningEffort, "high");
  assert.match(evaluator.digest, /^[0-9a-f]{64}$/u);
  assert.equal(
    evaluator.notionVersion,
    `${evaluator.tuple.evaluatorVersion}@${evaluator.digest}`,
  );
  assert.equal(Object.keys(evaluator.tuple.promptHashes).length, 3);
  assert.equal(Object.keys(evaluator.tuple.schemaHashes).length, 5);
  assert.equal(Object.keys(evaluator.tuple.configHashes).length, 1);
  assert.equal(evaluatorMatches(evaluator, structuredClone(evaluator)), true);
  assert.equal(
    evaluatorMatches(evaluator, {
      ...evaluator,
      digest: evaluator.digest.replace(/^./u, evaluator.digest[0] === "0" ? "1" : "0"),
    }),
    false,
  );
});

test("model получает hash-bound metric config без scorer weights и formula", async () => {
  const [evaluator, config] = await Promise.all([
    loadEvaluator(),
    readJson("config/business-value-model.v1.json"),
  ]);
  const context = buildModelContext({ config, evaluator });
  assert.equal(context.evaluatorDigest, evaluator.digest);
  assert.equal(context.metrics.length, config.metrics.length);
  const serialized = JSON.stringify(context);
  assert.doesNotMatch(serialized, /"weight"|taskTypeCaps|evidenceFactors|scoreRange/u);
  assert.equal(context.metrics.find((metric) => metric.id === "mau").baseline, 1000);
});
