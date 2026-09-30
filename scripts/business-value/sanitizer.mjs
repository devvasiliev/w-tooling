import { fail } from "./errors.mjs";

const TASK_CODE_PATTERN = /\b[A-Z][A-Z0-9]*-[1-9][0-9]*\b/giu;
const URL_PATTERN = /\bhttps?:\/\/[^\s)\]}]+/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE_PATTERN = /(?<!\d)(?:\+?7|8)[\s()-]*\d{3}[\s()-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/gu;
const SECRET_PATTERN = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b|\b(?:api[_ -]?key|secret|token|password)\s*[:=]\s*[^\s,;]{8,}/giu;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const normalizeText = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const ngrams = (value, size = 6) => {
  const tokens = normalizeText(value).split(/\s+/u).filter(Boolean);
  const result = new Set();
  for (let index = 0; index <= tokens.length - size; index += 1) {
    result.add(tokens.slice(index, index + size).join(" "));
  }
  return result;
};

const sanitizeString = (value, productAliases) => {
  let result = String(value ?? "");
  for (const alias of productAliases.filter((item) => item.length >= 2)) {
    result = result.replace(new RegExp(escapeRegExp(alias), "giu"), "product");
  }
  return result
    .replace(TASK_CODE_PATTERN, "internal-task")
    .replace(URL_PATTERN, "")
    .replace(EMAIL_PATTERN, "")
    .replace(PHONE_PATTERN, "")
    .replace(SECRET_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim();
};

const assertSafeString = (value) => {
  for (const detector of [TASK_CODE_PATTERN, URL_PATTERN, EMAIL_PATTERN, PHONE_PATTERN, SECRET_PATTERN]) {
    detector.lastIndex = 0;
    if (detector.test(value)) {
      fail("EXTERNAL_SEARCH_PRIVACY_BLOCKED", "Внешний payload содержит запрещённые данные");
    }
  }
};

export function sanitizeResearchBrief(
  brief,
  { confidentialText = "", productAliases = [] } = {},
) {
  const aliases = productAliases.map((item) => String(item).trim()).filter(Boolean);
  const sanitize = (value) => sanitizeString(value, aliases);
  const payload = {
    schemaVersion: 1,
    changeCategory: brief.changeCategory,
    generalizedProblem: sanitize(brief.generalizedProblem),
    audienceCategory: sanitize(brief.audienceCategory),
    metricIds: [...new Set(brief.metricIds || [])],
    queries: (brief.queries || []).map((query) => ({
      id: query.id,
      problemClass: sanitize(query.problemClass),
      audienceCategory: sanitize(query.audienceCategory),
      metricIds: [...new Set(query.metricIds || [])],
      keywords: [...new Set((query.keywords || []).map(sanitize).filter(Boolean))],
    })),
  };
  const strings = [
    payload.generalizedProblem,
    payload.audienceCategory,
    ...payload.queries.flatMap((query) => [
      query.problemClass,
      query.audienceCategory,
      ...query.keywords,
    ]),
  ];
  if (payload.generalizedProblem.length < 10 || payload.audienceCategory.length < 3) {
    fail("EXTERNAL_SEARCH_PRIVACY_BLOCKED", "После обезличивания запрос потерял смысл");
  }
  strings.forEach(assertSafeString);

  const privateNgrams = ngrams(confidentialText);
  const leaking = strings.some((value) =>
    [...ngrams(value)].some((fragment) => privateNgrams.has(fragment)),
  );
  if (leaking) {
    fail(
      "EXTERNAL_SEARCH_PRIVACY_BLOCKED",
      "Внешний payload повторяет длинный закрытый фрагмент",
    );
  }
  return payload;
}
