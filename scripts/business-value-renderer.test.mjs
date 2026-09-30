import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv from "ajv";

import { buildPreview } from "./business-value/renderer.mjs";
import { loadEvaluator } from "./business-value/evaluator.mjs";
import { scoreAssessment } from "./business-value/scorer.mjs";

const readJson = async (relativePath) =>
  JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));

test("русский preview различает диапазон, unknown, proven zero и downside", async () => {
  const [config, previewSchema, evaluator] = await Promise.all([
    readJson("config/business-value-model.v1.json"),
    readJson("config/business-value-preview.schema.json"),
    loadEvaluator(),
  ]);
  const assessment = {
    schemaVersion: 1,
    status: "partial",
    summary: "Часть эффектов подтверждена.",
    questions: ["Каков охват жалоб?"],
    effects: [
      {
        metricId: "infrastructure_cost_monthly",
        evaluationStatus: "estimated",
        effectKind: "direct",
        causalChainId: "cost",
        relativeDelta: { downside: -0.02, central: -0.04, upside: -0.06 },
        reach: 1,
        adoption: 1,
        durability: 1,
        evidenceClass: "internal_controlled",
        similarity: "direct",
        evidenceIds: ["evidence-1"],
        dependencies: [],
        materialUnknownDownside: false,
        rationale: "Billing export подтверждает снижение переменной части затрат.",
      },
      {
        metricId: "complaints_monthly",
        evaluationStatus: "not_evaluated",
        effectKind: "direct",
        causalChainId: "quality",
        relativeDelta: { downside: 0, central: 0, upside: 0 },
        reach: 0,
        adoption: 0,
        durability: 0,
        evidenceClass: "none",
        similarity: "low",
        evidenceIds: [],
        dependencies: [],
        materialUnknownDownside: false,
        rationale: "Охват жалоб неизвестен.",
      },
      {
        metricId: "csi",
        evaluationStatus: "proven_zero",
        effectKind: "direct",
        causalChainId: "satisfaction",
        relativeDelta: { downside: 0, central: 0, upside: 0 },
        reach: 1,
        adoption: 1,
        durability: 1,
        evidenceClass: "internal_controlled",
        similarity: "direct",
        evidenceIds: ["evidence-2"],
        dependencies: [],
        materialUnknownDownside: false,
        rationale: "Контрольная выборка не показала изменения CSI.",
      },
    ],
    downsideRisks: [
      {
        description: "Экономия зависит от тарифа провайдера.",
        material: false,
        quantifiable: false,
        affectedMetricIds: ["infrastructure_cost_monthly"],
      },
    ],
    assumptions: ["Billing export репрезентативен для месяца."],
    includedTaskCodes: ["W-900300"],
    excludedTaskCodes: ["W-900301"],
  };
  const score = scoreAssessment({
    assessment,
    taskType: "История",
    config,
    evaluator,
    evidenceSources: [
      {
        id: "evidence-1",
        metricId: "infrastructure_cost_monthly",
        class: "internal_controlled",
      },
      { id: "evidence-2", metricId: "csi", class: "internal_controlled" },
    ],
    expectedTaskCode: "W-900300",
  });
  const preview = buildPreview({
    runId: "123e4567-e89b-42d3-a456-426614174000",
    taskCode: "W-900300",
    taskType: "История",
    sourceFingerprint: "a".repeat(64),
    score,
    previous: {
      value: 11,
      status: "Устарело",
      confidence: 0.2,
      fields: { "BV значение": 11 },
    },
    evidence: [
      { id: "evidence-1", title: "Billing experiment", url: "https://example.com/billing" },
    ],
    warnings: ["Reference baseline не является прогнозом."],
    expiresAt: "2026-09-01T12:30:00.000Z",
    calculatedAt: "2026-09-01T12:00:00.000Z",
  });
  const validate = new Ajv({ allErrors: true, strict: true }).compile(previewSchema);
  assert.equal(validate(preview), true, JSON.stringify(validate.errors));
  assert.match(preview.managedSectionMarkdown, /## Бизнес-эффект/);
  assert.match(preview.managedSectionMarkdown, /−2% \(25 000 → 24 500\)/u);
  assert.match(preview.managedSectionMarkdown, /Жалобы.*Не оценено/su);
  assert.match(preview.managedSectionMarkdown, /CSI: доказанный нулевой эффект/u);
  assert.match(preview.managedSectionMarkdown, /Нематериальный риск/u);
  assert.match(preview.managedSectionMarkdown, /Включено: W-900300/u);
  assert.match(preview.managedSectionMarkdown, /Evaluator:.*BV-EVALUATOR-1.*BV-SCORER-2/u);
  assert.match(preview.managedSectionMarkdown, /business-value-production-assessment\.md=[0-9a-f]{64}/u);
  assert.match(preview.managedSectionMarkdown, /business-value-assessment\.schema\.json=[0-9a-f]{64}/u);
  assert.match(preview.managedSectionMarkdown, /server-side revision/u);
  assert.equal(preview.previous.value, 11);
  assert.equal(preview.fieldChanges.length, 7);
});
