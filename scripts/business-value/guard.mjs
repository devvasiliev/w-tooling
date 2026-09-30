import { createHash } from "node:crypto";

import { fail } from "./errors.mjs";

const DETECTORS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/gu,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/giu,
  /\b(?:api[_ -]?key|secret|token|password)\s*[:=]\s*[^\s,;]{8,}/giu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /(?<!\d)(?:\+?7|8)[\s()-]*\d{3}[\s()-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/gu,
];

const collectStrings = (value, result = []) => {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, result));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectStrings(item, result));
  }
  return result;
};

const tokenHashes = (text) =>
  String(text)
    .split(/\s+/u)
    .filter((token) => token.length >= 8)
    .map((token) => createHash("sha256").update(token).digest("hex"));

export function guardModelOutput(output, { knownSecretHashes = [] } = {}) {
  const known = new Set(knownSecretHashes);
  for (const text of collectStrings(output)) {
    if (DETECTORS.some((detector) => {
      detector.lastIndex = 0;
      return detector.test(text);
    })) {
      fail(
        "MODEL_OUTPUT_SECRET_DETECTED",
        "Model output содержит закрытые или персональные данные",
      );
    }
    if (tokenHashes(text).some((hash) => known.has(hash))) {
      fail(
        "MODEL_OUTPUT_SECRET_DETECTED",
        "Model output совпал с известным credential fingerprint",
      );
    }
  }
  return output;
}

export const secretFingerprint = (secret) =>
  createHash("sha256").update(String(secret)).digest("hex");
