import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runDirectEvaluation } from "./business-value/direct-eval.mjs";

test("direct matrix dry-run блокирует пустое ядро до модели", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "task-bv-eval-test-"));
  try {
    const summary = await runDirectEvaluation({
      matrixPath: fileURLToPath(new URL("../fixtures/business-value/matrix.json", import.meta.url)),
      stateDirectory,
      model: "synthetic-model",
      codexBin: "not-used",
      caseId: "",
      dryRun: true,
    });
    assert.equal(summary.results.length, 10);
    const missing = summary.results.find((item) => item.id === "empty_story_core");
    assert.deepEqual(
      {
        modelCalled: missing.modelCalled,
        preflightExpected: missing.preflightExpected,
      },
      { modelCalled: false, preflightExpected: "NEEDS_INPUT" },
    );
    assert.ok(summary.results.every((item) => item.modelCalled === false));
    const stored = JSON.parse(
      await readFile(join(stateDirectory, "summary.json"), "utf8"),
    );
    assert.equal(stored.matrixHash, summary.matrixHash);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("direct matrix сохраняет только proof hashes без raw model payload", async () => {
  const source = await readFile(
    new URL("./business-value/direct-eval.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /input\.json|assessment\.json/u);
  assert.match(source, /guardModelOutput/u);
  assert.match(source, /scoreHash/u);
  assert.match(source, /guardVerdict/u);
});
