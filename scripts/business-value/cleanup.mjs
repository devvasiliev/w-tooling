import { blockText } from "../notion-workflow-lib.mjs";
import { fail } from "./errors.mjs";
import {
  parseManagedSections,
  TEMPORARY_TITLE_PREFIX,
} from "./managed-section.mjs";
import { validatedRunId } from "./run-store.mjs";

export async function recordIncompleteRollback(runStore, runId, recovery) {
  validatedRunId(runId);
  return runStore.update(runId, {
    recovery: {
      status: "incomplete",
      pageId: recovery.pageId,
      temporaryBlockIds: [...new Set(recovery.temporaryBlockIds || [])],
      restoreCanonicalBlockId: recovery.restoreCanonicalBlockId || "",
      restoreFields: recovery.restoreFields || {},
      rollbackFailures: recovery.rollbackFailures || [],
    },
  });
}

export async function cleanupRun({ runStore, adapter, runId }) {
  validatedRunId(runId);
  const run = await runStore.read(runId);
  const recovery = run.recovery;
  if (!recovery || recovery.status !== "incomplete") {
    fail("CLEANUP_NOT_REQUIRED", "Для запуска нет незавершённого rollback");
  }
  const touchedBlockIds = [];
  for (const blockId of recovery.temporaryBlockIds) {
    const block = await adapter.readManaged(blockId);
    const sections = parseManagedSections([block]);
    const expectedTitle = `${TEMPORARY_TITLE_PREFIX}${runId}`;
    if (
      sections.temporary.length !== 1 ||
      blockText(block).trim() !== expectedTitle
    ) {
      fail(
        "CLEANUP_TARGET_MISMATCH",
        "Temporary block не принадлежит указанному run id",
        { blockId },
      );
    }
    await adapter.archiveBlock(blockId, true, { cleanup: true });
    touchedBlockIds.push(blockId);
  }
  if (recovery.restoreCanonicalBlockId) {
    const block = await adapter.readManaged(recovery.restoreCanonicalBlockId);
    const sections = parseManagedSections([block]);
    if (!sections.canonical) {
      fail("CLEANUP_TARGET_MISMATCH", "Canonical block не прошёл marker check");
    }
    await adapter.archiveBlock(recovery.restoreCanonicalBlockId, false, {
      cleanup: true,
    });
    touchedBlockIds.push(recovery.restoreCanonicalBlockId);
  }
  await adapter.updateFields(recovery.pageId, recovery.restoreFields, {
    cleanup: true,
  });
  await runStore.update(runId, {
    recovery: {
      ...recovery,
      status: "resolved",
      touchedBlockIds,
    },
  });
  return { status: "CLEANED", runId, pageId: recovery.pageId, touchedBlockIds };
}
