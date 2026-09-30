import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { BusinessValueError } from "./errors.mjs";

export const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const MODEL_CAPABILITY_TTL_MS = 120_000;
export const MODEL_CAPABILITY_MAX_TTL_MS = 180_000;

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
};

export const canonicalRequestJson = (value) => JSON.stringify(stableValue(value));

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const capabilitySignature = ({ capability, stage, runId, expiresAt, inputHash }) =>
  createHmac("sha256", Buffer.from(capability, "hex"))
    .update(`${stage}:${runId}:${expiresAt}:${inputHash}`)
    .digest("hex");

export const createModelCapabilityHeaders = ({
  capability,
  stage,
  runId,
  body,
  now = Date.now(),
  ttlMs = MODEL_CAPABILITY_TTL_MS,
}) => {
  const expiresAt = String(now + ttlMs);
  const inputHash = sha256(canonicalRequestJson(body));
  const signature = capabilitySignature({
    capability,
    stage,
    runId,
    expiresAt,
    inputHash,
  });
  return {
    authorization: `Bearer ${capability}`,
    "x-task-capability-expires-at": expiresAt,
    "x-task-input-sha256": inputHash,
    "x-task-capability-signature": signature,
  };
};

export const verifyModelCapability = ({
  headers,
  stage,
  runId,
  body,
  now = Date.now(),
}) => {
  const match = String(headers.authorization || "").match(/^Bearer ([a-f0-9]{64})$/u);
  const expiresAt = String(headers["x-task-capability-expires-at"] || "");
  const inputHash = String(headers["x-task-input-sha256"] || "");
  const suppliedSignature = String(headers["x-task-capability-signature"] || "");
  const expiresAtNumber = Number(expiresAt);
  if (
    !match ||
    !/^[0-9]{13}$/u.test(expiresAt) ||
    !/^[a-f0-9]{64}$/u.test(inputHash) ||
    !/^[a-f0-9]{64}$/u.test(suppliedSignature) ||
    !Number.isSafeInteger(expiresAtNumber) ||
    expiresAtNumber <= now ||
    expiresAtNumber > now + MODEL_CAPABILITY_MAX_TTL_MS
  ) {
    throw new BusinessValueError(
      "MODEL_CAPABILITY_INVALID",
      "Model capability отсутствует, истёк или повреждён",
    );
  }
  const expectedInputHash = sha256(canonicalRequestJson(body));
  if (!timingSafeEqual(Buffer.from(inputHash), Buffer.from(expectedInputHash))) {
    throw new BusinessValueError(
      "MODEL_CAPABILITY_INPUT_MISMATCH",
      "Model capability выпущен для другого input",
    );
  }
  const expectedSignature = capabilitySignature({
    capability: match[1],
    stage,
    runId,
    expiresAt,
    inputHash,
  });
  if (
    !timingSafeEqual(
      Buffer.from(suppliedSignature),
      Buffer.from(expectedSignature),
    )
  ) {
    throw new BusinessValueError(
      "MODEL_CAPABILITY_INVALID",
      "Model capability отсутствует, истёк или повреждён",
    );
  }
  return { capability: match[1], expiresAt: expiresAtNumber, inputHash, signature: suppliedSignature };
};

export const readRequestJson = async (request, maximumBytes = 262_144) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw new BusinessValueError("REQUEST_TOO_LARGE", "Request body превышает лимит");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BusinessValueError("INVALID_JSON", "Request body не является JSON");
  }
};

export const writeJson = (response, status, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
};

export const errorPayload = (error) => ({
  ok: false,
  reasonCode: error.code || "INTERNAL_ERROR",
  message:
    error instanceof BusinessValueError
      ? error.message
      : "Внутренний сервис завершился с ошибкой",
});

export const assertExactKeys = (value, allowed) => {
  const actual = Object.keys(value || {});
  const unknown = actual.filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !actual.includes(key));
  if (unknown.length || missing.length) {
    throw new BusinessValueError("REQUEST_SCHEMA_INVALID", "Набор полей request не совпадает с контрактом", {
      unknownCount: unknown.length,
      missingCount: missing.length,
    });
  }
};

export const capabilityKey = (signature, stage, runId) =>
  createHash("sha256").update(`${signature}:${stage}:${runId}`).digest("hex");
