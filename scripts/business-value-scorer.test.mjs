import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { scoreAssessment } from "./business-value/scorer.mjs";

const readJson = async (relativePath) =>
  JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));

const effect = (overrides = {}) => ({
  metricId: "infrastructure_cost_monthly",
  evaluationStatus: "estimated",
  effectKind: "direct",
  causalChainId: "cost-reduction",
  relativeDelta: { downside: -0.1, central: -0.2, upside: -0.3 },
  reach: 1,
  adoption: 1,
  durability: 1,
  evidenceClass: "internal_controlled",
  similarity: "direct",
  evidenceIds: ["evidence-1"],
  dependencies: [],
  materialUnknownDownside: false,
  rationale: "Production billing подтверждает устойчивое снижение затрат.",
  ...overrides,
});

const evidenceSource = (overrides = {}) => ({
  id: "evidence-1",
  metricId: "infrastructure_cost_monthly",
  class: "internal_controlled",
  ...overrides,
});

const assessment = (effects, overrides = {}) => ({
  schemaVersion: 1,
  status: "evaluated",
  summary: "Проверяемый синтетический эффект.",
  questions: [],
  effects,
  downsideRisks: [],
  assumptions: [],
  includedTaskCodes: ["W-900200"],
  excludedTaskCodes: [],
  ...overrides,
});

test("scorer детерминированно применяет task cap, direction и saturation", async () => {
  const config = await readJson("config/business-value-model.v1.json");
  const input = {
    assessment: assessment([effect()]),
    taskType: "Задача",
    config,
    evidenceSources: [evidenceSource()],
    expectedTaskCode: "W-900200",
  };
  const first = scoreAssessment(input);
  const second = scoreAssessment(input);
  assert.deepEqual(first, second);
  assert.equal(first.status, "EVALUATED");
  assert.equal(first.value, 28);
  assert.deepEqual(first.contributions[0].rawRange, {
    downside: -0.05,
    central: -0.05,
    upside: -0.05,
  });
});

test("неподтверждённый эффект остаётся неоценённым с техническим нулём", async () => {
  const config = await readJson("config/business-value-model.v1.json");
  const result = scoreAssessment({
    assessment: assessment([
      effect({
        metricId: "csi",
        evaluationStatus: "not_evaluated",
        causalChainId: "cosmetic",
        relativeDelta: { downside: 0, central: 0, upside: 0 },
        reach: 0,
        adoption: 0,
        durability: 0,
        evidenceClass: "none",
        similarity: "low",
        evidenceIds: [],
        rationale: "Нет сопоставимого evidence для косметического изменения.",
      }),
    ], { status: "partial" }),
    taskType: "Задача",
    config,
    expectedTaskCode: "W-900200",
  });
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.value, 0);
  assert.equal(result.contributions[0].includedInScore, false);
});

test("заявленный estimated без evidence принудительно становится неоценённым", async () => {
  const config = await readJson("config/business-value-model.v1.json");
  const result = scoreAssessment({
    assessment: assessment([
      effect({
        metricId: "mau",
        causalChainId: "unsupported-growth",
        relativeDelta: { downside: 0.02, central: 0.08, upside: 0.15 },
        evidenceClass: "single_comparable",
        evidenceIds: [],
      }),
    ]),
    taskType: "История",
    config,
    evidenceSources: [],
    expectedTaskCode: "W-900200",
  });
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.value, 0);
  assert.equal(result.contributions[0].evaluationStatus, "not_evaluated");
  assert.equal(result.contributions[0].evidenceFactor, 0);
  assert.equal(result.contributions[0].includedInScore, false);
  assert.deepEqual(result.contributions[0].rawRange, {
    downside: 0,
    central: 0,
    upside: 0,
  });
});

test("evidence другой метрики и завышенный внешний класс не повышают вклад", async () => {
  const config = await readJson("config/business-value-model.v1.json");
  const crossMetric = scoreAssessment({
    assessment: assessment([
      effect({
        metricId: "gross_revenue_monthly",
        causalChainId: "unsupported-revenue",
        relativeDelta: { downside: 0.03, central: 0.08, upside: 0.15 },
        evidenceClass: "controlled_comparable",
      }),
    ]),
    taskType: "История",
    config,
    evidenceSources: [evidenceSource({ metricId: "registration_dropoff" })],
    expectedTaskCode: "W-900200",
  });
  assert.equal(crossMetric.value, 0);
  assert.equal(crossMetric.status, "PARTIAL");
  assert.equal(crossMetric.contributions[0].evidenceClass, "none");

  const oneExternalSource = scoreAssessment({
    assessment: assessment([effect({ evidenceClass: "controlled_comparable" })]),
    taskType: "История",
    config,
    evidenceSources: [
      {
        id: "evidence-1",
        metricId: "infrastructure_cost_monthly",
        availabilityVerified: true,
      },
    ],
    expectedTaskCode: "W-900200",
  });
  assert.equal(oneExternalSource.contributions[0].evidenceClass, "single_indirect");
  assert.equal(oneExternalSource.contributions[0].similarity, "medium");
  assert.equal(oneExternalSource.contributions[0].evidenceFactor, 0.2);
});

test("причинная цепочка начисляет один прямой вклад", async () => {
  const config = await readJson("config/business-value-model.v1.json");
  const result = scoreAssessment({
    assessment: assessment([
      effect({ metricId: "registration_conversion", causalChainId: "signup" }),
      effect({
        metricId: "registrations_monthly",
        effectKind: "derived",
        causalChainId: "signup",
        dependencies: ["registration_conversion"],
      }),
    ]),
    taskType: "История",
    config,
    evidenceSources: [
      evidenceSource({ metricId: "registration_conversion" }),
    ],
    expectedTaskCode: "W-900200",
  });
  const direct = result.contributions.find(
    (item) => item.metricId === "registration_conversion",
  );
  const derived = result.contributions.find(
    (item) => item.metricId === "registrations_monthly",
  );
  assert.equal(direct.includedInScore, true);
  assert.equal(derived.includedInScore, false);
  assert.equal(derived.points, 0);
  assert.equal(derived.deduplicatedBy, "registration_conversion");
});

test("производный вклад дедуплицируется по dependency при другом causalChainId", async () => {
  const config = await readJson("config/business-value-model.v1.json");
  const result = scoreAssessment({
    assessment: assessment([
      effect({ metricId: "paying_users", causalChainId: "paid-conversion" }),
      effect({
        metricId: "gross_revenue_monthly",
        effectKind: "derived",
        causalChainId: "invented-revenue-chain",
        dependencies: ["paying_users"],
      }),
    ]),
    taskType: "История",
    config,
    evidenceSources: [evidenceSource({ metricId: "paying_users" })],
    expectedTaskCode: "W-900200",
  });
  const direct = result.contributions.find((item) => item.metricId === "paying_users");
  const derived = result.contributions.find(
    (item) => item.metricId === "gross_revenue_monthly",
  );
  assert.equal(direct.includedInScore, true);
  assert.equal(derived.includedInScore, false);
  assert.equal(derived.points, 0);
  assert.equal(derived.deduplicatedBy, "paying_users");
});

test("производный эффект без присутствующей причины и повтор метрики отклоняются", async () => {
  const config = await readJson("config/business-value-model.v1.json");
  assert.throws(
    () =>
      scoreAssessment({
        assessment: assessment([
          effect({
            metricId: "gross_revenue_monthly",
            effectKind: "derived",
            dependencies: ["paying_users"],
          }),
        ]),
        taskType: "История",
        config,
        evidenceSources: [
          evidenceSource({ metricId: "gross_revenue_monthly" }),
        ],
        expectedTaskCode: "W-900200",
      }),
    (error) => error.code === "ASSESSMENT_SEMANTIC_INVALID",
  );
  assert.throws(
    () =>
      scoreAssessment({
        assessment: assessment([effect(), effect()]),
        taskType: "История",
        config,
        evidenceSources: [evidenceSource()],
        expectedTaskCode: "W-900200",
      }),
    (error) => error.code === "ASSESSMENT_SEMANTIC_INVALID",
  );
});

test("материальный неизвестный downside блокирует число", async () => {
  const config = await readJson("config/business-value-model.v1.json");
  const result = scoreAssessment({
    assessment: assessment(
      [
        effect({
          evaluationStatus: "not_evaluated",
          relativeDelta: { downside: 0, central: 0, upside: 0 },
          reach: 0,
          adoption: 0,
          durability: 0,
          evidenceClass: "none",
          evidenceIds: [],
          materialUnknownDownside: true,
        }),
      ],
      {
        status: "blocked",
        downsideRisks: [
          {
            description: "Неизвестная стоимость миграции может изменить знак.",
            material: true,
            quantifiable: false,
            affectedMetricIds: ["infrastructure_cost_monthly"],
          },
        ],
      },
    ),
    taskType: "Эпик",
    config,
    expectedTaskCode: "W-900200",
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.value, null);
});

test("семантические ссылки и proven_zero проверяются fail-closed", async () => {
  const config = await readJson("config/business-value-model.v1.json");
  assert.throws(
    () =>
      scoreAssessment({
        assessment: assessment([effect()]),
        taskType: "Задача",
        config,
        evidenceSources: [],
        expectedTaskCode: "W-900200",
      }),
    (error) => error.code === "UNKNOWN_EVIDENCE",
  );
  assert.throws(
    () =>
      scoreAssessment({
        assessment: assessment([
          effect({
            evaluationStatus: "proven_zero",
            relativeDelta: { downside: 0, central: 0, upside: 0 },
            evidenceClass: "none",
            evidenceIds: [],
          }),
        ]),
        taskType: "Задача",
        config,
        expectedTaskCode: "W-900200",
      }),
    (error) => error.code === "ASSESSMENT_SEMANTIC_INVALID",
  );
});
