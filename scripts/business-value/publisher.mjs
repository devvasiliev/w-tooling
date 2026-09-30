import { BusinessValueError, fail } from "./errors.mjs";
import {
  buildManagedToggle,
  managedRenderHash,
} from "./managed-section.mjs";

const fieldsFromPreview = (preview) =>
  Object.fromEntries(
    preview.fieldChanges.map((change) => [change.property, change.newValue]),
  );

const readableToggle = (toggle) => ({
  ...toggle,
  children: toggle.children || toggle.toggle?.children || [],
});

const assertFingerprint = (state, expected) => {
  if (state.fingerprint !== expected) {
    fail("SOURCE_CONFLICT", "Значимое содержимое карточки изменилось");
  }
};

const rollbackPublication = async ({ adapter, pageId, snapshot, journal }) => {
  const failures = [];
  const attempt = async (stage, callback) => {
    try {
      await callback();
    } catch (error) {
      failures.push({ stage, code: error.code || "ROLLBACK_OPERATION_FAILED" });
    }
  };
  if (journal.fieldsChanged) {
    await attempt("restore_fields", () =>
      adapter.updateFields(pageId, snapshot.bvFields, { rollback: true }),
    );
  }
  if (journal.oldArchived && snapshot.canonicalSection?.id) {
    await attempt("restore_old_section", () =>
      adapter.archiveBlock(snapshot.canonicalSection.id, false, { rollback: true }),
    );
  }
  if (journal.temporaryId) {
    await attempt("archive_temporary_section", () =>
      adapter.archiveBlock(journal.temporaryId, true, { rollback: true }),
    );
  }
  return failures;
};

export async function publishBusinessValue({
  adapter,
  previewStore,
  runId,
  pageId,
  modelConfig,
  botIdentity,
  recoveryRecorder,
  now = new Date(),
}) {
  return previewStore.withPageLock(pageId, async () => {
    const stored = await previewStore.read(runId);
    const initial = await adapter.readPublicationState(pageId);
    const preview = await previewStore.requirePublishable(runId, {
      sourceFingerprint: initial.fingerprint,
      modelVersion: modelConfig.modelVersion,
      baselineVersion: modelConfig.baselineVersion,
      evaluatorDigest: modelConfig.evaluatorDigest,
      now,
    });
    assertFingerprint(initial, preview.sourceFingerprint);
    const snapshot = {
      bvFields: structuredClone(initial.bvFields || {}),
      canonicalSection: initial.canonicalSection || null,
    };
    const journal = {
      stage: "initial",
      temporaryId: "",
      fieldsChanged: false,
      oldArchived: false,
    };
    const toggle = buildManagedToggle({
      runId,
      markdown: preview.managedSectionMarkdown,
      temporary: true,
    });
    const expectedHash = managedRenderHash(readableToggle(toggle));

    try {
      journal.stage = "create_temporary";
      const created = await adapter.createTemporary(pageId, toggle);
      journal.temporaryId = created.id;
      assertFingerprint(
        await adapter.readPublicationState(pageId),
        preview.sourceFingerprint,
      );

      journal.stage = "verify_temporary";
      const temporary = await adapter.readManaged(journal.temporaryId);
      if (managedRenderHash(temporary) !== expectedHash) {
        fail("MANAGED_SECTION_HASH_MISMATCH", "Временный раздел прочитан с изменениями");
      }
      assertFingerprint(
        await adapter.readPublicationState(pageId),
        preview.sourceFingerprint,
      );

      const proposedFields = fieldsFromPreview(preview);
      const calculatedAt = proposedFields["BV рассчитан"];
      delete proposedFields["BV рассчитан"];

      journal.stage = "update_fields";
      await adapter.updateFields(pageId, proposedFields);
      journal.fieldsChanged = true;
      assertFingerprint(
        await adapter.readPublicationState(pageId),
        preview.sourceFingerprint,
      );

      if (snapshot.canonicalSection?.id) {
        journal.stage = "archive_old_section";
        await adapter.archiveBlock(snapshot.canonicalSection.id, true);
        journal.oldArchived = true;
        assertFingerprint(
          await adapter.readPublicationState(pageId),
          preview.sourceFingerprint,
        );
      }

      journal.stage = "promote_temporary";
      await adapter.renameBlock(journal.temporaryId, "Бизнес-эффект");
      assertFingerprint(
        await adapter.readPublicationState(pageId),
        preview.sourceFingerprint,
      );

      journal.stage = "finalize_fields";
      await adapter.updateFields(pageId, { "BV рассчитан": calculatedAt }, { final: true });
      const finalState = await adapter.readPublicationState(pageId);
      assertFingerprint(finalState, preview.sourceFingerprint);
      if (
        finalState.formulaCurrent !== true ||
        finalState.visibleBusinessValue !== preview.proposed.value ||
        finalState.canonicalSection?.id !== journal.temporaryId ||
        finalState.lastEditedBy?.id !== botIdentity.id
      ) {
        fail(
          "PUBLISH_POSTCONDITION_FAILED",
          "Notion readback не подтвердил актуальную публикацию",
        );
      }
      await previewStore.markPublished(runId);
      return {
        status: "PUBLISHED",
        runId,
        pageId,
        value: preview.proposed.value,
        managedBlockId: journal.temporaryId,
      };
    } catch (error) {
      const rollbackFailures = await rollbackPublication({
        adapter,
        pageId,
        snapshot,
        journal,
      });
      if (rollbackFailures.length) {
        if (recoveryRecorder) {
          await recoveryRecorder({
            pageId,
            temporaryBlockIds: journal.temporaryId ? [journal.temporaryId] : [],
            restoreCanonicalBlockId: snapshot.canonicalSection?.id || "",
            restoreFields: snapshot.bvFields,
            rollbackFailures,
          });
        }
        throw new BusinessValueError(
          "ROLLBACK_INCOMPLETE",
          "Публикация не завершена, rollback требует cleanup",
          {
            failedStage: journal.stage,
            temporaryBlockId: journal.temporaryId,
            rollbackFailures,
          },
        );
      }
      if (error instanceof BusinessValueError) {
        error.details = { ...error.details, failedStage: journal.stage, rollback: "complete" };
        throw error;
      }
      throw new BusinessValueError("PUBLISH_FAILED", "Notion отклонил публикацию", {
        failedStage: journal.stage,
        rollback: "complete",
        causeCode: error.code || error.name,
      });
    }
  });
}
