import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import Ajv from "ajv";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const MANIFEST_PATH = "config/business-value-evaluator.v1.json";
const MANIFEST_SCHEMA_PATH = "config/business-value-evaluator.schema.json";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

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

export const canonicalJson = (value) => JSON.stringify(stableValue(value));

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const hashedFiles = async (root, paths) =>
  Object.fromEntries(
    await Promise.all(
      [...paths].sort().map(async (path) => [
        path,
        sha256(await readFile(resolve(root, path))),
      ]),
    ),
  );

export async function loadEvaluator({ root = ROOT } = {}) {
  const [manifest, schema] = await Promise.all([
    readJson(resolve(root, MANIFEST_PATH)),
    readJson(resolve(root, MANIFEST_SCHEMA_PATH)),
  ]);
  const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
  if (!validate(manifest)) {
    const error = new Error("EVALUATOR_MANIFEST_INVALID");
    error.code = "EVALUATOR_MANIFEST_INVALID";
    error.details = { errors: validate.errors };
    throw error;
  }
  const [promptHashes, schemaHashes, configHashes] = await Promise.all([
    hashedFiles(root, manifest.promptFiles),
    hashedFiles(root, manifest.schemaFiles),
    hashedFiles(root, manifest.configFiles),
  ]);
  const tuple = {
    evaluatorVersion: manifest.evaluatorVersion,
    scorerVersion: manifest.scorerVersion,
    baselineVersion: manifest.baselineVersion,
    codexCliVersion: manifest.codexCliVersion,
    modelId: manifest.modelId,
    reasoningEffort: manifest.reasoningEffort,
    promptHashes,
    schemaHashes,
    configHashes,
  };
  const digest = sha256(canonicalJson(tuple));
  return {
    manifest,
    tuple,
    digest,
    notionVersion: `${manifest.evaluatorVersion}@${digest}`,
  };
}

export const evaluatorMatches = (left, right) =>
  Boolean(
    left &&
      right &&
      left.digest === right.digest &&
      canonicalJson(left.tuple) === canonicalJson(right.tuple),
  );

export const buildModelContext = ({ config, evaluator }) => ({
  schemaVersion: 1,
  scoringModelVersion: config.modelVersion,
  baselineVersion: config.baselineVersion,
  evaluatorDigest: evaluator.digest,
  metrics: config.metrics.map((metric) => ({
    id: metric.id,
    label: metric.label,
    unit: metric.unit,
    baseline: metric.baseline,
    direction: metric.direction,
    causalGroup: metric.causalGroup,
    maximumRelativeEffect: metric.maximumRelativeEffect,
  })),
});

export { MANIFEST_PATH, MANIFEST_SCHEMA_PATH };
