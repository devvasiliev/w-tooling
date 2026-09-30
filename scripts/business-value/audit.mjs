import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { fail } from "./errors.mjs";

const SENSITIVE = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/giu,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{12,}\b/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/giu,
  /\b(?:api[_ -]?key|secret|token|password)\s*[:=]\s*[^\s,;]{8,}/giu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /(?<!\d)(?:\+?7|8)[\s()-]*\d{3}[\s()-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/gu,
];
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const redactText = (value, knownSecrets) => {
  let result = String(value);
  for (const secret of knownSecrets.filter(Boolean)) result = result.split(secret).join("[REDACTED]");
  for (const pattern of SENSITIVE) result = result.replace(pattern, "[REDACTED]");
  return result;
};

const redactValue = (value, knownSecrets) => {
  if (typeof value === "string") return redactText(value, knownSecrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, knownSecrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, knownSecrets)]),
    );
  }
  return value;
};

const normalizedTokens = (value) =>
  String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

const ngrams = (value, size = 6) => {
  const tokens = normalizedTokens(value);
  const result = new Set();
  for (let index = 0; index <= tokens.length - size; index += 1) {
    result.add(tokens.slice(index, index + size).join(" "));
  }
  return result;
};

const assertExternalSafe = (event, { confidentialText = "", productAliases = [] }) => {
  const serialized = JSON.stringify(event);
  if (/\b[A-Z][A-Z0-9]*-[1-9][0-9]*\b/iu.test(serialized)) {
    fail("EXTERNAL_AUDIT_PRIVACY_BLOCKED", "External audit содержит код задачи");
  }
  if (
    productAliases.some(
      (alias) => alias && serialized.toLocaleLowerCase("ru-RU").includes(alias.toLocaleLowerCase("ru-RU")),
    )
  ) {
    fail("EXTERNAL_AUDIT_PRIVACY_BLOCKED", "External audit содержит название продукта");
  }
  const privateFragments = ngrams(confidentialText);
  if ([...ngrams(serialized)].some((fragment) => privateFragments.has(fragment))) {
    fail("EXTERNAL_AUDIT_PRIVACY_BLOCKED", "External audit повторяет закрытый фрагмент");
  }
};

export class AuditLog {
  constructor(directory, { knownSecrets = [] } = {}) {
    this.directory = resolve(directory);
    this.knownSecrets = knownSecrets;
  }

  async append(name, event) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await appendFile(join(this.directory, name), `${JSON.stringify(event)}\n`, {
      mode: 0o600,
    });
    return event;
  }

  async internal(event) {
    return this.append("internal.jsonl", redactValue(event, this.knownSecrets));
  }

  async stage(event) {
    const required = [
      "schemaVersion",
      "timestamp",
      "runId",
      "actor",
      "stage",
      "status",
      "reasonCode",
      "durationMs",
      "evaluatorDigest",
      "evaluator",
    ];
    if (
      event?.schemaVersion !== 1 ||
      !RUN_ID.test(event?.runId || "") ||
      required.some((key) => event?.[key] === undefined) ||
      !Number.isFinite(event.durationMs) ||
      event.durationMs < 0
    ) {
      fail("AUDIT_STAGE_INVALID", "Stage audit event не соответствует контракту");
    }
    return this.internal(event);
  }

  async readInternal(runId) {
    if (!RUN_ID.test(runId || "")) fail("INVALID_RUN_ID", "Некорректный run id");
    let raw;
    try {
      raw = await readFile(join(this.directory, "internal.jsonl"), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const events = [];
    for (const line of raw.split("\n").filter(Boolean)) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        fail("AUDIT_LOG_INVALID", "Internal audit log повреждён");
      }
      if (event.runId === runId) events.push(event);
    }
    return events;
  }

  async external(event, privacy = {}) {
    const redacted = redactValue(event, this.knownSecrets);
    assertExternalSafe(redacted, privacy);
    return this.append("external-search.jsonl", redacted);
  }
}

export const humanRunSummary = ({
  stage,
  expected,
  actual,
  currentState,
  rollback,
  impact,
  nextStep,
  detailsPath,
  reasonCode,
}) =>
  [
    `Этап: ${stage}.`,
    `Ожидалось: ${expected}.`,
    `Фактически: ${actual}.`,
    `Текущее состояние: ${currentState}.`,
    `Rollback: ${rollback}.`,
    `Влияние: ${impact}.`,
    `Причина: ${reasonCode}.`,
    `Следующий шаг: ${nextStep}.`,
    `Детали: ${detailsPath}.`,
  ].join("\n");
