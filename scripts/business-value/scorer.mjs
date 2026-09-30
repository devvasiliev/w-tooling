import { fail } from "./errors.mjs";

const STRONG_EVIDENCE = new Set([
  "single_comparable",
  "multiple_comparable",
  "controlled_comparable",
  "internal_controlled",
]);
const SIMILARITY_ORDER = ["low", "medium", "high", "direct"];

const round = (value, digits = 6) => Number(value.toFixed(digits));
const clamp = (value, minimum, maximum) =>
  Math.max(minimum, Math.min(maximum, value));

const evidenceIndex = (sources = []) => {
  const result = new Map();
  for (const source of sources) {
    if (!source?.id || result.has(source.id)) {
      fail("EVIDENCE_SOURCE_INVALID", "Evidence source id отсутствует или повторяется");
    }
    result.set(source.id, source);
  }
  return result;
};

const weakerEvidenceClass = (left, right, factors) =>
  factors[left] <= factors[right] ? left : right;

const evidenceContract = ({ effect, sourceMap, config }) => {
  const boundSources = effect.evidenceIds.map((id) => {
    const source = sourceMap.get(id);
    if (!source) {
      fail("UNKNOWN_EVIDENCE", "Assessment ссылается на отсутствующий evidence", {
        metricId: effect.metricId,
      });
    }
    return source;
  });
  const compatible =
    boundSources.length > 0 &&
    boundSources.every(
      (source) =>
        source.metricId === effect.metricId &&
        (source.class || source.availabilityVerified === true),
    );
  if (!compatible || effect.evidenceClass === "none") {
    return {
      evidenceClass: "none",
      similarity: "low",
      boundSources,
      compatible,
    };
  }
  const declaredClasses = boundSources.map((source) => source.class).filter(Boolean);
  if (
    declaredClasses.some((value) => config.evidenceFactors[value] === undefined)
  ) {
    fail("EVIDENCE_SOURCE_INVALID", "Evidence source содержит неизвестный класс");
  }
  const deterministicCeiling = declaredClasses.length === boundSources.length
    ? declaredClasses.reduce((current, value) =>
        weakerEvidenceClass(current, value, config.evidenceFactors))
    : boundSources.length > 1
      ? "multiple_indirect"
      : "single_indirect";
  if (
    config.evidenceFactors[deterministicCeiling] === undefined ||
    config.evidenceFactors[effect.evidenceClass] === undefined
  ) {
    fail("EVIDENCE_SOURCE_INVALID", "Evidence source содержит неизвестный класс");
  }
  const evidenceClass = weakerEvidenceClass(
    effect.evidenceClass,
    deterministicCeiling,
    config.evidenceFactors,
  );
  const externalOnly = declaredClasses.length !== boundSources.length;
  const maximumSimilarity = externalOnly ? "medium" : "direct";
  const similarity = SIMILARITY_ORDER.indexOf(effect.similarity) <=
      SIMILARITY_ORDER.indexOf(maximumSimilarity)
    ? effect.similarity
    : maximumSimilarity;
  return { evidenceClass, similarity, boundSources, compatible };
};

const assertZeroRange = (effect) => {
  const values = Object.values(effect.relativeDelta);
  if (values.some((value) => value !== 0)) {
    fail(
      "ASSESSMENT_SEMANTIC_INVALID",
      `${effect.evaluationStatus} требует нулевой технический диапазон`,
      { metricId: effect.metricId },
    );
  }
};

const russianStatus = {
  EVALUATED: "Оценено",
  PARTIAL: "Частично оценено",
  NEEDS_INPUT: "Нужны данные",
  BLOCKED: "Нужны данные",
};

const resultStatus = (assessment, hasUnknown, materialBlocked) => {
  if (materialBlocked || assessment.status === "blocked") return "BLOCKED";
  if (assessment.status === "needs_input") return "NEEDS_INPUT";
  if (assessment.status === "partial" || hasUnknown) return "PARTIAL";
  return "EVALUATED";
};

export function scoreAssessment({
  assessment,
  taskType,
  config,
  evaluator,
  evidenceSources = [],
  expectedTaskCode,
}) {
  const taskCaps = config.taskTypeCaps?.[taskType];
  if (!taskCaps) {
    fail("UNSUPPORTED_TASK_TYPE", `Для типа «${taskType}» нет caps`);
  }
  if (
    expectedTaskCode &&
    (assessment.includedTaskCodes.length !== 1 ||
      assessment.includedTaskCodes[0] !== expectedTaskCode)
  ) {
    fail("ASSESSMENT_SCOPE_MISMATCH", "Model output изменил область оценки");
  }

  const metricOrder = new Map(
    config.metrics.map((metric, index) => [metric.id, index]),
  );
  const metrics = new Map(config.metrics.map((metric) => [metric.id, metric]));
  const sourceMap = evidenceIndex(evidenceSources);
  const effectMetricIds = new Set();
  for (const effect of assessment.effects) {
    if (effectMetricIds.has(effect.metricId)) {
      fail("ASSESSMENT_SEMANTIC_INVALID", "Метрика повторяется в assessment", {
        metricId: effect.metricId,
      });
    }
    effectMetricIds.add(effect.metricId);
  }
  const contributions = assessment.effects.map((effect) => {
    const metric = metrics.get(effect.metricId);
    if (!metric) {
      fail("UNKNOWN_METRIC", `Неизвестная метрика ${effect.metricId}`);
    }
    if (effect.evaluationStatus !== "estimated") assertZeroRange(effect);
    if (
      effect.evaluationStatus === "proven_zero" &&
      (effect.evidenceClass === "none" || effect.evidenceIds.length === 0)
    ) {
      fail(
        "ASSESSMENT_SEMANTIC_INVALID",
        "proven_zero требует прямого evidence",
        { metricId: effect.metricId },
      );
    }
    if (
      effect.effectKind === "derived" &&
      (
        effect.dependencies.length === 0 ||
        !effect.dependencies.some((metricId) => effectMetricIds.has(metricId))
      )
    ) {
      fail(
        "ASSESSMENT_SEMANTIC_INVALID",
        "Производный эффект требует присутствующую в assessment причинную метрику",
        { metricId: effect.metricId },
      );
    }
    const deterministicEvidence = evidenceContract({ effect, sourceMap, config });
    if (
      effect.evaluationStatus === "proven_zero" &&
      deterministicEvidence.evidenceClass === "none"
    ) {
      fail(
        "ASSESSMENT_SEMANTIC_INVALID",
        "proven_zero требует evidence той же метрики",
        { metricId: effect.metricId },
      );
    }
    const evidenceBacked = deterministicEvidence.evidenceClass !== "none";
    const evaluationStatus =
      effect.evaluationStatus === "estimated" && !evidenceBacked
        ? "not_evaluated"
        : effect.evaluationStatus;
    const configuredEvidenceFactor = config.evidenceFactors[deterministicEvidence.evidenceClass];
    const similarityFactor = config.similarityFactors[deterministicEvidence.similarity];
    if (configuredEvidenceFactor === undefined || similarityFactor === undefined) {
      fail("ASSESSMENT_SEMANTIC_INVALID", "Неизвестный evidence/similarity factor");
    }
    const evidenceFactor = evaluationStatus === "not_evaluated"
      ? 0
      : configuredEvidenceFactor;
    const capClass = STRONG_EVIDENCE.has(deterministicEvidence.evidenceClass)
      ? "strongEvidence"
      : "weakEvidence";
    const rawCap = Math.min(
      taskCaps[capClass],
      metric.maximumRelativeEffect,
    );
    const effectiveRange = evaluationStatus === "estimated"
      ? effect.relativeDelta
      : { downside: 0, central: 0, upside: 0 };
    const rawRange = Object.fromEntries(
      Object.entries(effectiveRange).map(([name, value]) => [
        name,
        round(clamp(value, -rawCap, rawCap)),
      ]),
    );
    const multiplier =
      effect.reach *
      effect.adoption *
      effect.durability *
      evidenceFactor *
      similarityFactor;
    const utilities = Object.values(rawRange)
      .map((delta) => (metric.direction === "increase" ? delta : -delta) * multiplier)
      .sort((left, right) => left - right);
    const [downsideUtility, centralUtility, upsideUtility] = utilities;
    const conservativeUtility =
      downsideUtility * config.conservativeScenarioWeights.downside +
      centralUtility * config.conservativeScenarioWeights.central +
      upsideUtility * config.conservativeScenarioWeights.upside;
    const points =
      evaluationStatus === "estimated"
        ? metric.weight *
          100 *
          Math.tanh(conservativeUtility / metric.materialityThreshold)
        : 0;
    return {
      metricId: metric.id,
      label: metric.label,
      unit: metric.unit,
      baseline: metric.baseline,
      evaluationStatus,
      effectKind: effect.effectKind,
      causalChainId: effect.causalChainId,
      causalGroup: metric.causalGroup,
      dependencies: effect.dependencies,
      rawRange,
      newValues: Object.fromEntries(
        Object.entries(rawRange).map(([name, delta]) => [
          name,
          round(metric.baseline * (1 + delta)),
        ]),
      ),
      reach: effect.reach,
      adoption: effect.adoption,
      durability: effect.durability,
      evidenceClass: deterministicEvidence.evidenceClass,
      evidenceFactor,
      similarity: deterministicEvidence.similarity,
      similarityFactor,
      conservativeUtility: round(conservativeUtility),
      unroundedPoints: round(points),
      points: round(points),
      includedInScore: evaluationStatus === "estimated",
      deduplicatedBy: null,
      materialUnknownDownside: effect.materialUnknownDownside,
      rationale: evaluationStatus !== effect.evaluationStatus
        ? `Эффект не подтверждён evidence; числовой вклад исключён. ${effect.rationale}`
        : effect.rationale,
    };
  });

  for (const contribution of contributions) {
    if (contribution.effectKind !== "derived") continue;
    const dependency = contributions
      .filter((candidate) => contribution.dependencies.includes(candidate.metricId))
      .sort((left, right) => {
        if (left.effectKind !== right.effectKind) {
          return left.effectKind === "direct" ? -1 : 1;
        }
        if (left.causalGroup !== right.causalGroup) {
          return left.causalGroup === contribution.causalGroup ? -1 : 1;
        }
        return metricOrder.get(left.metricId) - metricOrder.get(right.metricId);
      })[0];
    contribution.includedInScore = false;
    contribution.deduplicatedBy = dependency.metricId;
    contribution.points = 0;
  }

  const chains = new Map();
  for (const contribution of contributions) {
    if (!contribution.includedInScore) continue;
    const group = chains.get(contribution.causalChainId) || [];
    group.push(contribution);
    chains.set(contribution.causalChainId, group);
  }
  for (const group of chains.values()) {
    if (group.length < 2) continue;
    const canonical = [...group].sort((left, right) => {
      if (left.effectKind !== right.effectKind) {
        return left.effectKind === "direct" ? -1 : 1;
      }
      const byMagnitude = Math.abs(right.points) - Math.abs(left.points);
      return byMagnitude || metricOrder.get(left.metricId) - metricOrder.get(right.metricId);
    })[0];
    for (const contribution of group) {
      if (contribution === canonical) continue;
      contribution.includedInScore = false;
      contribution.deduplicatedBy = canonical.metricId;
      contribution.points = 0;
    }
  }

  const materialBlocked =
    assessment.downsideRisks.some((risk) => risk.material && !risk.quantifiable) ||
    assessment.effects.some((effect) => effect.materialUnknownDownside);
  const hasUnknown = contributions.some(
    (contribution) => contribution.evaluationStatus === "not_evaluated",
  );
  const status = resultStatus(assessment, hasUnknown, materialBlocked);
  const totalWeight = contributions.reduce(
    (total, item) => total + metrics.get(item.metricId).weight,
    0,
  );
  const qualityWeight = contributions.reduce(
    (total, item) =>
      total +
      metrics.get(item.metricId).weight * item.evidenceFactor * item.similarityFactor,
    0,
  );
  let confidence = totalWeight === 0 ? 0 : qualityWeight / totalWeight;
  if (status !== "EVALUATED") {
    confidence = Math.min(confidence, config.partialConfidenceCap);
  }
  const rawValue = contributions
    .filter((item) => item.includedInScore)
    .reduce((total, item) => total + item.points, 0);
  const value = ["BLOCKED", "NEEDS_INPUT"].includes(status)
    ? null
    : Math.round(
        clamp(rawValue, config.scoreRange.minimum, config.scoreRange.maximum),
      );

  return {
    schemaVersion: 1,
    modelVersion: evaluator?.notionVersion || config.modelVersion,
    baselineVersion: config.baselineVersion,
    evaluator: evaluator?.tuple || null,
    evaluatorDigest: evaluator?.digest || null,
    taskType,
    status,
    statusLabel: russianStatus[status],
    value,
    confidence: round(confidence),
    contributions,
    questions: assessment.questions,
    assumptions: assessment.assumptions,
    downsideRisks: assessment.downsideRisks,
    includedTaskCodes: assessment.includedTaskCodes,
    excludedTaskCodes: assessment.excludedTaskCodes,
  };
}
