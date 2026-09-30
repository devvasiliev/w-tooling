const MANAGED_MARKER = "<!-- task-business-value:managed:v1 -->";

const formatNumber = (value) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value);

const formatPercent = (value) => {
  const formatted = formatNumber(Math.abs(value * 100));
  if (value > 0) return `+${formatted}%`;
  if (value < 0) return `−${formatted}%`;
  return "0%";
};

const statusLabel = (score) => score.statusLabel;

const impactLine = (contribution) => {
  if (contribution.evaluationStatus === "not_evaluated") {
    return `- **${contribution.label}: Не оценено.** ${contribution.rationale}`;
  }
  if (contribution.evaluationStatus === "proven_zero") {
    return `- **${contribution.label}: доказанный нулевой эффект.** ${contribution.rationale}`;
  }
  const range = ["downside", "central", "upside"]
    .map(
      (name) =>
        `${formatPercent(contribution.rawRange[name])} ` +
        `(${formatNumber(contribution.baseline)} → ${formatNumber(contribution.newValues[name])})`,
    )
    .join(" / ");
  const points = contribution.includedInScore
    ? `${contribution.points >= 0 ? "+" : ""}${formatNumber(contribution.points)} п.`
    : `0 п., производный дубль ${contribution.deduplicatedBy}`;
  return `- **${contribution.label}:** ${range}; вклад ${points}. ${contribution.rationale}`;
};

const list = (items, emptyText) =>
  items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : `- ${emptyText}`;

const hashList = (hashes = {}) =>
  Object.entries(hashes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, digest]) => `${path}=${digest}`)
    .join("; ") || "не зафиксированы";

export function renderManagedSection({ score, evidence = [], warnings = [] }) {
  const value = score.value === null
    ? "не публикуется"
    : `${score.value >= 0 ? "+" : ""}${score.value}`;
  const sources = evidence
    .filter((item) => item?.url)
    .map((item) => `[${item.title || item.id}](${item.url})`);
  const risks = score.downsideRisks.map(
    (risk) =>
      `${risk.material ? "Материальный" : "Нематериальный"} риск: ${risk.description}`,
  );
  return `## Бизнес-эффект
${MANAGED_MARKER}

> Симуляционная оценка для приоритизации. Это не прогноз фактических пользователей, выручки или затрат.

- **Business Value:** ${value}
- **Статус:** ${statusLabel(score)}
- **Уверенность:** ${formatPercent(score.confidence)}
- **Версия модели:** ${score.modelVersion}
- **Evaluator:** ${score.evaluator?.evaluatorVersion || "не зафиксирован"}; scorer ${score.evaluator?.scorerVersion || "не зафиксирован"}
- **Codex:** ${score.evaluator?.modelId || "не зафиксирован"}, reasoning ${score.evaluator?.reasoningEffort || "не зафиксирован"}, CLI ${score.evaluator?.codexCliVersion || "не зафиксирован"}
- **Evaluator digest:** ${score.evaluatorDigest || "не зафиксирован"}
- **Baseline:** ${score.baselineVersion}
- **Prompt hashes:** ${hashList(score.evaluator?.promptHashes)}
- **Schema hashes:** ${hashList(score.evaluator?.schemaHashes)}
- **Config hashes:** ${hashList(score.evaluator?.configHashes)}
- **Ограничение alias:** model id фиксирован, но скрытая server-side revision может измениться; новая evaluator tuple требует повторной backward matrix.

### Потенциальное влияние

${score.contributions.map(impactLine).join("\n") || "- Релевантные эффекты не определены."}

### Evidence

${list(sources, "Внешние или внутренние источники не приложены.")}

### Допущения

${list(score.assumptions, "Допущения не указаны.")}

### Неизвестные параметры и вопросы

${list(score.questions, "Независимых неизвестных параметров не осталось.")}

### Downside и предупреждения

${list([...risks, ...warnings], "Материальные риски не обнаружены.")}

### Область оценки

- Включено: ${score.includedTaskCodes.join(", ")}
- Исключено из суммы: ${score.excludedTaskCodes.join(", ") || "ничего"}`;
}

const previousField = (previousFields, property) =>
  Object.hasOwn(previousFields, property) ? previousFields[property] : null;

export function buildPreview({
  runId,
  taskCode,
  taskType,
  sourceFingerprint,
  score,
  previous = {},
  evidence = [],
  warnings = [],
  expiresAt,
  calculatedAt,
}) {
  const previousState = {
    value: previous.value ?? null,
    status: previous.status || "Не оценено",
    confidence: previous.confidence ?? null,
  };
  const proposedState = {
    value: score.value,
    status: score.statusLabel,
    confidence: score.confidence,
  };
  const newFields = {
    "BV значение": score.value,
    "BV уверенность": score.confidence,
    "BV результат": score.statusLabel,
    "BV версия модели": score.modelVersion,
    "BV baseline": score.baselineVersion,
    "BV fingerprint": sourceFingerprint,
    "BV рассчитан": calculatedAt,
  };
  const previousFields = previous.fields || {};
  const fieldChanges = Object.entries(newFields).map(([property, newValue]) => ({
    property,
    previousValue: previousField(previousFields, property),
    newValue,
  }));
  return {
    schemaVersion: 1,
    runId,
    taskCode,
    taskType,
    sourceFingerprint,
    modelVersion: score.modelVersion,
    baselineVersion: score.baselineVersion,
    evaluator: score.evaluator,
    evaluatorDigest: score.evaluatorDigest,
    expiresAt,
    previous: previousState,
    proposed: proposedState,
    fieldChanges,
    managedSectionMarkdown: renderManagedSection({ score, evidence, warnings }),
    sourceUrls: [...new Set(evidence.map((item) => item?.url).filter(Boolean))],
    warnings,
  };
}

export { MANAGED_MARKER };
