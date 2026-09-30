import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { fail } from "./errors.mjs";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const validatedRunId = (runId) => {
  if (!RUN_ID.test(runId || "")) fail("INVALID_RUN_ID", "Некорректный run id");
  return runId;
};

export class RunStore {
  constructor(directory) {
    this.directory = resolve(directory);
  }

  path(runId) {
    return join(this.directory, "runs", `${validatedRunId(runId)}.json`);
  }

  async write(runId, value) {
    const directory = join(this.directory, "runs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = this.path(runId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    return value;
  }

  async read(runId) {
    try {
      return JSON.parse(await readFile(this.path(runId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") fail("RUN_NOT_FOUND", "Запуск не найден");
      throw error;
    }
  }

  async update(runId, patch) {
    const current = await this.read(runId);
    const next = typeof patch === "function" ? patch(structuredClone(current)) : { ...current, ...patch };
    return this.write(runId, next);
  }
}

export { validatedRunId };
