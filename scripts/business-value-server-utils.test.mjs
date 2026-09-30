import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExactKeys,
  createModelCapabilityHeaders,
  verifyModelCapability,
} from "./business-value/server-utils.mjs";

test("exact request keys отклоняют лишние и отсутствующие поля", () => {
  assert.doesNotThrow(() => assertExactKeys({ runId, source: {} }, ["runId", "source"]));
  for (const value of [{ runId }, { runId, source: {}, extra: true }]) {
    assert.throws(
      () => assertExactKeys(value, ["runId", "source"]),
      (error) => error.code === "REQUEST_SCHEMA_INVALID",
    );
  }
});

const capability = "a".repeat(64);
const runId = "12345678-1234-4123-8123-123456789abc";
const body = { runId, source: { title: "Проверка" } };

test("model capability связан с run, stage, input hash и TTL", () => {
  const now = 1_800_000_000_000;
  const headers = createModelCapabilityHeaders({
    capability,
    stage: "analyze",
    runId,
    body,
    now,
  });
  const proof = verifyModelCapability({
    headers,
    stage: "analyze",
    runId,
    body: { source: { title: "Проверка" }, runId },
    now: now + 1,
  });

  assert.equal(proof.capability, capability);
  assert.match(proof.inputHash, /^[a-f0-9]{64}$/u);
  assert.match(proof.signature, /^[a-f0-9]{64}$/u);
});

test("model capability отклоняет другой input, stage и истёкший TTL", () => {
  const now = 1_800_000_000_000;
  const headers = createModelCapabilityHeaders({
    capability,
    stage: "analyze",
    runId,
    body,
    now,
  });

  assert.throws(
    () =>
      verifyModelCapability({
        headers,
        stage: "analyze",
        runId,
        body: { ...body, source: { title: "Подмена" } },
        now: now + 1,
      }),
    (error) => error.code === "MODEL_CAPABILITY_INPUT_MISMATCH",
  );
  assert.throws(
    () =>
      verifyModelCapability({
        headers,
        stage: "research",
        runId,
        body,
        now: now + 1,
      }),
    (error) => error.code === "MODEL_CAPABILITY_INVALID",
  );
  assert.throws(
    () =>
      verifyModelCapability({
        headers,
        stage: "analyze",
        runId,
        body,
        now: now + 120_001,
      }),
    (error) => error.code === "MODEL_CAPABILITY_INVALID",
  );
});
