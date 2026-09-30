import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { blockText } from "./notion-workflow-lib.mjs";
import { PreviewStore } from "./business-value/preview-store.mjs";
import { publishBusinessValue } from "./business-value/publisher.mjs";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const FINGERPRINT = "a".repeat(64);
const modelConfig = {
  modelVersion: "BV-MODEL-1",
  baselineVersion: "BV-BASE-1",
  evaluatorDigest: "b".repeat(64),
};
const botIdentity = { id: "bot-1", name: "W Integration" };

const createPreview = () => ({
  schemaVersion: 1,
  runId: RUN_ID,
  taskCode: "W-900500",
  taskType: "История",
  sourceFingerprint: FINGERPRINT,
  modelVersion: "BV-MODEL-1",
  baselineVersion: "BV-BASE-1",
  evaluatorDigest: "b".repeat(64),
  expiresAt: "2026-09-01T13:00:00.000Z",
  previous: { value: 11, status: "Устарело", confidence: 0.2 },
  proposed: { value: 28, status: "Оценено", confidence: 0.8 },
  fieldChanges: [
    { property: "BV значение", previousValue: 11, newValue: 28 },
    { property: "BV результат", previousValue: "Оценено", newValue: "Оценено" },
    { property: "BV рассчитан", previousValue: null, newValue: "2026-09-01T12:00:00.000Z" },
  ],
  managedSectionMarkdown: "## Бизнес-эффект\n\nПроверенный результат.",
  sourceUrls: [],
  warnings: [],
});

const fakeAdapter = ({
  injectAfter = "",
  failAt = "",
  rollbackFails = false,
  formulaCurrent = true,
  finalEditorId = "bot-1",
} = {}) => {
  const old = { id: "old-block", title: "Бизнес-эффект", archived: false };
  const state = {
    fingerprint: FINGERPRINT,
    bvFields: { "BV значение": 11, "BV результат": "Оценено", "BV рассчитан": null },
    blocks: new Map([[old.id, old]]),
    formulaCurrent: false,
    visibleBusinessValue: null,
    lastEditedBy: { id: "bot-1" },
  };
  const maybeFail = (operation, options = {}) => {
    if (options.rollback && rollbackFails) {
      const error = new Error("rollback failed");
      error.code = "ROLLBACK_FAULT";
      throw error;
    }
    if (operation === failAt && !options.rollback) {
      const error = new Error("injected failure");
      error.code = "INJECTED_FAILURE";
      throw error;
    }
    if (operation === injectAfter && !options.rollback) state.fingerprint = "b".repeat(64);
  };
  const activeCanonical = () =>
    [...state.blocks.values()].find(
      (block) => !block.archived && block.title === "Бизнес-эффект",
    ) || null;
  return {
    state,
    async readPublicationState() {
      return {
        fingerprint: state.fingerprint,
        bvFields: structuredClone(state.bvFields),
        canonicalSection: activeCanonical(),
        formulaCurrent: state.formulaCurrent,
        visibleBusinessValue: state.visibleBusinessValue,
        lastEditedBy: state.lastEditedBy,
      };
    },
    async createTemporary(_pageId, toggle) {
      const block = {
        ...structuredClone(toggle),
        id: "temp-block",
        title: blockText(toggle),
        children: structuredClone(toggle.toggle.children),
        archived: false,
      };
      state.blocks.set(block.id, block);
      maybeFail("createTemporary");
      return block;
    },
    async readManaged(blockId) {
      return state.blocks.get(blockId);
    },
    async updateFields(_pageId, fields, options = {}) {
      maybeFail(options.final ? "finalizeFields" : "updateFields", options);
      state.bvFields = { ...state.bvFields, ...structuredClone(fields) };
      if (options.final) {
        state.formulaCurrent = formulaCurrent;
        state.visibleBusinessValue = formulaCurrent ? state.bvFields["BV значение"] : null;
        state.lastEditedBy = { id: finalEditorId };
      }
    },
    async archiveBlock(blockId, archived, options = {}) {
      maybeFail("archiveBlock", options);
      state.blocks.get(blockId).archived = archived;
    },
    async renameBlock(blockId, title, options = {}) {
      maybeFail("renameBlock", options);
      state.blocks.get(blockId).title = title;
    },
  };
};

const withStore = async (callback) => {
  const directory = await mkdtemp(join(tmpdir(), "task-bv-publisher-"));
  const store = new PreviewStore(directory);
  try {
    await store.write(RUN_ID, createPreview());
    return await callback(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("publisher подтверждает success только после final readback", async () => {
  await withStore(async (previewStore) => {
    const adapter = fakeAdapter();
    const result = await publishBusinessValue({
      adapter,
      previewStore,
      runId: RUN_ID,
      pageId: "page-1",
      modelConfig,
      botIdentity,
      now: new Date("2026-09-01T12:10:00.000Z"),
    });
    assert.equal(result.status, "PUBLISHED");
    assert.equal(adapter.state.bvFields["BV значение"], 28);
    assert.equal(adapter.state.blocks.get("old-block").archived, true);
    assert.equal(adapter.state.blocks.get("temp-block").title, "Бизнес-эффект");
    assert.equal((await previewStore.read(RUN_ID)).status, "published");
  });
});

test("edit между каждой mutation даёт SOURCE_CONFLICT и полный rollback", async () => {
  for (const injectAfter of [
    "createTemporary",
    "updateFields",
    "archiveBlock",
    "renameBlock",
    "finalizeFields",
  ]) {
    await withStore(async (previewStore) => {
      const adapter = fakeAdapter({ injectAfter });
      await assert.rejects(
        publishBusinessValue({
          adapter,
          previewStore,
          runId: RUN_ID,
          pageId: "page-1",
          modelConfig,
          botIdentity,
          now: new Date("2026-09-01T12:10:00.000Z"),
        }),
        (error) => error.code === "SOURCE_CONFLICT" && error.details.rollback === "complete",
      );
      assert.deepEqual(adapter.state.bvFields, {
        "BV значение": 11,
        "BV результат": "Оценено",
        "BV рассчитан": null,
      });
      assert.equal(adapter.state.blocks.get("old-block").archived, false);
      assert.equal(adapter.state.blocks.get("temp-block").archived, true);
    });
  }
});

test("mid-flight error и formula-false откатываются", async () => {
  for (const options of [{ failAt: "renameBlock" }, { formulaCurrent: false }]) {
    await withStore(async (previewStore) => {
      const adapter = fakeAdapter(options);
      await assert.rejects(
        publishBusinessValue({
          adapter,
          previewStore,
          runId: RUN_ID,
          pageId: "page-1",
          modelConfig,
          botIdentity,
          now: new Date("2026-09-01T12:10:00.000Z"),
        }),
        (error) => ["PUBLISH_FAILED", "PUBLISH_POSTCONDITION_FAILED"].includes(error.code),
      );
      assert.equal(adapter.state.blocks.get("old-block").archived, false);
      assert.equal(adapter.state.blocks.get("temp-block").archived, true);
    });
  }
});

test("post-publish user/general-bot interleave не возвращает stale Business Value", async () => {
  await withStore(async (previewStore) => {
    const adapter = fakeAdapter({
      formulaCurrent: true,
      finalEditorId: "general-task-bot",
    });
    await assert.rejects(
      publishBusinessValue({
        adapter,
        previewStore,
        runId: RUN_ID,
        pageId: "page-1",
        modelConfig,
        botIdentity,
        now: new Date("2026-09-01T12:10:00.000Z"),
      }),
      (error) =>
        error.code === "PUBLISH_POSTCONDITION_FAILED" &&
        error.details.rollback === "complete",
    );
    assert.equal(adapter.state.blocks.get("old-block").archived, false);
    assert.equal(adapter.state.blocks.get("temp-block").archived, true);
    assert.equal(adapter.state.bvFields["BV значение"], 11);
  });
});

test("неполный rollback возвращает точный cleanup target", async () => {
  await withStore(async (previewStore) => {
    const adapter = fakeAdapter({ failAt: "renameBlock", rollbackFails: true });
    await assert.rejects(
      publishBusinessValue({
        adapter,
        previewStore,
        runId: RUN_ID,
        pageId: "page-1",
        modelConfig,
        botIdentity,
        now: new Date("2026-09-01T12:10:00.000Z"),
      }),
      (error) =>
        error.code === "ROLLBACK_INCOMPLETE" &&
        error.details.temporaryBlockId === "temp-block" &&
        error.details.rollbackFailures.length > 0,
    );
  });
});
