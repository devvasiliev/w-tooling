import { createHash } from "node:crypto";

import {
  blockText,
  markdownToBlocks,
} from "../notion-workflow-lib.mjs";
import { fail } from "./errors.mjs";
import { MANAGED_MARKER } from "./renderer.mjs";

export const CANONICAL_TITLE = "Бизнес-эффект";
export const TEMPORARY_TITLE_PREFIX = "Бизнес-эффект · ";

const richText = (content) => [
  { type: "text", text: { content }, plain_text: content },
];

const paragraph = (content) => ({
  object: "block",
  type: "paragraph",
  paragraph: { rich_text: richText(content), color: "default" },
});

const managedBodyMarkdown = (markdown) =>
  String(markdown || "")
    .split(/\r?\n/gu)
    .filter(
      (line) =>
        line.trim() !== `## ${CANONICAL_TITLE}` && line.trim() !== MANAGED_MARKER,
    )
    .join("\n")
    .trim();

export function buildManagedToggle({ runId, markdown, temporary = false }) {
  const title = temporary ? `${TEMPORARY_TITLE_PREFIX}${runId}` : CANONICAL_TITLE;
  return {
    object: "block",
    type: "toggle",
    toggle: {
      rich_text: richText(title),
      color: "default",
      children: [paragraph(MANAGED_MARKER), ...markdownToBlocks(managedBodyMarkdown(markdown))],
    },
  };
}

const hasMarker = (block) =>
  (block.children || []).some(
    (child) => child.type === "paragraph" && blockText(child).trim() === MANAGED_MARKER,
  );

export const isManagedSectionBlock = (block) => {
  if (block?.type !== "toggle") return false;
  const title = blockText(block).trim();
  return (
    (title === CANONICAL_TITLE || title.startsWith(TEMPORARY_TITLE_PREFIX)) &&
    hasMarker(block)
  );
};

export const withoutManagedSections = (blocks = []) =>
  blocks
    .filter((block) => !isManagedSectionBlock(block))
    .map((block) => ({
      ...block,
      ...(block.children
        ? { children: withoutManagedSections(block.children) }
        : {}),
    }));

const normalizedBlock = (block) => ({
  type: block.type,
  text: blockText(block).trim(),
  checked: block.type === "to_do" ? Boolean(block.to_do?.checked) : null,
  children: (block.children || []).map(normalizedBlock),
});

export const managedRenderHash = (block) =>
  createHash("sha256")
    .update(JSON.stringify(normalizedBlock(block)))
    .digest("hex");

export function parseManagedSections(blocks) {
  const candidates = (blocks || []).filter((block) => {
    if (block.type !== "toggle") return false;
    const title = blockText(block).trim();
    return title === CANONICAL_TITLE || title.startsWith(TEMPORARY_TITLE_PREFIX);
  });
  const foreign = candidates.filter((block) => !hasMarker(block));
  if (foreign.length) {
    fail(
      "MANAGED_SECTION_FOREIGN_COLLISION",
      "Найден toggle «Бизнес-эффект» без канонического marker",
      { blockIds: foreign.map((block) => block.id).filter(Boolean) },
    );
  }
  const canonical = candidates.filter(
    (block) => blockText(block).trim() === CANONICAL_TITLE,
  );
  if (canonical.length > 1) {
    fail(
      "MANAGED_SECTION_DUPLICATE",
      "Найдено несколько канонических разделов «Бизнес-эффект»",
      { blockIds: canonical.map((block) => block.id).filter(Boolean) },
    );
  }
  return {
    canonical: canonical[0] || null,
    temporary: candidates.filter((block) =>
      blockText(block).trim().startsWith(TEMPORARY_TITLE_PREFIX),
    ),
  };
}

export const renameManagedToggleBody = (title = CANONICAL_TITLE) => ({
  toggle: { rich_text: richText(title) },
});

export const archiveManagedToggleBody = (archived = true) => ({ archived });
