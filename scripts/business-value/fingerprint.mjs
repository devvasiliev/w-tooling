import { createHash } from "node:crypto";

import { withoutManagedSections } from "./managed-section.mjs";
import { blocksToMarkdown } from "./source.mjs";

const EXCLUDED_PROPERTY = /^(status|статус|priority|приоритет|business value|bv(?:\s|$)|updated|created|последн|редактор|release|релиз|дата релиза|баг релиза)/iu;

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  if (typeof value === "string") {
    return value.replace(/\r\n?/gu, "\n").replace(/[ \t]+/gu, " ").trim();
  }
  return value;
};

export const significantSource = (snapshot) => ({
  taskCode: snapshot.taskCode,
  taskType: snapshot.taskType,
  title: snapshot.title || "",
  descriptionMarkdown: snapshot.descriptionBlocks
    ? blocksToMarkdown(withoutManagedSections(snapshot.descriptionBlocks))
    : String(snapshot.descriptionMarkdown || ""),
  properties: Object.fromEntries(
    Object.entries(snapshot.properties || {})
      .filter(([name]) => !EXCLUDED_PROPERTY.test(name.trim()))
      .sort(([left], [right]) => left.localeCompare(right, "ru")),
  ),
  descendants: (snapshot.descendants || [])
    .map((item) => item?.taskCode || item)
    .filter(Boolean)
    .sort(),
  dependencies: (snapshot.dependencies || [])
    .map((item) => item?.taskCode || item)
    .filter(Boolean)
    .sort(),
});

export const buildSignificantFingerprint = (snapshot) =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(significantSource(snapshot))))
    .digest("hex");
