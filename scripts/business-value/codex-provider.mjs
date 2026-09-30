import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { fail } from "./errors.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const DEFAULT_SUPERVISOR = resolve(ROOT, "scripts/business-value/codex-supervisor.mjs");
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const permissionConfig =
  'permissions.business_value.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"},"/usr/local/bin/codex"="read","/opt/codex-runtime"="read"}';
const networkPermissionConfig = "permissions.business_value.network.enabled=false";
const enabledToolsConfig = (webSearch) =>
  `permissions.business_value.enabled_tools=${webSearch === "live" ? '["web_search"]' : "[]"}`;

const featureConfig = [
  "features.shell_tool=false",
  "features.unified_exec=false",
  "features.view_image=false",
  "features.plugins=false",
  "features.apps=false",
  "features.browser_use=false",
  "features.computer_use=false",
  "features.image_generation=false",
];

export const buildCodexArguments = ({
  evaluator,
  schemaPath,
  outputPath,
  workingDirectory,
  webSearch,
}) => [
  "exec",
  "--strict-config",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--skip-git-repo-check",
  "--model",
  evaluator.tuple.modelId,
  "--output-schema",
  schemaPath,
  "--output-last-message",
  outputPath,
  "-C",
  workingDirectory,
  "-c",
  `model_reasoning_effort="${evaluator.tuple.reasoningEffort}"`,
  "-c",
  'forced_login_method="chatgpt"',
  "-c",
  'cli_auth_credentials_store="file"',
  "-c",
  'approval_policy="never"',
  ...featureConfig.flatMap((value) => ["-c", value]),
  "-c",
  'shell_environment_policy.inherit="none"',
  "-c",
  'default_permissions="business_value"',
  "-c",
  permissionConfig,
  "-c",
  networkPermissionConfig,
  "-c",
  enabledToolsConfig(webSearch),
  "-c",
  `web_search="${webSearch}"`,
  "-",
];

export const isolatedCodexEnvironment = ({ authPath }) => ({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/tmp/task-business-value-home",
  CODEX_HOME: dirname(authPath),
  TMPDIR: "/tmp",
});

const stableFailure = ({ code, signal, timedOut }) => {
  if (timedOut) fail("CODEX_TIMEOUT", "Codex не завершил анализ вовремя");
  if (signal) fail("CODEX_PROCESS_SIGNAL", "Codex process был остановлен", { signal });
  if (code === 41) fail("CODEX_AUTH_NOT_CHATGPT", "Codex не авторизован через ChatGPT");
  if (code === 42) fail("CODEX_CLI_VERSION_MISMATCH", "Версия Codex CLI не совпадает с evaluator");
  fail("CODEX_PROCESS_FAILED", "Codex process завершился с ошибкой", { exitCode: code });
};

const runLockedSupervisor = ({
  authPath,
  evaluator,
  codexArgs = [],
  input,
  healthOnly = false,
  timeoutMs,
  spawnImpl = spawn,
  flockBin = "/usr/bin/flock",
  nodeBin = "/usr/local/bin/node",
  codexBin = "/usr/local/bin/codex",
  supervisorPath = DEFAULT_SUPERVISOR,
  workingDirectory = "/tmp",
}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const supervisorArgs = [
      "-x",
      authPath,
      nodeBin,
      supervisorPath,
      "--codex-bin",
      codexBin,
      "--expected-version",
      evaluator.tuple.codexCliVersion,
      ...(healthOnly ? ["--health-only"] : ["--", ...codexArgs]),
    ];
    const child = spawnImpl(flockBin, supervisorArgs, {
      shell: false,
      detached: process.platform !== "win32",
      cwd: workingDirectory,
      env: isolatedCodexEnvironment({ authPath }),
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout?.on("data", (chunk) => {
      stdoutBytes += chunk.length;
    });
    child.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && !signal && !timedOut) {
        resolvePromise({ code, stdoutBytes, stderrBytes });
        return;
      }
      try {
        stableFailure({ code, signal, timedOut });
      } catch (error) {
        rejectPromise(error);
      }
    });
    if (input) child.stdin.end(input);
  });

export async function checkCodexHealth(options) {
  if (!options.authPath) fail("CODEX_AUTH_MISSING", "Не задан dedicated Codex auth.json");
  await runLockedSupervisor({
    ...options,
    healthOnly: true,
    timeoutMs: options.timeoutMs || 15_000,
  });
  return {
    ok: true,
    authMode: "chatgpt",
    cliVersion: options.evaluator.tuple.codexCliVersion,
    evaluatorDigest: options.evaluator.digest,
  };
}

export async function callStructuredCodex({
  authPath,
  evaluator,
  prompt,
  input,
  schemaPath,
  webSearch = "disabled",
  timeoutMs = 180_000,
  ...dependencies
}) {
  if (!authPath) fail("CODEX_AUTH_MISSING", "Не задан dedicated Codex auth.json");
  if (!evaluator?.digest) fail("EVALUATOR_MISSING", "Evaluator tuple отсутствует");
  const canonicalSchemaPath = resolve(schemaPath);
  const schemaRelative = relative(resolve(ROOT, "config"), canonicalSchemaPath);
  if (schemaRelative.startsWith("..") || resolve(ROOT, "config", schemaRelative) !== canonicalSchemaPath) {
    fail("CODEX_SCHEMA_PATH_FORBIDDEN", "Schema должна принадлежать canonical config");
  }
  const allowedSchemaPaths = new Set(
    evaluator.manifest.schemaFiles.map((path) => resolve(ROOT, path)),
  );
  if (!allowedSchemaPaths.has(canonicalSchemaPath)) {
    fail(
      "CODEX_SCHEMA_NOT_PINNED",
      "Schema отсутствует в immutable evaluator manifest",
    );
  }
  if (!['disabled', 'live'].includes(webSearch)) {
    fail("CODEX_TOOL_MODE_INVALID", "Неизвестный режим Codex tools");
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "task-bv-codex-"));
  const outputPath = join(temporaryDirectory, "result.json");
  const codexArgs = buildCodexArguments({
    evaluator,
    schemaPath: canonicalSchemaPath,
    outputPath,
    workingDirectory: temporaryDirectory,
    webSearch,
  });
  const stdin = `${prompt}\n\n${JSON.stringify(input)}\n`;
  try {
    await runLockedSupervisor({
      authPath,
      evaluator,
      codexArgs,
      input: stdin,
      timeoutMs,
      workingDirectory: temporaryDirectory,
      ...dependencies,
    });
    const raw = await readFile(outputPath);
    if (raw.length === 0) fail("CODEX_EMPTY_OUTPUT", "Codex не вернул результат");
    if (raw.length > MAX_OUTPUT_BYTES) fail("CODEX_OUTPUT_TOO_LARGE", "Codex output превышает лимит");
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      fail("CODEX_INVALID_JSON", "Codex вернул невалидный JSON");
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export { DEFAULT_SUPERVISOR, ROOT as CODEX_PROVIDER_ROOT };
