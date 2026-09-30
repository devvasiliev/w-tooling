import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv from "ajv";

import {
  assertAssessmentSemantics,
  assertExpectations,
  validateMatrix,
} from "./business-value/direct-eval.mjs";
import { scoreAssessment } from "./business-value/scorer.mjs";

const readJson = async (relativePath) =>
  JSON.parse(
    await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"),
  );

test("сохранённые direct model outputs детерминированно проходят контракт", async () => {
  const [schema, rawMatrix, replay, config] = await Promise.all([
    readJson("config/business-value-assessment.schema.json"),
    readJson("fixtures/business-value/matrix.json"),
    readJson("fixtures/business-value/replay/assessment-matrix.json"),
    readJson("config/business-value-model.v1.json"),
  ]);
  const matrix = validateMatrix(rawMatrix);
  const validateAssessment = new Ajv({ allErrors: true, strict: true }).compile(
    schema,
  );
  const expectedCases = matrix.cases.filter((scenario) => scenario.expect.modelCall);

  assert.equal(replay.schemaVersion, 1);
  assert.equal(replay.assessments.length, expectedCases.length);

  const scenariosByCode = new Map(
    expectedCases.map((scenario) => [scenario.input.taskCode, scenario]),
  );
  const replayedCodes = new Set();
  for (const assessment of replay.assessments) {
    assert.equal(
      validateAssessment(assessment),
      true,
      JSON.stringify(validateAssessment.errors),
    );
    assertAssessmentSemantics(assessment);
    assert.equal(assessment.includedTaskCodes.length, 1);
    const taskCode = assessment.includedTaskCodes[0];
    const scenario = scenariosByCode.get(taskCode);
    assert.ok(scenario, `Для ${taskCode} отсутствует synthetic scenario`);
    assertExpectations(scenario, assessment);
    const scoreInput = {
      assessment,
      taskType: scenario.input.taskType,
      config,
      evidenceSources: scenario.input.evidence || [],
      expectedTaskCode: taskCode,
    };
    assert.deepEqual(scoreAssessment(scoreInput), scoreAssessment(scoreInput));
    replayedCodes.add(taskCode);
  }
  assert.equal(replayedCodes.size, expectedCases.length);
});
