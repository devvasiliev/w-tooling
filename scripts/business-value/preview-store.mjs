import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { fail } from "./errors.mjs";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const safeRunId = (runId) => {
  if (!RUN_ID.test(runId || "")) fail("INVALID_RUN_ID", "Некорректный run id");
  return runId;
};

export class PreviewStore {
  constructor(directory) {
    this.directory = resolve(directory);
  }

  async ensureDirectories() {
    await Promise.all([
      mkdir(join(this.directory, "previews"), { recursive: true, mode: 0o700 }),
      mkdir(join(this.directory, "locks"), { recursive: true, mode: 0o700 }),
    ]);
  }

  previewPath(runId) {
    return join(this.directory, "previews", `${safeRunId(runId)}.json`);
  }

  async write(runId, preview, status = "pending") {
    await this.ensureDirectories();
    const target = this.previewPath(runId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, status, preview }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, target);
    return preview;
  }

  async read(runId) {
    try {
      return JSON.parse(await readFile(this.previewPath(runId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") fail("PREVIEW_NOT_FOUND", "Preview не найден");
      throw error;
    }
  }

  async requirePublishable(
    runId,
    {
      sourceFingerprint,
      modelVersion,
      baselineVersion,
      evaluatorDigest,
      now = new Date(),
    },
  ) {
    const stored = await this.read(runId);
    if (stored.status === "cancelled") fail("PREVIEW_CANCELLED", "Preview отменён");
    if (stored.status !== "pending") fail("PREVIEW_NOT_PENDING", "Preview уже обработан");
    const preview = stored.preview;
    if (Date.parse(preview.expiresAt) <= now.getTime()) {
      fail("PREVIEW_EXPIRED", "Срок действия preview истёк");
    }
    if (
      preview.sourceFingerprint !== sourceFingerprint ||
      preview.modelVersion !== modelVersion ||
      preview.baselineVersion !== baselineVersion ||
      preview.evaluatorDigest !== evaluatorDigest
    ) {
      fail("PREVIEW_STALE", "Источник или версия preview изменились");
    }
    return preview;
  }

  async cancel(runId) {
    const stored = await this.read(runId);
    await this.write(runId, stored.preview, "cancelled");
    return stored.preview;
  }

  async markPublished(runId) {
    const stored = await this.read(runId);
    await this.write(runId, stored.preview, "published");
  }

  async withPageLock(pageId, callback) {
    await this.ensureDirectories();
    const lockName = createHash("sha256").update(String(pageId)).digest("hex");
    const path = join(this.directory, "locks", `${lockName}.lock`);
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
    } catch (error) {
      if (error?.code === "EEXIST") fail("PAGE_LOCKED", "Для страницы уже идёт публикация");
      throw error;
    }
    try {
      return await callback();
    } finally {
      await handle?.close();
      await rm(path, { force: true });
    }
  }
}
