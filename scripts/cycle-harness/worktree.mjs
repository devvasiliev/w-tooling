import { readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";

import {
  canonicalJson,
  CycleHarnessError,
  escapesRoot,
  sha256,
  WORKTREE_EXCLUDES,
} from "./core.mjs";
import { optionalLstat } from "./safe-files.mjs";

/**
 * Снимок Git/worktree фиксирует HEAD, branch/detached state и состояние каждого
 * изменённого пути. Сравнение не читает чат и локализует drift по путям.
 */
export function splitNull(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function parseIndexEntries(buffer) {
  const entries = new Map();
  for (const record of splitNull(buffer)) {
    const separator = record.indexOf("\t");
    const metadata = separator === -1 ? [] : record.slice(0, separator).split(" ");
    const path = separator === -1 ? "" : record.slice(separator + 1);
    if (metadata.length !== 3 || !path) continue;
    const item = { mode: metadata[0], object: metadata[1], stage: Number(metadata[2]) };
    entries.set(path, [...(entries.get(path) ?? []), item]);
  }
  return entries;
}

async function worktreePathState(repositoryRoot, path) {
  const absolute = resolve(repositoryRoot, path);
  if (escapesRoot(repositoryRoot, absolute)) {
    throw new CycleHarnessError({
      code: "PATH_OUTSIDE_ROOT",
      stage: "worktree_snapshot",
      path: absolute,
      message: `Worktree path выходит за пределы репозитория: ${path}`,
      expected: repositoryRoot,
      actual: absolute,
      next: "Удали небезопасный path из рабочего дерева.",
    });
  }
  const metadata = await optionalLstat(absolute).catch((error) => {
    if (error?.code === "ENOTDIR") return null;
    throw error;
  });
  if (metadata === null) return { type: "missing" };
  if (metadata.isFile()) {
    return {
      type: "file",
      mode: metadata.mode & 0o111 ? "100755" : "100644",
      sha256: sha256(await readFile(absolute)),
    };
  }
  if (metadata.isDirectory()) return { type: "directory" };
  if (metadata.isSymbolicLink()) return { type: "symlink", target: await readlink(absolute) };
  throw new CycleHarnessError({
    code: "UNSAFE_WORKTREE_ENTRY",
    stage: "worktree_snapshot",
    path: absolute,
    message: `Worktree path имеет неподдерживаемый тип: ${path}`,
    expected: "file, directory, symbolic link или missing",
    actual: "special entry",
    next: "Удали special entry перед созданием checkpoint.",
  });
}

export function compareWorktreeSnapshots(checkpoint, current) {
  if (!checkpoint) {
    return {
      fingerprint_comparable: false,
      localization_available: false,
      head_changed: false,
      branch_changed: false,
      added: [],
      removed: [],
      changed: [],
    };
  }
  if (!Array.isArray(checkpoint.path_states) || !Array.isArray(current.path_states)) {
    return {
      fingerprint_comparable: false,
      localization_available: false,
      head_changed: checkpoint.head_sha !== current.head_sha,
      branch_changed: false,
      added: [],
      removed: [],
      changed: [],
    };
  }
  const before = new Map(checkpoint.path_states.map((item) => [item.path, item]));
  const after = new Map(current.path_states.map((item) => [item.path, item]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (!before.has(path)) added.push(path);
    else if (!after.has(path)) removed.push(path);
    else if (canonicalJson(before.get(path)) !== canonicalJson(after.get(path))) changed.push(path);
  }
  return {
    fingerprint_comparable: true,
    localization_available: true,
    head_changed: checkpoint.head_sha !== current.head_sha,
    branch_changed: checkpoint.branch !== current.branch || checkpoint.head_state !== current.head_state,
    added,
    removed,
    changed,
  };
}

export async function captureWorktreeSnapshot({ repositoryRoot, git, includePaths = null }) {
    const normalizedIncludes = includePaths === null
      ? null
      : [...new Set(includePaths)].sort();
    const pathspec = normalizedIncludes === null
      ? ["--", ".", ...WORKTREE_EXCLUDES]
      : ["--", ...normalizedIncludes.map((path) => `:(literal)${path}`)];
    const [
      { stdout: headBuffer },
      { stdout: branchBuffer },
      { stdout: diff },
      { stdout: trackedNames },
      { stdout: untrackedNames },
    ] =
      await Promise.all([
        git(repositoryRoot, ["rev-parse", "HEAD"], "worktree_snapshot"),
        git(repositoryRoot, ["rev-parse", "--abbrev-ref", "HEAD"], "worktree_snapshot"),
        git(repositoryRoot, ["diff", "--binary", "HEAD", ...pathspec], "worktree_snapshot"),
        git(repositoryRoot, ["diff", "--name-only", "-z", "HEAD", ...pathspec], "worktree_snapshot"),
        git(
          repositoryRoot,
          ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec],
          "worktree_snapshot",
        ),
      ]);
    const untracked = splitNull(untrackedNames).sort();
    const tracked = splitNull(trackedNames).sort();
    const changedPaths = [...new Set([...tracked, ...untracked])].sort();
    const indexEntries = changedPaths.length
      ? parseIndexEntries(
          (
            await git(
              repositoryRoot,
              ["ls-files", "--stage", "-z", "--", ...changedPaths.map((path) => `:(literal)${path}`)],
              "worktree_snapshot",
            )
          ).stdout,
        )
      : new Map();
    const untrackedSet = new Set(untracked);
    const pathStates = [];
    for (const path of changedPaths) {
      pathStates.push({
        path,
        status: untrackedSet.has(path) ? "untracked" : "tracked-change",
        working: await worktreePathState(repositoryRoot, path),
        index: indexEntries.get(path) ?? [],
      });
    }
    const headSha = headBuffer.toString("utf8").trim();
    const branchValue = branchBuffer.toString("utf8").trim();
    const branch = branchValue === "HEAD" ? null : branchValue;
    const headState = branch === null ? "detached" : "branch";
    const fingerprint = sha256(
      canonicalJson({
        head_sha: headSha,
        head_state: headState,
        branch,
        tracked_diff_sha256: sha256(diff),
        path_states: pathStates,
      }),
    );
    return {
      head_sha: headSha,
      head_state: headState,
      branch,
      tracked_diff_sha256: sha256(diff),
      fingerprint,
      changed_paths: changedPaths,
      path_states: pathStates,
    };
}
