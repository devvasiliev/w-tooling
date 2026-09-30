import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildCodexArguments,
  callStructuredCodex,
  checkCodexHealth,
} from "./business-value/codex-provider.mjs";
import { loadEvaluator } from "./business-value/evaluator.mjs";

const evaluator = await loadEvaluator();
const schemaPath = resolve("config/business-value-assessment.schema.json");

const fakeSpawn = ({ result = { schemaVersion: 1 }, exitCode = 0, stderr = "" } = {}) => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 123456;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      async end(input) {
        const outputFlag = args.indexOf("--output-last-message");
        if (exitCode === 0 && outputFlag !== -1) {
          await writeFile(args[outputFlag + 1], JSON.stringify(result));
        }
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        queueMicrotask(() => child.emit("close", exitCode, null));
      },
    };
    calls.push({ command, args, options, child, input: null });
    const originalEnd = child.stdin.end.bind(child.stdin);
    child.stdin.end = (input) => {
      calls.at(-1).input = String(input);
      return originalEnd(input);
    };
    if (options.stdio[0] === "ignore") {
      queueMicrotask(() => child.emit("close", exitCode, null));
    }
    return child;
  };
  return { calls, spawnImpl };
};

test("Codex argv фиксирует model, reasoning, strict config и zero internal tools", () => {
  const args = buildCodexArguments({
    evaluator,
    schemaPath,
    outputPath: "/tmp/output.json",
    workingDirectory: "/tmp/work",
    webSearch: "disabled",
  });
  assert.deepEqual(args.slice(0, 5), [
    "exec",
    "--strict-config",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
  ]);
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-sol");
  for (const config of [
    'model_reasoning_effort="high"',
    'forced_login_method="chatgpt"',
    'cli_auth_credentials_store="file"',
    "features.shell_tool=false",
    "features.unified_exec=false",
    "features.view_image=false",
    "features.plugins=false",
    "features.apps=false",
    "features.browser_use=false",
    "features.computer_use=false",
    "features.image_generation=false",
    "permissions.business_value.network.enabled=false",
    "permissions.business_value.enabled_tools=[]",
    'web_search="disabled"',
  ]) {
    assert.ok(args.includes(config), config);
  }
  assert.equal(args.at(-1), "-");
});

test("research включает только native web search поверх отключённых capabilities", () => {
  const args = buildCodexArguments({
    evaluator,
    schemaPath,
    outputPath: "/tmp/output.json",
    workingDirectory: "/tmp/work",
    webSearch: "live",
  });
  assert.ok(args.includes('web_search="live"'));
  assert.ok(args.includes("features.plugins=false"));
  assert.ok(args.includes("features.shell_tool=false"));
  assert.ok(args.includes("features.unified_exec=false"));
  assert.ok(args.includes("permissions.business_value.network.enabled=false"));
  assert.ok(args.includes('permissions.business_value.enabled_tools=["web_search"]'));
  assert.equal(args.includes("permissions.business_value.enabled_tools=[]"), false);
});

test("недоверенный prompt передаётся только stdin без shell/argv/env mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-bv-injection-"));
  const sideEffect = join(directory, "side-effect");
  const injection = `$(touch ${sideEffect}) \`touch ${sideEffect}\` "'\n; touch ${sideEffect}`;
  const fake = fakeSpawn();
  try {
    const output = await callStructuredCodex({
      authPath: join(directory, "auth.json"),
      evaluator,
      prompt: injection,
      input: { text: injection },
      schemaPath,
      spawnImpl: fake.spawnImpl,
    });
    assert.deepEqual(output, { schemaVersion: 1 });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].options.shell, false);
    assert.match(fake.calls[0].input, /\$\(touch/u);
    assert.doesNotMatch(JSON.stringify(fake.calls[0].args), /touch|side-effect/u);
    assert.doesNotMatch(JSON.stringify(fake.calls[0].options.env), /touch|side-effect/u);
    await assert.rejects(access(sideEffect));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("health fail-closed отличает не-ChatGPT auth без raw stderr", async () => {
  const fake = fakeSpawn({ exitCode: 41, stderr: "sensitive auth payload" });
  await assert.rejects(
    checkCodexHealth({
      authPath: "/tmp/dedicated-auth.json",
      evaluator,
      spawnImpl: fake.spawnImpl,
    }),
    (error) =>
      error.code === "CODEX_AUTH_NOT_CHATGPT" &&
      !error.message.includes("sensitive auth payload"),
  );
});

test("Codex adapter принимает только schema из evaluator manifest", async () => {
  await assert.rejects(
    callStructuredCodex({
      authPath: "/tmp/dedicated-auth.json",
      evaluator,
      prompt: "test",
      input: {},
      schemaPath: resolve("config/business-value-model.schema.json"),
      spawnImpl: fakeSpawn().spawnImpl,
    }),
    (error) => error.code === "CODEX_SCHEMA_NOT_PINNED",
  );
});
