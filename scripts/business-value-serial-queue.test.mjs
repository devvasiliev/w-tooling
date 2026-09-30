import assert from "node:assert/strict";
import test from "node:test";

import { SerialTaskQueue } from "./business-value/serial-queue.mjs";

test("Codex singleton queue не пересекает model calls", async () => {
  const queue = new SerialTaskQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.run(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = queue.run(async () => {
    events.push("second:start");
    events.push("second:end");
  });
  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("ошибка первой задачи не блокирует очередь", async () => {
  const queue = new SerialTaskQueue();
  await assert.rejects(queue.run(async () => {
    throw new Error("expected");
  }));
  assert.equal(await queue.run(async () => "ok"), "ok");
});
