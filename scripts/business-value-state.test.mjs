import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  archiveManagedToggleBody,
  buildManagedToggle,
  CANONICAL_TITLE,
  managedRenderHash,
  parseManagedSections,
  renameManagedToggleBody,
} from "./business-value/managed-section.mjs";
import { PreviewStore } from "./business-value/preview-store.mjs";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";

test("managed toggle создаётся, читается, хешируется, переименовывается и архивируется", () => {
  const canonical = buildManagedToggle({
    runId: RUN_ID,
    markdown: "## Бизнес-эффект\n\nТочный результат.",
  });
  canonical.id = "block-1";
  canonical.children = canonical.toggle.children;
  const parsed = parseManagedSections([canonical]);
  assert.equal(parsed.canonical.id, "block-1");
  const sameContent = structuredClone(canonical);
  sameContent.id = "different-id";
  assert.equal(managedRenderHash(canonical), managedRenderHash(sameContent));
  sameContent.children[1].paragraph.rich_text[0].text.content = "Другой результат.";
  sameContent.children[1].paragraph.rich_text[0].plain_text = "Другой результат.";
  assert.notEqual(managedRenderHash(canonical), managedRenderHash(sameContent));
  assert.deepEqual(renameManagedToggleBody(), {
    toggle: {
      rich_text: [{ type: "text", text: { content: CANONICAL_TITLE }, plain_text: CANONICAL_TITLE }],
    },
  });
  assert.deepEqual(archiveManagedToggleBody(), { archived: true });
});

test("managed parser fail-closed при duplicate и foreign collision", () => {
  const first = buildManagedToggle({ runId: RUN_ID, markdown: "Результат один." });
  first.id = "block-1";
  first.children = first.toggle.children;
  const second = structuredClone(first);
  second.id = "block-2";
  assert.throws(
    () => parseManagedSections([first, second]),
    (error) => error.code === "MANAGED_SECTION_DUPLICATE",
  );
  const foreign = structuredClone(first);
  foreign.children = [];
  assert.throws(
    () => parseManagedSections([foreign]),
    (error) => error.code === "MANAGED_SECTION_FOREIGN_COLLISION",
  );
});

test("preview store проверяет TTL, версии, cancel и per-page lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-bv-state-"));
  const store = new PreviewStore(directory);
  const preview = {
    sourceFingerprint: "a".repeat(64),
    modelVersion: "BV-MODEL-1",
    baselineVersion: "BV-BASE-1",
    evaluatorDigest: "b".repeat(64),
    expiresAt: "2026-09-01T13:00:00.000Z",
  };
  try {
    await store.write(RUN_ID, preview);
    assert.deepEqual(
      await store.requirePublishable(RUN_ID, {
        ...preview,
        now: new Date("2026-09-01T12:00:00.000Z"),
      }),
      preview,
    );
    await assert.rejects(
      store.requirePublishable(RUN_ID, {
        ...preview,
        modelVersion: "BV-MODEL-2",
        now: new Date("2026-09-01T12:00:00.000Z"),
      }),
      (error) => error.code === "PREVIEW_STALE",
    );
    await assert.rejects(
      store.requirePublishable(RUN_ID, {
        ...preview,
        evaluatorDigest: "c".repeat(64),
        now: new Date("2026-09-01T12:00:00.000Z"),
      }),
      (error) => error.code === "PREVIEW_STALE",
    );
    await assert.rejects(
      store.requirePublishable(RUN_ID, {
        ...preview,
        now: new Date("2026-09-01T14:00:00.000Z"),
      }),
      (error) => error.code === "PREVIEW_EXPIRED",
    );
    await store.cancel(RUN_ID);
    await assert.rejects(
      store.requirePublishable(RUN_ID, {
        ...preview,
        now: new Date("2026-09-01T12:00:00.000Z"),
      }),
      (error) => error.code === "PREVIEW_CANCELLED",
    );

    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const lockEntered = new Promise((resolve) => {
      entered = resolve;
    });
    const first = store.withPageLock("page-1", async () => {
      entered();
      return barrier;
    });
    await lockEntered;
    await assert.rejects(
      store.withPageLock("page-1", async () => null),
      (error) => error.code === "PAGE_LOCKED",
    );
    release("done");
    assert.equal(await first, "done");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
