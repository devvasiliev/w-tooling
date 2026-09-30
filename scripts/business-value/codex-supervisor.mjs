#!/usr/bin/env node

import { spawn } from "node:child_process";

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
};

const run = (command, args, { input, capture = false } = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      shell: false,
      env: process.env,
      stdio: [input ? "pipe" : "ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    });
    const stdout = [];
    const stderr = [];
    if (capture) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (input) child.stdin.end(input);
  });

const parse = (argv) => {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const codexArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const result = {
    codexBin: "/usr/local/bin/codex",
    expectedVersion: "0.150.1",
    healthOnly: false,
    codexArgs,
  };
  for (let index = 0; index < own.length; index += 1) {
    const value = own[index];
    if (value === "--health-only") result.healthOnly = true;
    else if (value === "--codex-bin" || value === "--expected-version") {
      const target = own[index + 1];
      if (!target) throw new Error("CODEX_SUPERVISOR_ARGUMENT_INVALID");
      result[value === "--codex-bin" ? "codexBin" : "expectedVersion"] = target;
      index += 1;
    } else throw new Error("CODEX_SUPERVISOR_ARGUMENT_INVALID");
  }
  if (!result.healthOnly && result.codexArgs.length === 0) {
    throw new Error("CODEX_SUPERVISOR_ARGUMENT_INVALID");
  }
  return result;
};

const main = async () => {
  const options = parse(process.argv.slice(2));
  const version = await run(options.codexBin, ["--version"], { capture: true });
  if (
    version.code !== 0 ||
    version.stdout.trim() !== `codex-cli ${options.expectedVersion}`
  ) {
    process.exitCode = 42;
    return;
  }
  const auth = await run(options.codexBin, ["login", "status"], { capture: true });
  if (auth.code !== 0 || auth.stdout.trim() !== "Logged in using ChatGPT") {
    process.exitCode = 41;
    return;
  }
  if (options.healthOnly) return;
  const input = await readStdin();
  const execution = await run(options.codexBin, options.codexArgs, { input });
  if (execution.signal) {
    process.kill(process.pid, execution.signal);
    return;
  }
  process.exitCode = execution.code ?? 43;
};

try {
  await main();
} catch {
  process.exitCode = 43;
}
