import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

import * as verificationApi from "./task-verify-lib.mjs";

const {
  VerificationError,
  buildVerificationPlan,
  collectGitChanges,
  formatHumanReport,
  main,
  validateRepositoryManifest,
  validateWorkspaceRegistry,
} = verificationApi;

const execFile = promisify(execFileCallback);
const placeholderRevision = "0".repeat(40);

async function git(repositoryRoot, args) {
  return execFile("git", args, { cwd: repositoryRoot, encoding: "utf8" });
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function commitAll(repositoryRoot, message) {
  await git(repositoryRoot, ["add", "--all"]);
  await git(repositoryRoot, [
    "-c",
    "user.name=W Verify Test",
    "-c",
    "user.email=task-verify@example.test",
    "commit",
    "-m",
    message,
  ]);
  return (await git(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
}

function automaticAction(argv, overrides = {}) {
  return {
    kind: "automatic",
    argv,
    cwd: ".",
    ...overrides,
  };
}

function obligationAction(overrides = {}) {
  return {
    kind: "obligation",
    obligationType: "manual",
    reason: "Нужна ручная проверка",
    ...overrides,
  };
}

function repositoryManifest(repository, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "repository",
    repository,
    status: "active",
    policy: { fallbackBoundary: "repository-full" },
    actions: {
      unit: automaticAction(["node", "--version"]),
      "repository-full": automaticAction(["node", "--version"]),
    },
    areas: {
      code: {
        paths: ["src/**"],
        dependsOn: [],
        coverage: {
          affected: ["unit"],
          testing: ["unit"],
          pr: ["unit", "repository-full"],
          release: ["unit", "repository-full"],
        },
      },
    },
    boundaries: {
      "repository-full": { actions: ["repository-full"] },
    },
    metaGate: {
      actions: [],
      profiles: ["affected", "testing", "pr", "release"],
    },
    inputs: {},
    exports: {},
    ...overrides,
  };
}

function singleActionManifest(repository, actionId, definition) {
  return repositoryManifest(repository, {
    actions: {
      [actionId]: definition,
      "repository-full": automaticAction(["node", "--version"]),
    },
    areas: {
      code: {
        paths: ["src/**"],
        dependsOn: [],
        coverage: {
          affected: [actionId],
          testing: [actionId],
          pr: [actionId, "repository-full"],
          release: [actionId, "repository-full"],
        },
      },
    },
  });
}

function workspaceManifest(repositories, overrides = {}) {
  const registry = {
    schemaVersion: 1,
    kind: "workspace",
    ownerRepository: repositories[0],
    repositories: Object.fromEntries(
      repositories.map((repository, index) => [
        repository,
        {
          status: "active",
          enrollment: "enrolled",
          root: index === 0 ? "." : `../${repository}`,
          manifest: "task-verification.json",
          ...(index === 0 ? {} : { revision: placeholderRevision }),
        },
      ]),
    ),
    relations: [],
    exceptions: [],
    ...overrides,
  };
  registry.repositories = Object.fromEntries(
    Object.entries(registry.repositories).map(([repository, registration]) => [
      repository,
      {
        ...registration,
        ...(registration.enrollment === "enrolled"
          && repository !== registry.ownerRepository
          && !Object.hasOwn(registration, "revision")
          ? { revision: placeholderRevision }
          : {}),
      },
    ]),
  );
  return registry;
}

async function createWorkspace({
  repositories = ["task-app"],
  manifests = {},
  workspace = {},
} = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "task-verify-"));
  const workspacePath = join(workspaceRoot, repositories[0], "workspace-verification.json");
  const baseShas = {};
  for (const repository of repositories) {
    const repositoryRoot = join(workspaceRoot, repository);
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await writeFile(join(repositoryRoot, "src", "app.txt"), `${repository} baseline\n`, "utf8");
    await writeJson(
      join(repositoryRoot, "task-verification.json"),
      manifests[repository] ?? repositoryManifest(repository),
    );
    if (repository === repositories[0]) {
      await writeJson(
        workspacePath,
        workspaceManifest(repositories, workspace),
      );
    }
    await git(repositoryRoot, ["init", "--initial-branch=master"]);
    baseShas[repository] = await commitAll(repositoryRoot, "baseline");
  }
  const committedRegistry = JSON.parse(await readFile(workspacePath, "utf8"));
  let registryUpdated = false;
  for (const [repository, registration] of Object.entries(committedRegistry.repositories)) {
    if (
      repository !== committedRegistry.ownerRepository
      && registration.enrollment === "enrolled"
      && baseShas[repository] !== undefined
      && registration.revision !== baseShas[repository]
    ) {
      registration.revision = baseShas[repository];
      registryUpdated = true;
    }
  }
  if (registryUpdated) {
    await writeJson(workspacePath, committedRegistry);
    baseShas[repositories[0]] = await commitAll(
      join(workspaceRoot, repositories[0]),
      "pin enrolled repository revisions",
    );
  }
  return {
    workspaceRoot,
    workspacePath,
    baseSha: baseShas[repositories[0]],
    baseShas,
    repositoryRoot: join(workspaceRoot, repositories[0]),
    repositoryRoots: Object.fromEntries(
      repositories.map((repository) => [repository, join(workspaceRoot, repository)]),
    ),
  };
}

async function withWorkspace(options, callback) {
  const fixture = await createWorkspace(options);
  try {
    return await callback(fixture);
  } finally {
    await rm(fixture.workspaceRoot, { recursive: true, force: true });
  }
}

async function rejectsVerificationCode(promise, code) {
  let capturedError;
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof VerificationError, String(error));
    assert.equal(error.code, code);
    capturedError = error;
    return true;
  });
  return capturedError;
}

async function rejectsVerificationCodes(promise, codes) {
  let capturedError;
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof VerificationError, String(error));
    assert.ok(codes.includes(error.code), `неожиданный код ошибки: ${error.code}`);
    capturedError = error;
    return true;
  });
  return capturedError;
}

function throwsVerificationCode(callback, code) {
  let capturedError;
  assert.throws(callback, (error) => {
    assert.ok(error instanceof VerificationError, String(error));
    assert.equal(error.code, code);
    capturedError = error;
    return true;
  });
  return capturedError;
}

function planInput(fixture, overrides = {}) {
  return {
    registryPath: fixture.workspacePath,
    repository: "task-app",
    repositoryRoot: fixture.repositoryRoot,
    base: fixture.baseSha,
    profile: "affected",
    ...overrides,
  };
}

function changedPathSet(snapshot) {
  return new Set(
    snapshot.changes.flatMap((item) => [item.path, item.oldPath, item.newPath].filter(Boolean)),
  );
}

function actionIdSet(plan) {
  return new Set(plan.actions.map((action) => `${action.repository}:${action.id}`));
}

function reasonCodeSet(value) {
  return new Set(
    [
      ...(value.reasons ?? []),
      ...(value.fallbackIssues ?? []),
      ...(value.confounders ?? []),
      ...(value.obligations ?? []),
      ...(value.relationEvidence ?? []),
    ].map((record) => record.code),
  );
}

test("реальные W-конфиги задают приемочные path-to-argv соответствия", async (context) => {
  const toolingRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifestPath = join(toolingRoot, "task-verification.json");
  const registryPath = join(toolingRoot, "config", "workspace-verification.json");
  const manifestBytes = await readFile(manifestPath);
  const registryBytes = await readFile(registryPath);
  const manifest = validateRepositoryManifest(
    JSON.parse(manifestBytes.toString("utf8")),
    { path: manifestPath },
  );
  const registry = validateWorkspaceRegistry(
    JSON.parse(registryBytes.toString("utf8")),
    { path: registryPath },
  );

  async function withExactConfigs(callback) {
    await withWorkspace({
      repositories: ["w-tooling"],
      manifests: { "w-tooling": manifest },
    }, async (fixture) => {
      const fixtureManifestPath = join(fixture.repositoryRoot, "task-verification.json");
      const fixtureRegistryPath = join(
        fixture.repositoryRoot,
        "config",
        "workspace-verification.json",
      );
      await writeFile(fixtureManifestPath, manifestBytes);
      await mkdir(dirname(fixtureRegistryPath), { recursive: true });
      await writeFile(fixtureRegistryPath, registryBytes);
      const baseSha = await commitAll(fixture.repositoryRoot, "exact real verification configs");
      await callback({
        ...fixture,
        workspacePath: fixtureRegistryPath,
        baseSha,
      });
    });
  }

  const mappings = [
    {
      path: "scripts/task-verify-lib.mjs",
      expectedArgv: [["node", "--test", "scripts/task-verify.test.mjs"]],
    },
    {
      path: "scripts/sync-workspace.mjs",
      expectedArgv: [
        ["node", "--test", "scripts/sync-workspace.test.mjs"],
        ["npm", "run", "agents:check"],
      ],
    },
    {
      path: "scripts/sync-python-release.mjs",
      expectedArgv: [["node", "--test", "scripts/sync-python-release.test.mjs"]],
    },
    {
      path: "scripts/test_python_release_builder.py",
      expectedArgv: [["python3", "-B", "scripts/test_python_release_builder.py"]],
    },
    {
      path: "package.json",
      expectedArgv: [["npm", "test"]],
    },
  ];

  for (const mapping of mappings) {
    await context.test(mapping.path, async () => {
      await withExactConfigs(async (fixture) => {
        const changedPath = join(fixture.repositoryRoot, mapping.path);
        await mkdir(dirname(changedPath), { recursive: true });
        await writeFile(changedPath, "candidate\n", "utf8");

        const plan = await buildVerificationPlan(planInput(fixture, {
          repository: "w-tooling",
        }));
        const selectedArgv = new Set(
          plan.actions.map((action) => JSON.stringify(action.definition.argv)),
        );

        for (const argv of mapping.expectedArgv) {
          assert.ok(
            selectedArgv.has(JSON.stringify(argv)),
            `${mapping.path} обязан выбрать ${JSON.stringify(argv)}; получено ${JSON.stringify([...selectedArgv])}`,
          );
        }
      });
    });
  }

  await context.test("template выбирает локальный verifier до регистрации consumers", async () => {
    await withExactConfigs(async (fixture) => {
      const changedPath = join(
        fixture.repositoryRoot,
        "templates",
        "python-service",
        "pyproject.toml",
      );
      await mkdir(dirname(changedPath), { recursive: true });
      await writeFile(changedPath, "[project]\nname = \"fixture\"\n", "utf8");

      const plan = await buildVerificationPlan(planInput(fixture, {
        repository: "w-tooling",
      }));
      const pendingObligations = plan.obligations.filter(
        (obligation) => obligation.code === "DOWNSTREAM_UNVERIFIED",
      );

      assert.deepEqual(manifest.exports, {});
      assert.equal(registry.relations.length, 0);
      assert.ok(actionIdSet(plan).has("w-tooling:python-service-conformance"));
      assert.deepEqual(pendingObligations, []);
    });
  });
});

test("стандартный Draft 2020-12 валидатор принимает реальные конфиги", async (context) => {
  const toolingRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const schema = JSON.parse(
    await readFile(join(toolingRoot, "config", "task-verification.schema.json"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(join(toolingRoot, "task-verification.json"), "utf8"),
  );
  const registry = JSON.parse(
    await readFile(join(toolingRoot, "config", "workspace-verification.json"), "utf8"),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });

  assert.equal(ajv.validateSchema(schema), true, ajv.errorsText(ajv.errors));
  const validate = ajv.compile(schema);

  await context.test("exact repository manifest", () => {
    assert.equal(validate(manifest), true, ajv.errorsText(validate.errors));
  });

  await context.test("exact workspace registry", () => {
    assert.equal(validate(registry), true, ajv.errorsText(validate.errors));
  });

  for (const [field, value] of [["inputs", []], ["exports", null]]) {
    await context.test(`${field} non-object`, () => {
      const invalid = structuredClone(manifest);
      invalid[field] = value;
      assert.equal(validate(invalid), false, `${field}=${JSON.stringify(value)} обязан отклоняться`);
      assert.ok(
        validate.errors?.some((error) => error.instancePath === `/${field}`),
        ajv.errorsText(validate.errors),
      );
    });
  }

  await context.test("invalid enrolled revision", () => {
    const invalid = structuredClone(registry);
    invalid.repositories["w-releases"] = {
      ...invalid.repositories["w-releases"],
      enrollment: "enrolled",
      manifest: "task-verification.json",
      revision: "ABC123",
    };
    assert.equal(validate(invalid), false, "неполный uppercase revision обязан отклоняться");
    assert.ok(
      validate.errors?.some(
        (error) => error.instancePath === "/repositories/w-releases/revision",
      ),
      ajv.errorsText(validate.errors),
    );
  });

  await context.test("pending registration cannot carry revision", () => {
    const invalid = structuredClone(registry);
    invalid.repositories["w-releases"].revision = placeholderRevision;
    assert.equal(validate(invalid), false, "pending registration с revision обязан отклоняться");
    assert.ok(
      validate.errors?.some(
        (error) => error.instancePath.startsWith("/repositories/w-releases"),
      ),
      ajv.errorsText(validate.errors),
    );
  });
});

test("schema и ручные валидаторы одинаково принимают безопасные пути и glob", async () => {
  const toolingRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const schema = JSON.parse(
    await readFile(join(toolingRoot, "config", "task-verification.schema.json"), "utf8"),
  );
  const definitions = schema.$defs;
  const controlCases = [
    { label: "LF", value: "path/\nvalue", valid: false },
    { label: "C0", value: "path/\u0001value", valid: false },
    { label: "C1", value: "path/\u0085value", valid: false },
    { label: "U+2028", value: "path/\u2028value", valid: false },
    { label: "U+2029", value: "path/\u2029value", valid: false },
  ];
  const corpora = {
    safeRelativePath: [
      { label: "dot", value: ".", valid: true },
      { label: "обычный путь", value: "tools/runner", valid: true },
      { label: "точный служебный каталог", value: ".project/task-runs", valid: true },
      { label: "путь внутри служебного каталога", value: ".project/task-runs/W-448", valid: true },
      { label: "пустой", value: "", valid: false },
      { label: "абсолютный", value: "/tools/runner", valid: false },
      { label: "двойной separator", value: "tools//runner", valid: false },
      { label: "parent segment", value: "tools/../runner", valid: false },
      { label: "trailing slash", value: "tools/runner/", valid: false },
      { label: "backslash", value: "tools\\runner", valid: false },
      ...controlCases,
    ],
    workspaceRelativePath: [
      { label: "dot", value: ".", valid: true },
      { label: "parent", value: "..", valid: true },
      { label: "обычный соседний checkout", value: "../task-app", valid: true },
      { label: "parent внутри пути", value: "repos/../task-app", valid: true },
      { label: "точный служебный каталог", value: ".project/task-runs", valid: true },
      { label: "пустой", value: "", valid: false },
      { label: "абсолютный", value: "/task-app", valid: false },
      { label: "двойной separator", value: "repos//task-app", valid: false },
      { label: "trailing slash", value: "repos/task-app/", valid: false },
      { label: "backslash", value: "repos\\task-app", valid: false },
      ...controlCases,
    ],
    repositoryFilePath: [
      { label: "обычный manifest", value: "task-verification.json", valid: true },
      { label: "manifest в каталоге", value: "config/task-verification.json", valid: true },
      { label: "dot-prefixed segment", value: ".project/operator.json", valid: true },
      { label: "похожий нерезервный каталог", value: ".project/task-runs-other/manifest.json", valid: true },
      { label: "пустой", value: "", valid: false },
      { label: "dot", value: ".", valid: false },
      { label: "parent", value: "..", valid: false },
      { label: "dot segment", value: "config/./manifest.json", valid: false },
      { label: "parent segment", value: "config/../manifest.json", valid: false },
      { label: "точный служебный каталог", value: ".project/task-runs", valid: false },
      { label: "manifest в служебном каталоге", value: ".project/task-runs/W-448/manifest.json", valid: false },
      { label: "абсолютный", value: "/task-verification.json", valid: false },
      { label: "двойной separator", value: "config//manifest.json", valid: false },
      { label: "trailing slash", value: "config/", valid: false },
      { label: "backslash", value: "config\\manifest.json", valid: false },
      ...controlCases,
    ],
    positiveGlob: [
      { label: "обычный glob", value: "src/**", valid: true },
      { label: "звёздочка", value: "src/*.mjs", valid: true },
      { label: "вопросительный знак", value: "src/file?.txt", valid: true },
      { label: "literal", value: "docs/readme.md", valid: true },
      { label: "служебный каталог", value: ".project/task-runs", valid: true },
      { label: "glob служебного каталога", value: ".project/task-runs/**", valid: true },
      { label: "пустой", value: "", valid: false },
      { label: "negation", value: "!src/**", valid: false },
      { label: "абсолютный", value: "/src/**", valid: false },
      { label: "двойной separator", value: "src//**", valid: false },
      { label: "parent segment", value: "src/../**", valid: false },
      { label: "trailing slash", value: "src/", valid: false },
      { label: "backslash", value: "src\\**", valid: false },
      { label: "character class", value: "src/[ab].js", valid: false },
      { label: "brace", value: "src/{a,b}.js", valid: false },
      { label: "extglob", value: "src/@(a|b).js", valid: false },
      ...controlCases,
    ],
  };

  const schemaAccepts = (definitionName, value) => {
    const definition = definitions[definitionName];
    return value.length >= definition.minLength
      && new RegExp(definition.pattern, "u").test(value);
  };
  const manualAccepts = (definitionName, value) => {
    try {
      if (definitionName === "safeRelativePath") {
        const manifest = repositoryManifest("task-app");
        manifest.actions.unit.cwd = value;
        validateRepositoryManifest(manifest);
      } else if (definitionName === "workspaceRelativePath") {
        const registry = workspaceManifest(["task-app"]);
        registry.repositories["task-app"].root = value;
        validateWorkspaceRegistry(registry);
      } else if (definitionName === "repositoryFilePath") {
        const registry = workspaceManifest(["task-app"]);
        registry.repositories["task-app"].manifest = value;
        validateWorkspaceRegistry(registry);
      } else {
        const manifest = repositoryManifest("task-app");
        manifest.areas.code.paths = [value];
        validateRepositoryManifest(manifest);
      }
      return true;
    } catch (error) {
      if (error instanceof VerificationError) return false;
      throw error;
    }
  };

  for (const [definitionName, cases] of Object.entries(corpora)) {
    for (const corpusCase of cases) {
      const diagnostic = `${definitionName}: ${corpusCase.label} (${JSON.stringify(corpusCase.value)})`;
      assert.equal(schemaAccepts(definitionName, corpusCase.value), corpusCase.valid, `${diagnostic}, schema`);
      assert.equal(manualAccepts(definitionName, corpusCase.value), corpusCase.valid, `${diagnostic}, manual`);
    }
  }
});

test("учитывает committed, staged, unstaged, untracked, delete и обе стороны rename", async () => {
  await withWorkspace({}, async (fixture) => {
    await writeFile(join(fixture.repositoryRoot, "src", "delete-me.txt"), "delete me\n", "utf8");
    const baseRef = await commitAll(fixture.repositoryRoot, "expanded baseline");

    await git(fixture.repositoryRoot, ["mv", "src/app.txt", "src/renamed.txt"]);
    await writeFile(join(fixture.repositoryRoot, "src", "committed.txt"), "committed\n", "utf8");
    await commitAll(fixture.repositoryRoot, "candidate commit");
    await writeFile(join(fixture.repositoryRoot, "src", "staged.txt"), "staged\n", "utf8");
    await git(fixture.repositoryRoot, ["add", "src/staged.txt"]);
    await writeFile(join(fixture.repositoryRoot, "src", "renamed.txt"), "unstaged\n", "utf8");
    await writeFile(join(fixture.repositoryRoot, "src", "untracked.txt"), "untracked\n", "utf8");
    await rm(join(fixture.repositoryRoot, "src", "delete-me.txt"));

    const snapshot = await collectGitChanges({
      repositoryRoot: fixture.repositoryRoot,
      base: baseRef,
    });

    assert.deepEqual(
      [...changedPathSet(snapshot)].sort(),
      [
        "src/app.txt",
        "src/committed.txt",
        "src/delete-me.txt",
        "src/renamed.txt",
        "src/staged.txt",
        "src/untracked.txt",
      ],
    );
    assert.equal(snapshot.baseSha, baseRef);
    assert.match(snapshot.headSha, /^[0-9a-f]{40}$/u);
    assert.match(snapshot.fingerprint, /^[0-9a-f]{64}$/u);
  });
});

test("исключает только локальные журналы Cycle Optimizer из Git-снимка", async () => {
  await withWorkspace({}, async (fixture) => {
    await mkdir(join(fixture.repositoryRoot, ".project", "task-runs", "W-448", "nested"), {
      recursive: true,
    });
    await writeFile(
      join(fixture.repositoryRoot, ".project", "task-runs", "W-448", "checkpoint.json"),
      "{}\n",
      "utf8",
    );
    await writeFile(
      join(fixture.repositoryRoot, ".project", "task-runs", "W-448", "nested", "event.json"),
      "{}\n",
      "utf8",
    );
    await writeFile(join(fixture.repositoryRoot, ".project", "operator-note.json"), "{}\n", "utf8");

    const snapshot = await collectGitChanges({
      repositoryRoot: fixture.repositoryRoot,
      base: fixture.baseSha,
    });
    const changedPaths = changedPathSet(snapshot);

    assert.deepEqual(snapshot.excludedPaths, [".project/task-runs/**"]);
    assert.equal(
      [...changedPaths].some((path) => path.startsWith(".project/task-runs/")),
      false,
    );
    assert.ok(changedPaths.has(".project/operator-note.json"));
  });
});

test("игнорирует GIT_DIR, GIT_WORK_TREE и GIT_INDEX_FILE из окружения", async () => {
  await withWorkspace({ repositories: ["task-app", "task-decoy"] }, async (fixture) => {
    await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "app candidate\n", "utf8");
    const variableNames = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
    const previous = Object.fromEntries(variableNames.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      GIT_DIR: join(fixture.repositoryRoots["task-decoy"], ".git"),
      GIT_WORK_TREE: fixture.repositoryRoots["task-decoy"],
      GIT_INDEX_FILE: join(fixture.repositoryRoots["task-decoy"], ".git", "index"),
    });

    try {
      const snapshot = await collectGitChanges({
        repositoryRoot: fixture.repositoryRoot,
        base: fixture.baseSha,
      });

      assert.equal(snapshot.repositoryRoot, await realpath(fixture.repositoryRoot));
      assert.ok(changedPathSet(snapshot).has("src/app.txt"));
    } finally {
      for (const name of variableNames) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
  });
});

test("слои Git создают endpoints только для существующей версии пути", async (context) => {
  await context.test("staged add и последующая unstaged modify остаются candidate-only", async () => {
    const manifest = repositoryManifest("task-app");
    manifest.areas.code.paths = ["generated/**"];
    await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
      const generatedPath = join(fixture.repositoryRoot, "generated", "result.txt");
      await mkdir(dirname(generatedPath), { recursive: true });
      await writeFile(generatedPath, "staged\n", "utf8");
      await git(fixture.repositoryRoot, ["add", "generated/result.txt"]);
      await writeFile(generatedPath, "unstaged\n", "utf8");

      const plan = await buildVerificationPlan(planInput(fixture));
      const pathReasons = plan.reasons.filter((reason) => reason.path === "generated/result.txt");

      assert.equal(plan.outcome, "planned");
      assert.deepEqual(plan.fallbackIssues, []);
      assert.equal(reasonCodeSet(plan).has("PATH_UNMATCHED"), false);
      assert.ok(pathReasons.some((reason) => reason.manifestSource === "candidate"));
      assert.equal(pathReasons.some((reason) => reason.manifestSource === "base"), false);
    });
  });

  await context.test("rename и последующая modify сохраняют old/base и new/candidate", async () => {
    const manifest = repositoryManifest("task-app");
    manifest.areas.code.paths = ["old/**", "new/**"];
    await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
      const oldPath = join(fixture.repositoryRoot, "old", "artifact.txt");
      const newPath = join(fixture.repositoryRoot, "new", "artifact.txt");
      await mkdir(dirname(oldPath), { recursive: true });
      await writeFile(oldPath, "base\n", "utf8");
      const baseRef = await commitAll(fixture.repositoryRoot, "rename baseline");
      await mkdir(dirname(newPath), { recursive: true });
      await git(fixture.repositoryRoot, ["mv", "old/artifact.txt", "new/artifact.txt"]);
      await writeFile(newPath, "candidate modified\n", "utf8");

      const plan = await buildVerificationPlan(planInput(fixture, { base: baseRef }));
      const matched = plan.reasons.filter(
        (reason) => new Set(["old/artifact.txt", "new/artifact.txt"]).has(reason.path),
      );

      assert.deepEqual(plan.fallbackIssues, []);
      assert.ok(matched.some(
        (reason) => reason.path === "old/artifact.txt" && reason.manifestSource === "base",
      ));
      assert.ok(matched.some(
        (reason) => reason.path === "new/artifact.txt" && reason.manifestSource === "candidate",
      ));
      assert.equal(matched.some(
        (reason) => reason.path === "new/artifact.txt" && reason.manifestSource === "base",
      ), false);
    });
  });

  await context.test("staged modify и последующая delete не создают candidate endpoint", async () => {
    await withWorkspace({}, async (fixture) => {
      const path = join(fixture.repositoryRoot, "src", "app.txt");
      await writeFile(path, "staged modification\n", "utf8");
      await git(fixture.repositoryRoot, ["add", "src/app.txt"]);
      await rm(path);

      const plan = await buildVerificationPlan(planInput(fixture));
      const pathReasons = plan.reasons.filter((reason) => reason.path === "src/app.txt");

      assert.deepEqual(plan.fallbackIssues, []);
      assert.ok(pathReasons.some((reason) => reason.manifestSource === "base"));
      assert.equal(pathReasons.some((reason) => reason.manifestSource === "candidate"), false);
    });
  });
});

test("Git-снимок не доверяет локальному скрытию изменений", async (context) => {
  await context.test("core.fileMode=false не скрывает chmod", async () => {
    await withWorkspace({}, async (fixture) => {
      await git(fixture.repositoryRoot, ["config", "core.fileMode", "false"]);
      await chmod(join(fixture.repositoryRoot, "src", "app.txt"), 0o755);

      const snapshot = await collectGitChanges({
        repositoryRoot: fixture.repositoryRoot,
        base: fixture.baseSha,
      });
      const state = snapshot.pathStates.find((item) => item.path === "src/app.txt");

      assert.ok(changedPathSet(snapshot).has("src/app.txt"));
      assert.equal(state.base.mode, "100644");
      assert.equal(state.candidate.mode, "100755");
    });
  });

  await context.test("core.autocrlf=true не скрывает отличающиеся CRLF bytes", async () => {
    await withWorkspace({}, async (fixture) => {
      const appPath = join(fixture.repositoryRoot, "src", "app.txt");
      const baseBytes = (await git(fixture.repositoryRoot, [
        "show",
        `${fixture.baseSha}:src/app.txt`,
      ])).stdout;
      await git(fixture.repositoryRoot, ["config", "core.autocrlf", "true"]);
      await git(fixture.repositoryRoot, ["config", "core.eol", "crlf"]);
      await writeFile(appPath, baseBytes.replaceAll("\n", "\r\n"), "utf8");
      const candidateBytes = await readFile(appPath, "utf8");

      assert.equal(baseBytes.includes("\r\n"), false);
      assert.equal(candidateBytes.includes("\r\n"), true);
      assert.notEqual(candidateBytes, baseBytes, "raw worktree bytes должны отличаться от base blob");
      await git(fixture.repositoryRoot, ["diff", "--quiet", fixture.baseSha, "--", "src/app.txt"]);

      const snapshot = await collectGitChanges({
        repositoryRoot: fixture.repositoryRoot,
        base: fixture.baseSha,
      });

      assert.ok(changedPathSet(snapshot).has("src/app.txt"));
    });
  });

  await context.test("core.ignorecase=true не скрывает физическое case-only переименование", async (caseContext) => {
    await withWorkspace({}, async (fixture) => {
      const upperPath = join(fixture.repositoryRoot, "Case.txt");
      const lowerPath = join(fixture.repositoryRoot, "case.txt");
      await writeFile(upperPath, "case-sensitive payload\n", "utf8");
      const baseRef = await commitAll(fixture.repositoryRoot, "case baseline");

      let caseInsensitive = false;
      try {
        await readFile(lowerPath);
        caseInsensitive = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }

      await git(fixture.repositoryRoot, ["config", "core.ignorecase", "true"]);
      await rename(upperPath, lowerPath);
      const physicalNames = await readdir(fixture.repositoryRoot);
      if (!physicalNames.includes("case.txt") || physicalNames.includes("Case.txt")) {
        caseContext.skip("Файловая система не воспроизвела физическую смену регистра имени.");
        return;
      }

      const nativeStatus = (await git(fixture.repositoryRoot, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ])).stdout;
      if (caseInsensitive) {
        assert.equal(nativeStatus, "", "штатный Git должен скрыть case-only изменение на нечувствительной ФС");
      }

      await rejectsVerificationCode(
        collectGitChanges({ repositoryRoot: fixture.repositoryRoot, base: baseRef }),
        "GIT_CASE_COLLISION_UNSAFE",
      );
    });
  });

  await context.test("core.ignorecase=true не скрывает Unicode case-fold переименование", async (caseContext) => {
    await withWorkspace({}, async (fixture) => {
      const sigmaPath = join(fixture.repositoryRoot, "σ.txt");
      const finalSigmaPath = join(fixture.repositoryRoot, "ς.txt");
      await writeFile(sigmaPath, "unicode case-fold payload\n", "utf8");
      const baseRef = await commitAll(fixture.repositoryRoot, "unicode case baseline");

      let unicodeCaseInsensitive = false;
      try {
        await readFile(finalSigmaPath);
        unicodeCaseInsensitive = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }

      await git(fixture.repositoryRoot, ["config", "core.ignorecase", "true"]);
      await rename(sigmaPath, finalSigmaPath);
      const physicalNames = await readdir(fixture.repositoryRoot);
      if (!physicalNames.includes("ς.txt") || physicalNames.includes("σ.txt")) {
        caseContext.skip("Файловая система не воспроизвела физическое Unicode case-fold переименование.");
        return;
      }

      const nativeStatus = (await git(fixture.repositoryRoot, [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ])).stdout;
      if (unicodeCaseInsensitive) {
        assert.equal(
          nativeStatus.includes("σ.txt"),
          false,
          "штатный Git скрывает исчезновение tracked-стороны Unicode case-fold переименования",
        );
        assert.ok(
          nativeStatus === "" || nativeStatus === "?? ς.txt\n",
          `неожиданный native status: ${JSON.stringify(nativeStatus)}`,
        );
      }

      await rejectsVerificationCode(
        collectGitChanges({ repositoryRoot: fixture.repositoryRoot, base: baseRef }),
        "GIT_CASE_COLLISION_UNSAFE",
      );
    });
  });

  await context.test("core.symlinks=false не скрывает замену symlink обычным файлом", async (symlinkContext) => {
    await withWorkspace({}, async (fixture) => {
      const targetPath = join(fixture.repositoryRoot, "target.txt");
      const linkPath = join(fixture.repositoryRoot, "link.txt");
      await writeFile(targetPath, "target payload\n", "utf8");
      try {
        await symlink("target.txt", linkPath);
      } catch (error) {
        if (["EACCES", "ENOTSUP", "EPERM"].includes(error?.code)) {
          symlinkContext.skip(`Создание symlink недоступно: ${error.code}`);
          return;
        }
        throw error;
      }
      const baseRef = await commitAll(fixture.repositoryRoot, "symlink baseline");
      const stagedEntry = (await git(fixture.repositoryRoot, [
        "ls-files",
        "--stage",
        "--",
        "link.txt",
      ])).stdout;
      if (!stagedEntry.startsWith("120000 ")) {
        symlinkContext.skip("Git не сохранил fixture как symlink.");
        return;
      }

      await git(fixture.repositoryRoot, ["config", "core.symlinks", "false"]);
      await rm(linkPath);
      await writeFile(linkPath, "target.txt", "utf8");
      assert.equal(await readFile(linkPath, "utf8"), "target.txt");
      await git(fixture.repositoryRoot, ["diff", "--quiet", baseRef, "--", "link.txt"]);

      const snapshot = await collectGitChanges({
        repositoryRoot: fixture.repositoryRoot,
        base: baseRef,
      });
      const change = snapshot.changes.find((item) => item.path === "link.txt");
      const state = snapshot.pathStates.find((item) => item.path === "link.txt");

      assert.equal(change?.status, "type_changed");
      assert.equal(state?.base.type, "symlink");
      assert.equal(state?.candidate.type, "file");
    });
  });

  await context.test("global и info excludes не скрывают untracked, .gitignore скрывает", async () => {
    await withWorkspace({}, async (fixture) => {
      await writeFile(join(fixture.repositoryRoot, ".gitignore"), "repo-hidden.txt\n", "utf8");
      const baseRef = await commitAll(fixture.repositoryRoot, "gitignore baseline");
      const globalExcludes = join(fixture.workspaceRoot, "global-excludes");
      await writeFile(globalExcludes, "global-hidden.txt\n", "utf8");
      await git(fixture.repositoryRoot, ["config", "core.excludesFile", globalExcludes]);
      await writeFile(join(fixture.repositoryRoot, ".git", "info", "exclude"), "info-hidden.txt\n", "utf8");
      await writeFile(join(fixture.repositoryRoot, "global-hidden.txt"), "candidate\n", "utf8");
      await writeFile(join(fixture.repositoryRoot, "info-hidden.txt"), "candidate\n", "utf8");
      await writeFile(join(fixture.repositoryRoot, "repo-hidden.txt"), "candidate\n", "utf8");

      const snapshot = await collectGitChanges({
        repositoryRoot: fixture.repositoryRoot,
        base: baseRef,
      });
      const paths = changedPathSet(snapshot);

      assert.ok(paths.has("global-hidden.txt"));
      assert.ok(paths.has("info-hidden.txt"));
      assert.equal(paths.has("repo-hidden.txt"), false);
    });
  });

  for (const [name, args, flag] of [
    ["assume-unchanged", ["--assume-unchanged"], "assume-unchanged"],
    ["skip-worktree", ["--skip-worktree"], "skip-worktree"],
  ]) {
    await context.test(name, async () => {
      await withWorkspace({}, async (fixture) => {
        await git(fixture.repositoryRoot, ["update-index", ...args, "src/app.txt"]);

        const error = await rejectsVerificationCode(
          collectGitChanges({ repositoryRoot: fixture.repositoryRoot, base: fixture.baseSha }),
          "GIT_INDEX_HIDDEN_PATHS",
        );
        assert.equal(error.details.paths[0].flag, flag);
        assert.equal(error.details.paths[0].path, "src/app.txt");
      });
    });
  }

  await context.test("repository-local clean filter отвергается до запуска marker", async () => {
    await withWorkspace({}, async (fixture) => {
      await writeFile(join(fixture.repositoryRoot, ".gitattributes"), "*.txt filter=probe\n", "utf8");
      const baseRef = await commitAll(fixture.repositoryRoot, "attributes baseline");
      const markerPath = join(fixture.workspaceRoot, "filter-marker");
      await git(fixture.repositoryRoot, [
        "config",
        "filter.probe.clean",
        `/usr/bin/touch ${JSON.stringify(markerPath)}`,
      ]);

      await rejectsVerificationCode(
        collectGitChanges({ repositoryRoot: fixture.repositoryRoot, base: baseRef }),
        "GIT_FILTER_UNSAFE",
      );
      await assert.rejects(readFile(markerPath), { code: "ENOENT" });
    });
  });

  await context.test("worktree-local clean filter отвергается до запуска marker", async () => {
    await withWorkspace({}, async (fixture) => {
      await writeFile(join(fixture.repositoryRoot, ".gitattributes"), "*.txt filter=audit\n", "utf8");
      const baseRef = await commitAll(fixture.repositoryRoot, "worktree attributes baseline");
      const markerPath = join(fixture.repositoryRoot, "worktree-filter-marker");
      await git(fixture.repositoryRoot, ["config", "extensions.worktreeConfig", "true"]);
      await git(fixture.repositoryRoot, [
        "config",
        "--worktree",
        "filter.audit.clean",
        "/usr/bin/touch worktree-filter-marker",
      ]);

      await rejectsVerificationCode(
        collectGitChanges({ repositoryRoot: fixture.repositoryRoot, base: baseRef }),
        "GIT_FILTER_UNSAFE",
      );
      await assert.rejects(readFile(markerPath), { code: "ENOENT" });
    });
  });
});

test("symlink candidate path отвергается до чтения внешнего файла", async (context) => {
  await withWorkspace({}, async (fixture) => {
    const linkedDirectory = join(fixture.repositoryRoot, "src", "linked");
    const trackedPath = join(linkedDirectory, "external.txt");
    await mkdir(linkedDirectory, { recursive: true });
    await writeFile(trackedPath, "tracked baseline\n", "utf8");
    const baseRef = await commitAll(fixture.repositoryRoot, "intermediate symlink baseline");

    const externalDirectory = join(fixture.workspaceRoot, "external-candidate");
    const externalPath = join(externalDirectory, "external.txt");
    await mkdir(externalDirectory);
    await writeFile(externalPath, "must not be read\n", "utf8");
    await chmod(externalPath, 0o000);
    await rm(linkedDirectory, { recursive: true });
    try {
      await symlink(externalDirectory, linkedDirectory);
    } catch (error) {
      if (["EACCES", "ENOTSUP", "EPERM"].includes(error?.code)) {
        context.skip(`Создание symlink недоступно: ${error.code}`);
        return;
      }
      throw error;
    }
    const error = await rejectsVerificationCodes(
      collectGitChanges({ repositoryRoot: fixture.repositoryRoot, base: baseRef }),
      ["GIT_PATH_SYMLINK_UNSAFE", "GIT_SYMLINK_UNSAFE"],
    );

    assert.equal(error.stage, "git_snapshot");
    assert.equal(
      error.path,
      error.code === "GIT_PATH_SYMLINK_UNSAFE"
        ? "src/linked/external.txt"
        : "src/linked",
    );
    assert.doesNotMatch(String(error.actual ?? ""), /EACCES|permission denied/iu);
  });
});

test("partial clone с отсутствующим base blob завершается fail closed без lazy fetch", async (context) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "task-verify-partial-"));
  const sourceRoot = join(fixtureRoot, "source");
  const remoteRoot = join(fixtureRoot, "remote.git");
  const partialRoot = join(fixtureRoot, "partial");

  async function objectTreeState(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    const state = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        state.push(...await objectTreeState(path, relativePath));
      } else {
        const metadata = await stat(path);
        state.push({ path: relativePath, size: metadata.size, mtimeMs: metadata.mtimeMs });
      }
    }
    return state;
  }

  async function gitWithoutLazyFetch(repositoryRoot, args) {
    const environment = {
      ...process.env,
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    };
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete environment[name];
    try {
      const result = await execFile("git", args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: environment,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return {
        exitCode: Number.isInteger(error?.code) ? error.code : 1,
        stdout: error?.stdout ?? "",
        stderr: error?.stderr ?? error?.message ?? String(error),
      };
    }
  }

  try {
    await mkdir(sourceRoot);
    await git(sourceRoot, ["init", "--initial-branch=master"]);
    await mkdir(join(sourceRoot, "src"), { recursive: true });
    await writeFile(join(sourceRoot, "src", "app.txt"), "base payload\n".repeat(8192), "utf8");
    const baseRef = await commitAll(sourceRoot, "partial clone base");
    const baseBlob = (await git(sourceRoot, ["rev-parse", `${baseRef}:src/app.txt`])).stdout.trim();
    await writeFile(join(sourceRoot, "src", "app.txt"), "candidate payload\n".repeat(8192), "utf8");
    await commitAll(sourceRoot, "partial clone candidate");

    await execFile("git", ["clone", "--bare", sourceRoot, remoteRoot], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    await git(remoteRoot, ["config", "uploadpack.allowFilter", "true"]);
    await git(remoteRoot, ["config", "uploadpack.allowAnySHA1InWant", "true"]);

    try {
      await execFile("git", [
        "-c",
        "protocol.file.allow=always",
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "--no-local",
        pathToFileURL(remoteRoot).href,
        partialRoot,
      ], {
        cwd: fixtureRoot,
        encoding: "utf8",
      });
      await git(partialRoot, ["checkout", "--force", "HEAD"]);
    } catch (error) {
      context.skip(`Локальный Git не поддерживает partial clone filter: ${error?.message ?? String(error)}`);
      return;
    }

    const objectsRoot = join(partialRoot, ".git", "objects");
    const stateBeforeProbe = await objectTreeState(objectsRoot);
    const beforeProbe = await gitWithoutLazyFetch(partialRoot, ["cat-file", "-e", `${baseBlob}^{blob}`]);
    const stateAfterProbe = await objectTreeState(objectsRoot);
    if (beforeProbe.exitCode === 0 || JSON.stringify(stateBeforeProbe) !== JSON.stringify(stateAfterProbe)) {
      context.skip("Partial clone filter или GIT_NO_LAZY_FETCH не оставили base blob отсутствующим.");
      return;
    }

    const stateBeforePlan = stateAfterProbe;
    let capturedError;
    await assert.rejects(
      collectGitChanges({ repositoryRoot: partialRoot, base: baseRef }),
      (error) => {
        assert.ok(error instanceof VerificationError, String(error));
        capturedError = error;
        return true;
      },
    );
    assert.match(capturedError.code, /^GIT_/u);

    const afterProbe = await gitWithoutLazyFetch(partialRoot, ["cat-file", "-e", `${baseBlob}^{blob}`]);
    const stateAfterPlan = await objectTreeState(objectsRoot);
    assert.notEqual(afterProbe.exitCode, 0, "base blob не должен появиться после планирования");
    assert.deepEqual(stateAfterPlan, stateBeforePlan, "pack/object state не должен измениться");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test(".git/info/attributes не может влиять на Git-снимок", async (context) => {
  async function rejectInfoAttributesVariant(createAttributes) {
    await withWorkspace({}, async (fixture) => {
      const attributesPath = join(fixture.repositoryRoot, ".git", "info", "attributes");
      const markerPath = join(fixture.workspaceRoot, "attributes-marker");
      await createAttributes(fixture, attributesPath);
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "$Id$ candidate\n", "utf8");

      await rejectsVerificationCode(
        collectGitChanges({ repositoryRoot: fixture.repositoryRoot, base: fixture.baseSha }),
        "GIT_ATTRIBUTES_UNSAFE",
      );
      await assert.rejects(readFile(markerPath), { code: "ENOENT" });
    });
  }

  await context.test("непустой обычный файл", async () => {
    await rejectInfoAttributesVariant(async (_fixture, attributesPath) => {
      await writeFile(attributesPath, "src/app.txt ident\n", "utf8");
    });
  });

  await context.test("symbolic link", async () => {
    await rejectInfoAttributesVariant(async (fixture, attributesPath) => {
      const targetPath = join(fixture.workspaceRoot, "info-attributes-target");
      await writeFile(targetPath, "src/app.txt ident\n", "utf8");
      await symlink(targetPath, attributesPath);
    });
  });
});

test("tracked .gitattributes с ident не может скрыть отличающиеся сырые bytes", async () => {
  await withWorkspace({}, async (fixture) => {
    const appPath = join(fixture.repositoryRoot, "src", "app.txt");
    await writeFile(
      join(fixture.repositoryRoot, ".gitattributes"),
      "src/app.txt ident\n",
      "utf8",
    );
    await writeFile(appPath, "$Id$ baseline\n", "utf8");
    const baseRef = await commitAll(fixture.repositoryRoot, "ident attributes baseline");
    const baseBytes = (await git(fixture.repositoryRoot, [
      "show",
      `${baseRef}:src/app.txt`,
    ])).stdout;

    await writeFile(appPath, "$Id: locally-expanded $ baseline\n", "utf8");
    const candidateBytes = await readFile(appPath, "utf8");
    assert.notEqual(candidateBytes, baseBytes, "сырые candidate bytes должны отличаться от base blob");
    await git(fixture.repositoryRoot, ["diff", "--quiet", baseRef, "--", "src/app.txt"]);

    const error = await rejectsVerificationCode(
      collectGitChanges({ repositoryRoot: fixture.repositoryRoot, base: baseRef }),
      "GIT_ATTRIBUTES_UNSAFE",
    );
    assert.equal(error.stage, "git_snapshot");
  });
});

test("initialized submodule отвергается до проверки локального clean filter", async () => {
  await withWorkspace({}, async (fixture) => {
    const sourceRoot = join(fixture.workspaceRoot, "submodule-source");
    await mkdir(sourceRoot);
    await git(sourceRoot, ["init", "--initial-branch=master"]);
    await writeFile(join(sourceRoot, ".gitattributes"), "payload.txt filter=probe\n", "utf8");
    await writeFile(join(sourceRoot, "payload.txt"), "clean payload\n", "utf8");
    await commitAll(sourceRoot, "submodule baseline");

    await git(fixture.repositoryRoot, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--",
      pathToFileURL(sourceRoot).href,
      "vendor/child",
    ]);
    const baseRef = await commitAll(fixture.repositoryRoot, "initialized submodule baseline");
    const childRoot = join(fixture.repositoryRoot, "vendor", "child");
    const payloadPath = join(childRoot, "payload.txt");
    const markerPath = join(childRoot, "filter-marker-executed");
    await git(childRoot, [
      "config",
      "filter.probe.clean",
      "/usr/bin/touch filter-marker-executed",
    ]);
    const payloadMetadata = await stat(payloadPath);
    await utimes(
      payloadPath,
      payloadMetadata.atime,
      new Date(payloadMetadata.mtimeMs + 60_000),
    );
    assert.equal(await readFile(payloadPath, "utf8"), "clean payload\n");

    await rejectsVerificationCode(
      collectGitChanges({ repositoryRoot: fixture.repositoryRoot, base: baseRef }),
      "GIT_SUBMODULE_UNSAFE",
    );
    await assert.rejects(readFile(markerPath), { code: "ENOENT" });
  });
});

test("Git diff больше 1 MiB строит snapshot под пределом runner", async () => {
  await withWorkspace({}, async (fixture) => {
    const largePath = join(fixture.repositoryRoot, "src", "large-diff.txt");
    const payloadBytes = 2 * 1024 * 1024;
    await writeFile(largePath, `${"a".repeat(payloadBytes)}\n`, "utf8");
    const baseRef = await commitAll(fixture.repositoryRoot, "large diff baseline");
    await writeFile(largePath, `${"b".repeat(payloadBytes)}\n`, "utf8");

    const snapshot = await collectGitChanges({
      repositoryRoot: fixture.repositoryRoot,
      base: baseRef,
    });
    const pathState = snapshot.pathStates.find((item) => item.path === "src/large-diff.txt");

    assert.ok(changedPathSet(snapshot).has("src/large-diff.txt"));
    assert.ok(pathState.candidate.size > 1024 * 1024);
    assert.equal(Object.hasOwn(snapshot, "binaryDiffSha256"), false);
    assert.match(snapshot.indexStageSha256, /^[0-9a-f]{64}$/u);
    assert.match(snapshot.fingerprint, /^[0-9a-f]{64}$/u);
  });
});

test("ограничивает config, candidate file и общий бюджет чтения", async (context) => {
  await context.test("candidate config не может превышать 1 МиБ", async () => {
    await withWorkspace({}, async (fixture) => {
      const manifestPath = join(fixture.repositoryRoot, "task-verification.json");
      const manifest = repositoryManifest("task-app", {
        $schema: `./${"a".repeat(1024 * 1024)}`,
      });
      await writeJson(manifestPath, manifest);

      const error = await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture)),
        "CONFIG_FILE_TOO_LARGE",
      );

      assert.equal(error.stage, "config_loading");
      assert.equal(error.path, await realpath(manifestPath));
      assert.equal(error.details.limitBytes, 1024 * 1024);
      assert.ok(error.details.size > error.details.limitBytes);
    });
  });

  await context.test("один candidate file не может превышать 32 МиБ", async () => {
    await withWorkspace({}, async (fixture) => {
      const candidatePath = join(fixture.repositoryRoot, "src", "app.txt");
      await truncate(candidatePath, 32 * 1024 * 1024 + 1);

      const error = await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture)),
        "CANDIDATE_FILE_TOO_LARGE",
      );

      assert.equal(error.stage, "git_snapshot");
      assert.equal(error.path, "src/app.txt");
      assert.equal(error.details.limitBytes, 32 * 1024 * 1024);
      assert.equal(error.details.size, 32 * 1024 * 1024 + 1);
    });
  });

  await context.test("суммарный бюджет охватывает вывод Git и чтение конфигурации", async () => {
    await withWorkspace({}, async (fixture) => {
      const limitBytes = 1;

      const error = await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture, {
          readLimits: { totalBytes: limitBytes },
        })),
        "CANDIDATE_READ_BUDGET_EXCEEDED",
      );

      assert.equal(error.stage, "git_snapshot");
      assert.equal(error.details.limitBytes, limitBytes);
      assert.ok(error.details.consumedBytes > limitBytes);
      assert.ok(error.expected.length > 0);
      assert.ok(error.actual.length > 0);
    });
  });

  await context.test("общее окно времени ограничивает весь Git-контур", async () => {
    await withWorkspace({}, async (fixture) => {
      const error = await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture, {
          readLimits: { timeoutMs: 0 },
        })),
        "CANDIDATE_READ_TIMEOUT",
      );

      assert.equal(error.stage, "git_snapshot");
      assert.equal(error.details.timeoutMs, 0);
    });
  });
});

test("требует отдельный repositoryRoot и точный Git top-level", async (context) => {
  await withWorkspace({}, async (fixture) => {
    await context.test("repositoryRoot обязателен", async () => {
      await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture, {
          repositoryRoot: undefined,
        })),
        "REPOSITORY_ROOT_REQUIRED",
      );
    });

    await context.test("подкаталог checkout не принимается как repositoryRoot", async () => {
      await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture, {
          repositoryRoot: join(fixture.repositoryRoot, "src"),
        })),
        "REPOSITORY_ROOT_NOT_GIT_TOPLEVEL",
      );
    });
  });
});

test("отвергает symlink в trust-конфигурации до чтения target", async (context) => {
  await context.test("workspace registry", async () => {
    await withWorkspace({}, async (fixture) => {
      await rm(fixture.workspacePath);
      await symlink("missing-workspace.json", fixture.workspacePath);

      await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture)),
        "CONFIG_SYMLINK_UNSUPPORTED",
      );
    });
  });

  await context.test("selected repository manifest", async () => {
    await withWorkspace({}, async (fixture) => {
      const manifestPath = join(fixture.repositoryRoot, "task-verification.json");
      await rm(manifestPath);
      await symlink("missing-manifest.json", manifestPath);

      await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture)),
        "CONFIG_SYMLINK_UNSUPPORTED",
      );
    });
  });

  await context.test("каталог-предок workspace registry", async () => {
    await withWorkspace({}, async (fixture) => {
      const registryDirectory = join(fixture.repositoryRoot, "registry");
      const registryPath = join(registryDirectory, "workspace-verification.json");
      await mkdir(registryDirectory);
      await git(fixture.repositoryRoot, [
        "mv",
        "workspace-verification.json",
        "registry/workspace-verification.json",
      ]);
      const baseRef = await commitAll(fixture.repositoryRoot, "registry directory baseline");
      const targetDirectory = join(fixture.repositoryRoot, "registry-target");
      await mkdir(targetDirectory);
      await writeFile(
        join(targetDirectory, "workspace-verification.json"),
        await readFile(registryPath),
      );
      await rm(registryDirectory, { recursive: true });
      await symlink("registry-target", registryDirectory);

      await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture, {
          registryPath,
          base: baseRef,
        })),
        "CONFIG_SYMLINK_UNSUPPORTED",
      );
    });
  });

  await context.test("каталог-symlink workspace registry указывает на корень checkout", async () => {
    await withWorkspace({}, async (fixture) => {
      const linkedDirectory = join(fixture.repositoryRoot, "registry-root-link");
      await symlink(".", linkedDirectory);

      await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture, {
          registryPath: join(linkedDirectory, "workspace-verification.json"),
        })),
        "CONFIG_SYMLINK_UNSUPPORTED",
      );
    });
  });

  await context.test("каталог-предок selected repository manifest", async () => {
    await withWorkspace({}, async (fixture) => {
      const manifestDirectory = join(fixture.repositoryRoot, "verification");
      const manifestPath = join(manifestDirectory, "task-verification.json");
      await mkdir(manifestDirectory);
      await git(fixture.repositoryRoot, [
        "mv",
        "task-verification.json",
        "verification/task-verification.json",
      ]);
      const registry = JSON.parse(await readFile(fixture.workspacePath, "utf8"));
      registry.repositories["task-app"].manifest = "verification/task-verification.json";
      await writeJson(fixture.workspacePath, registry);
      const baseRef = await commitAll(fixture.repositoryRoot, "manifest directory baseline");
      const targetDirectory = join(fixture.repositoryRoot, "verification-target");
      await mkdir(targetDirectory);
      await writeFile(
        join(targetDirectory, "task-verification.json"),
        await readFile(manifestPath),
      );
      await rm(manifestDirectory, { recursive: true });
      await symlink("verification-target", manifestDirectory);

      await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture, { base: baseRef })),
        "CONFIG_SYMLINK_UNSUPPORTED",
      );
    });
  });
});

test("не теряет staged-изменение, отменённое только в рабочем дереве", async () => {
  await withWorkspace({}, async (fixture) => {
    await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "staged candidate\n", "utf8");
    await git(fixture.repositoryRoot, ["add", "src/app.txt"]);
    await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "app baseline\n", "utf8");

    const snapshot = await collectGitChanges({
      repositoryRoot: fixture.repositoryRoot,
      base: fixture.baseSha,
    });
    const plan = await buildVerificationPlan(planInput(fixture));

    assert.ok(changedPathSet(snapshot).has("src/app.txt"));
    assert.notEqual(plan.outcome, "no_changes");
    assert.ok(actionIdSet(plan).has("task-app:unit"));
  });
});

test("fingerprint связывает разные staged bytes через indexStageSha256", async () => {
  await withWorkspace({}, async (fixture) => {
    const path = join(fixture.repositoryRoot, "src", "app.txt");

    await writeFile(path, "staged variant A\n", "utf8");
    await git(fixture.repositoryRoot, ["add", "src/app.txt"]);
    await writeFile(path, "same final worktree\n", "utf8");
    const first = await collectGitChanges({
      repositoryRoot: fixture.repositoryRoot,
      base: fixture.baseSha,
    });

    await writeFile(path, "staged variant B\n", "utf8");
    await git(fixture.repositoryRoot, ["add", "src/app.txt"]);
    await writeFile(path, "same final worktree\n", "utf8");
    const second = await collectGitChanges({
      repositoryRoot: fixture.repositoryRoot,
      base: fixture.baseSha,
    });

    assert.equal(first.headSha, second.headSha);
    assert.deepEqual(first.changes, second.changes);
    assert.deepEqual(first.pathStates, second.pathStates);
    assert.equal(first.diffSha256, second.diffSha256);
    assert.notEqual(first.indexStageSha256, second.indexStageSha256);
    assert.notEqual(first.fingerprint, second.fingerprint);
  });
});

test("конкурентный candidate drift завершается typed CANDIDATE_DRIFT", async () => {
  await withWorkspace({}, async (fixture) => {
    const candidatePath = join(fixture.repositoryRoot, "src", "app.txt");
    const canonicalRepositoryRoot = await realpath(fixture.repositoryRoot);
    const canonicalCandidatePath = join(canonicalRepositoryRoot, "src", "app.txt");
    await writeFile(candidatePath, "candidate-before-drift\n", "utf8");
    let stopped = false;
    let revision = 0;
    const mutateCandidate = (async () => {
      while (!stopped) {
        revision += 1;
        await writeFile(candidatePath, `candidate-drift-${revision}\n`, "utf8");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
      }
    })();

    try {
      const error = await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture)),
        "CANDIDATE_DRIFT",
      );
      assert.equal(error.stage, "git_snapshot");
      assert.ok(
        error.path === fixture.repositoryRoot
          || error.path === candidatePath
          || error.path === "src/app.txt"
          || error.path === canonicalRepositoryRoot
          || error.path === canonicalCandidatePath,
        `неожиданный drift path: ${error.path}`,
      );
      assert.equal(typeof error.expected, "string");
      assert.equal(typeof error.actual, "string");
      assert.notEqual(error.expected, error.actual);
    } finally {
      stopped = true;
      await mutateCandidate;
    }
  });
});

test("блокирует незавершённый конфликт индекса", async () => {
  await withWorkspace({}, async (fixture) => {
    await git(fixture.repositoryRoot, ["switch", "-c", "other"]);
    await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "other\n", "utf8");
    await commitAll(fixture.repositoryRoot, "other change");
    await git(fixture.repositoryRoot, ["switch", "master"]);
    await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "master\n", "utf8");
    const trustedBase = await commitAll(fixture.repositoryRoot, "master change");
    await assert.rejects(git(fixture.repositoryRoot, ["merge", "other"]));

    await rejectsVerificationCode(
      buildVerificationPlan(planInput(fixture, { base: trustedBase })),
      "UNMERGED_INDEX",
    );
  });
});

test("требует bootstrap, если в доверенной базе ещё нет repository manifest", async () => {
  await withWorkspace({}, async (fixture) => {
    await rm(join(fixture.repositoryRoot, "task-verification.json"));
    const baseRef = await commitAll(fixture.repositoryRoot, "base without verification manifest");
    await writeJson(
      join(fixture.repositoryRoot, "task-verification.json"),
      repositoryManifest("task-app"),
    );
    await rejectsVerificationCode(
      buildVerificationPlan(planInput(fixture, { base: baseRef })),
      "BOOTSTRAP_REQUIRED",
    );
  });
});

test("требует bootstrap со структурным next, если в base ещё нет workspace registry", async () => {
  await withWorkspace({}, async (fixture) => {
    const registry = JSON.parse(await readFile(fixture.workspacePath, "utf8"));
    await rm(fixture.workspacePath);
    const baseRef = await commitAll(fixture.repositoryRoot, "base without workspace registry");
    await writeJson(fixture.workspacePath, registry);

    const error = await rejectsVerificationCode(
      buildVerificationPlan(planInput(fixture, { base: baseRef })),
      "BOOTSTRAP_REQUIRED",
    );

    assert.equal(error.stage, "config_loading");
    assert.equal(typeof error.next, "string");
    assert.ok(error.next.length > 0, "next обязан содержать точное bootstrap-действие");
    assert.equal(error.toJSON().next, error.next);
  });
});

test("выбирает локальные и обратно-зависимые области транзитивно без дублей", async () => {
  const manifest = repositoryManifest("task-app", {
    actions: {
      core: automaticAction(["node", "--version"]),
      service: automaticAction(["node", "--version"]),
      api: automaticAction(["node", "--version"]),
      shared: automaticAction(["node", "--version"]),
      "repository-full": automaticAction(["node", "--version"]),
    },
    areas: {
      core: {
        paths: ["src/core/**"],
        dependsOn: [],
        coverage: {
          affected: ["core", "shared"],
          testing: ["core", "shared"],
          pr: ["core", "shared", "repository-full"],
          release: ["core", "shared", "repository-full"],
        },
      },
      service: {
        paths: ["src/service/**"],
        dependsOn: ["core"],
        coverage: {
          affected: ["service", "shared"],
          testing: ["service", "shared"],
          pr: ["service", "shared", "repository-full"],
          release: ["service", "shared", "repository-full"],
        },
      },
      api: {
        paths: ["src/api/**"],
        dependsOn: ["service"],
        coverage: {
          affected: ["api", "shared"],
          testing: ["api", "shared"],
          pr: ["api", "shared", "repository-full"],
          release: ["api", "shared", "repository-full"],
        },
      },
    },
  });
  await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
    await mkdir(join(fixture.repositoryRoot, "src", "core"), { recursive: true });
    await writeFile(join(fixture.repositoryRoot, "src", "core", "value.txt"), "changed\n", "utf8");

    const plan = await buildVerificationPlan(planInput(fixture));

    assert.equal(plan.outcome, "planned");
    assert.deepEqual(
      [...actionIdSet(plan)].sort(),
      ["task-app:api", "task-app:core", "task-app:service", "task-app:shared"],
    );
    assert.equal(plan.actions.filter((action) => action.id === "shared").length, 1);
    assert.ok(
      plan.actions.every((action) => Array.isArray(action.reasons) && action.reasons.length > 0),
      "каждая выбранная команда обязана объяснить цепочку причин",
    );
  });
});

test("блокирует цикл зависимостей областей", async () => {
  const manifest = repositoryManifest("task-app", {
    areas: {
      first: {
        paths: ["src/first/**"],
        dependsOn: ["second"],
        coverage: {
          affected: ["unit"], testing: ["unit"], pr: ["unit", "repository-full"], release: ["unit", "repository-full"],
        },
      },
      second: {
        paths: ["src/second/**"],
        dependsOn: ["first"],
        coverage: {
          affected: ["unit"], testing: ["unit"], pr: ["unit", "repository-full"], release: ["unit", "repository-full"],
        },
      },
    },
  });
  await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
    await rejectsVerificationCode(
      buildVerificationPlan(planInput(fixture)),
      "AREA_DEPENDENCY_CYCLE",
    );
  });
});

test("доверяет объединению base и candidate и сохраняет self-gate удалённого определения", async () => {
  const manifest = repositoryManifest("task-app", {
    actions: {
      unit: automaticAction(["node", "--version"]),
      guard: automaticAction(["node", "--version"]),
      "repository-full": automaticAction(["node", "--version"]),
    },
    metaGate: {
      actions: ["guard"],
      profiles: ["affected", "testing", "pr", "release"],
    },
  });
  await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
    const candidate = structuredClone(manifest);
    delete candidate.actions.guard;
    candidate.metaGate.actions = [];
    await writeJson(join(fixture.repositoryRoot, "task-verification.json"), candidate);

    const plan = await buildVerificationPlan(planInput(fixture));
    const guard = plan.actions.find((action) => action.id === "guard");

    assert.ok(guard, "base self-gate нельзя удалить самим изменяемым manifest");
    assert.deepEqual(guard.sources, ["base"]);
    assert.ok(reasonCodeSet(plan).has("META_GATE_CHANGED"));
  });
});

test("доверенная база выводится из refs/heads/master", async (context) => {
  await context.test("ветка задачи принимает общий предок с master", async () => {
    await withWorkspace({}, async (fixture) => {
      const trustedBase = fixture.baseSha;
      await git(fixture.repositoryRoot, ["switch", "-c", "candidate"]);
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "candidate commit\n", "utf8");
      const candidateHead = await commitAll(fixture.repositoryRoot, "candidate change");

      const plan = await buildVerificationPlan(planInput(fixture, { base: trustedBase }));

      assert.equal(plan.baseSha, trustedBase);
      assert.deepEqual(plan.baseAuthority, {
        kind: "protected-target-merge-base",
        repositoryRoot: await realpath(fixture.repositoryRoot),
        targetRef: "refs/heads/master",
        headSha: candidateHead,
        targetSha: trustedBase,
        mergeBaseSha: trustedBase,
      });
      assert.ok(actionIdSet(plan).has("task-app:unit"));
    });
  });

  await context.test("доступный старый коммит не становится базой", async () => {
    await withWorkspace({}, async (fixture) => {
      const staleBase = fixture.baseSha;
      await writeFile(join(fixture.repositoryRoot, "src", "trusted.txt"), "advance master\n", "utf8");
      const trustedBase = await commitAll(fixture.repositoryRoot, "advance trusted master");

      const error = await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture, { base: staleBase })),
        "BASE_REVISION_UNTRUSTED",
      );

      assert.equal(error.expected, trustedBase);
      assert.equal(error.actual, staleBase);
      assert.equal(error.details.targetRef, "refs/heads/master");
    });
  });

  await context.test("старая база владельца реестра отклоняется отдельно", async () => {
    await withWorkspace({ repositories: ["task-registry", "task-app"] }, async (fixture) => {
      const staleRegistryBase = fixture.baseShas["task-registry"];
      await writeFile(
        join(fixture.repositoryRoots["task-registry"], "src", "trusted.txt"),
        "advance registry master\n",
        "utf8",
      );
      const trustedRegistryBase = await commitAll(
        fixture.repositoryRoots["task-registry"],
        "advance registry master",
      );
      await writeFile(join(fixture.repositoryRoots["task-app"], "src", "app.txt"), "candidate\n", "utf8");

      const error = await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture, {
          repository: "task-app",
          repositoryRoot: fixture.repositoryRoots["task-app"],
          base: fixture.baseShas["task-app"],
          registryBase: staleRegistryBase,
        })),
        "REGISTRY_BASE_UNTRUSTED",
      );

      assert.equal(error.expected, trustedRegistryBase);
      assert.equal(error.actual, staleRegistryBase);
    });
  });

  await context.test("отсутствующий master завершает план fail closed", async () => {
    await withWorkspace({}, async (fixture) => {
      await git(fixture.repositoryRoot, ["branch", "-m", "main"]);

      const error = await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture)),
        "TRUSTED_TARGET_REF_MISSING",
      );

      assert.equal(error.expected, "refs/heads/master");
    });
  });
});

test("не позволяет candidate менять доверенную регистрацию репозитория", async (context) => {
  const cases = [
    {
      name: "owner",
      code: "REGISTRY_OWNER_CHANGED",
      mutate(registry) {
        registry.ownerRepository = "task-app";
        registry.repositories["task-registry"].revision = placeholderRevision;
        delete registry.repositories["task-app"].revision;
      },
    },
    {
      name: "root",
      code: "REPOSITORY_REGISTRATION_CHANGED",
      mutate(registry) {
        registry.repositories["task-app"].root = "../task-other";
      },
    },
    {
      name: "manifest",
      code: "REPOSITORY_REGISTRATION_CHANGED",
      mutate(registry) {
        registry.repositories["task-app"].manifest = "verification-next.json";
      },
    },
    {
      name: "status",
      code: "REPOSITORY_STATE_INVALID",
      mutate(registry) {
        registry.repositories["task-app"].status = "reserved";
      },
    },
    {
      name: "enrollment",
      code: "REPOSITORY_REGISTRATION_CHANGED",
      mutate(registry) {
        registry.repositories["task-app"].enrollment = "pending";
        delete registry.repositories["task-app"].manifest;
        delete registry.repositories["task-app"].revision;
      },
    },
  ];

  for (const mutation of cases) {
    await context.test(mutation.name, async () => {
      const ownerMutation = mutation.name === "owner";
      const repositories = ownerMutation
        ? ["task-registry", "task-app", "task-other"]
        : ["task-app", "task-other"];
      await withWorkspace({ repositories }, async (fixture) => {
        const registry = JSON.parse(await readFile(fixture.workspacePath, "utf8"));
        mutation.mutate(registry);
        await writeJson(fixture.workspacePath, registry);

        await rejectsVerificationCode(
          buildVerificationPlan(ownerMutation
            ? planInput(fixture, {
              repository: "task-app",
              repositoryRoot: fixture.repositoryRoots["task-app"],
              base: fixture.baseShas["task-app"],
              registryBase: fixture.baseShas["task-registry"],
            })
            : planInput(fixture)),
          mutation.code,
        );
      });
    });
  }
});

test("owner-task защищает регистрацию unrelated enrolled репозитория", async (context) => {
  async function rejectOwnerMutation(mutate) {
    await withWorkspace({
      repositories: ["task-registry", "task-app", "task-unrelated"],
    }, async (fixture) => {
      const registry = JSON.parse(await readFile(fixture.workspacePath, "utf8"));
      mutate(registry);
      await writeJson(fixture.workspacePath, registry);

      await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture, {
          repository: "task-registry",
          repositoryRoot: fixture.repositoryRoots["task-registry"],
          base: fixture.baseShas["task-registry"],
        })),
        "REPOSITORY_REGISTRATION_CHANGED",
      );
    });
  }

  await context.test("изменение root", async () => {
    await rejectOwnerMutation((registry) => {
      registry.repositories["task-unrelated"].root = "../task-unrelated-moved";
    });
  });

  await context.test("удаление регистрации", async () => {
    await rejectOwnerMutation((registry) => {
      delete registry.repositories["task-unrelated"];
    });
  });

  await context.test("reserved/enrolled состояние unrelated репозитория", async () => {
    await withWorkspace({
      repositories: ["task-registry", "task-app", "task-unrelated"],
    }, async (fixture) => {
      const registry = JSON.parse(await readFile(fixture.workspacePath, "utf8"));
      registry.repositories["task-unrelated"].status = "reserved";
      await writeJson(fixture.workspacePath, registry);

      await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture, {
          repository: "task-registry",
          repositoryRoot: fixture.repositoryRoots["task-registry"],
          base: fixture.baseShas["task-registry"],
        })),
        "REPOSITORY_STATE_INVALID",
      );
    });
  });
});

test("owner-task подключает pending репозиторий только из чистого committed manifest", async (context) => {
  const relation = {
    id: "new-shared-contract",
    producer: { repository: "task-new", export: "shared" },
    consumer: { repository: "task-consumer", input: "shared" },
    type: "generated",
    verifier: { kind: "action", repository: "task-registry", action: "relation-verify" },
  };

  function ownerManifest() {
    return repositoryManifest("task-registry", {
      actions: {
        "owner-unit": automaticAction(["node", "--test", "owner.test.mjs"]),
        "relation-verify": automaticAction(["node", "--test", "relation.test.mjs"]),
        "repository-full": automaticAction(["npm", "test"]),
      },
      areas: {
        registry: {
          paths: ["src/**", "workspace-verification.json"],
          dependsOn: [],
          coverage: {
            affected: ["owner-unit"],
            testing: ["owner-unit"],
            pr: ["owner-unit", "repository-full"],
            release: ["owner-unit", "repository-full"],
          },
        },
      },
    });
  }

  function pendingManifest() {
    return repositoryManifest("task-new", {
      actions: {
        "target-unit": automaticAction(["node", "--test", "target.test.mjs"]),
        "target-full": automaticAction(["npm", "test"]),
        "target-meta": automaticAction(["npm", "run", "meta:check"]),
      },
      areas: {
        contract: {
          paths: ["src/**", "contracts/**"],
          dependsOn: [],
          coverage: {
            affected: ["target-unit"],
            testing: ["target-unit"],
            pr: ["target-unit", "target-full"],
            release: ["target-unit", "target-full"],
          },
        },
      },
      boundaries: {
        "repository-full": { actions: ["target-full"] },
      },
      metaGate: {
        actions: ["target-meta"],
        profiles: ["affected", "testing", "pr", "release"],
      },
      exports: { shared: { paths: ["contracts/**"] } },
    });
  }

  function consumerManifest() {
    return repositoryManifest("task-consumer", {
      actions: {
        "consumer-unit": automaticAction(["node", "--test", "consumer.test.mjs"]),
        "repository-full": automaticAction(["npm", "test"]),
      },
      areas: {
        contract: {
          paths: ["src/**", "contracts/**"],
          dependsOn: [],
          coverage: {
            affected: ["consumer-unit"],
            testing: ["consumer-unit"],
            pr: ["consumer-unit", "repository-full"],
            release: ["consumer-unit", "repository-full"],
          },
        },
      },
      inputs: { shared: { paths: ["contracts/**"] } },
    });
  }

  function enrollmentOptions() {
    return {
      repositories: ["task-registry", "task-new", "task-consumer"],
      manifests: {
        "task-registry": ownerManifest(),
        "task-new": pendingManifest(),
        "task-consumer": consumerManifest(),
      },
      workspace: {
        repositories: {
          "task-registry": {
            status: "active",
            enrollment: "enrolled",
            root: ".",
            manifest: "task-verification.json",
          },
          "task-new": {
            status: "active",
            enrollment: "pending",
            root: "../task-new",
          },
          "task-consumer": {
            status: "active",
            enrollment: "enrolled",
            root: "../task-consumer",
            manifest: "task-verification.json",
          },
        },
        relations: [structuredClone(relation)],
      },
    };
  }

  async function enableEnrollment(fixture) {
    const registry = JSON.parse(await readFile(fixture.workspacePath, "utf8"));
    registry.repositories["task-new"].enrollment = "enrolled";
    registry.repositories["task-new"].manifest = "task-verification.json";
    registry.repositories["task-new"].revision = (
      await git(fixture.repositoryRoots["task-new"], ["rev-parse", "HEAD"])
    ).stdout.trim();
    await writeJson(fixture.workspacePath, registry);
  }

  function ownerPlanInput(fixture) {
    return planInput(fixture, {
      repository: "task-registry",
      repositoryRoot: fixture.repositoryRoots["task-registry"],
      base: fixture.baseShas["task-registry"],
    });
  }

  await context.test("missing manifest", async () => {
    await withWorkspace(enrollmentOptions(), async (fixture) => {
      await rm(join(fixture.repositoryRoots["task-new"], "task-verification.json"));
      await enableEnrollment(fixture);

      await rejectsVerificationCode(
        buildVerificationPlan(ownerPlanInput(fixture)),
        "MANIFEST_MISSING",
      );
    });
  });

  await context.test("invalid manifest", async () => {
    await withWorkspace(enrollmentOptions(), async (fixture) => {
      await writeJson(join(fixture.repositoryRoots["task-new"], "task-verification.json"), {});
      await enableEnrollment(fixture);

      await rejectsVerificationCode(
        buildVerificationPlan(ownerPlanInput(fixture)),
        "INVALID_CONFIG",
      );
    });
  });

  await context.test("ignored untracked manifest", async () => {
    await withWorkspace(enrollmentOptions(), async (fixture) => {
      const targetRoot = fixture.repositoryRoots["task-new"];
      await rm(join(targetRoot, "task-verification.json"));
      await writeFile(join(targetRoot, ".gitignore"), "task-verification.json\n", "utf8");
      await commitAll(targetRoot, "manifest removed from HEAD");
      await writeJson(join(targetRoot, "task-verification.json"), pendingManifest());
      await enableEnrollment(fixture);

      await rejectsVerificationCode(
        buildVerificationPlan(ownerPlanInput(fixture)),
        "ENROLLMENT_NOT_READY",
      );
    });
  });

  await context.test("dirty manifest", async () => {
    await withWorkspace(enrollmentOptions(), async (fixture) => {
      const dirtyManifest = pendingManifest();
      dirtyManifest.$schema = "./candidate.schema.json";
      await writeJson(join(fixture.repositoryRoots["task-new"], "task-verification.json"), dirtyManifest);
      await enableEnrollment(fixture);

      await rejectsVerificationCode(
        buildVerificationPlan(ownerPlanInput(fixture)),
        "ENROLLMENT_NOT_READY",
      );
    });
  });

  await context.test("clean committed transition расширяет полный связанный план", async () => {
    await withWorkspace(enrollmentOptions(), async (fixture) => {
      await enableEnrollment(fixture);

      const plan = await buildVerificationPlan(ownerPlanInput(fixture));
      const actions = actionIdSet(plan);

      assert.equal(plan.outcome, "planned");
      assert.ok(actions.has("task-new:target-full"));
      assert.ok(actions.has("task-new:target-meta"));
      assert.ok(actions.has("task-registry:relation-verify"));
      assert.ok(actions.has("task-consumer:consumer-unit"));
      assert.deepEqual(
        plan.enrollmentEvidence.map((evidence) => evidence.repository),
        ["task-new"],
      );
      assert.ok(reasonCodeSet(plan).has("ENROLLMENT_FULL_BOUNDARY"));
      assert.ok(reasonCodeSet(plan).has("ENROLLMENT_META_GATE"));
      assert.ok(reasonCodeSet(plan).has("CROSS_REPOSITORY_RELATION"));
      assert.ok(reasonCodeSet(plan).has("CROSS_REPOSITORY_INPUT"));
      const verifier = plan.actions.find(
        (action) => action.repository === "task-registry" && action.id === "relation-verify",
      );
      assert.ok(verifier.reasons.some(
        (reason) => reason.code === "CROSS_REPOSITORY_RELATION"
          && reason.relation === "new-shared-contract"
          && reason.provenance === "candidate",
      ));
    });
  });
});

test("owner-task безопасно переводит закреплённую revision", async (context) => {
  const relation = {
    id: "service-contract",
    producer: { repository: "task-service", export: "shared" },
    consumer: { repository: "task-consumer", input: "shared" },
    type: "generated",
    verifier: { kind: "action", repository: "task-registry", action: "relation-verify" },
  };

  function ownerManifest() {
    return repositoryManifest("task-registry", {
      actions: {
        "owner-unit": automaticAction(["node", "--test", "owner.test.mjs"]),
        "relation-verify": automaticAction(["node", "--test", "relation.test.mjs"]),
        "repository-full": automaticAction(["npm", "test"]),
      },
      areas: {
        registry: {
          paths: ["src/**", "workspace-verification.json"],
          dependsOn: [],
          coverage: {
            affected: ["owner-unit"],
            testing: ["owner-unit"],
            pr: ["owner-unit", "repository-full"],
            release: ["owner-unit", "repository-full"],
          },
        },
      },
    });
  }

  function serviceManifest(version) {
    const unit = `service-unit-${version}`;
    const full = `service-full-${version}`;
    const meta = `service-meta-${version}`;
    return repositoryManifest("task-service", {
      actions: {
        [unit]: automaticAction(["node", "--test", `service-${version}.test.mjs`]),
        [full]: automaticAction(["npm", "test", "--", version]),
        [meta]: automaticAction(["npm", "run", `meta:${version}`]),
      },
      areas: {
        service: {
          paths: ["src/**", "contracts/**", "task-verification.json"],
          dependsOn: [],
          coverage: {
            affected: [unit],
            testing: [unit],
            pr: [unit, full],
            release: [unit, full],
          },
        },
      },
      boundaries: { "repository-full": { actions: [full] } },
      metaGate: {
        actions: [meta],
        profiles: ["affected", "testing", "pr", "release"],
      },
      exports: { shared: { paths: ["contracts/shared.json"] } },
    });
  }

  function consumerManifest() {
    return repositoryManifest("task-consumer", {
      actions: {
        "consumer-unit": automaticAction(["node", "--test", "consumer.test.mjs"]),
        "repository-full": automaticAction(["npm", "test"]),
      },
      areas: {
        consumer: {
          paths: ["src/**", "contracts/**"],
          dependsOn: [],
          coverage: {
            affected: ["consumer-unit"],
            testing: ["consumer-unit"],
            pr: ["consumer-unit", "repository-full"],
            release: ["consumer-unit", "repository-full"],
          },
        },
      },
      inputs: { shared: { paths: ["contracts/shared.json"] } },
    });
  }

  function transitionOptions(extraRepositories = []) {
    return {
      repositories: ["task-registry", "task-service", "task-consumer", ...extraRepositories],
      manifests: {
        "task-registry": ownerManifest(),
        "task-service": serviceManifest("a"),
        "task-consumer": consumerManifest(),
      },
      workspace: { relations: [structuredClone(relation)] },
    };
  }

  function ownerPlanInput(fixture, base = fixture.baseShas["task-registry"]) {
    return planInput(fixture, {
      repository: "task-registry",
      repositoryRoot: fixture.repositoryRoots["task-registry"],
      base,
    });
  }

  async function writePinnedRevision(fixture, revision, mutate = () => {}) {
    const registry = JSON.parse(await readFile(fixture.workspacePath, "utf8"));
    registry.repositories["task-service"].revision = revision;
    mutate(registry.repositories["task-service"]);
    await writeJson(fixture.workspacePath, registry);
  }

  async function advanceService(fixture, message = "service revision B") {
    const serviceRoot = fixture.repositoryRoots["task-service"];
    await writeJson(join(serviceRoot, "task-verification.json"), serviceManifest("b"));
    await writeFile(join(serviceRoot, "src", "app.txt"), `${message}\n`, "utf8");
    return await commitAll(serviceRoot, message);
  }

  await context.test("прямое продвижение включает обе версии полного контура", async () => {
    await withWorkspace(transitionOptions(), async (fixture) => {
      const revisionA = fixture.baseShas["task-service"];
      const revisionB = await advanceService(fixture);
      await writePinnedRevision(fixture, revisionB);

      const plan = await buildVerificationPlan(ownerPlanInput(fixture));
      const evidence = plan.revisionEvidence[0];
      const actions = actionIdSet(plan);

      assert.equal(plan.outcome, "planned");
      assert.equal(evidence.baseRevision, revisionA);
      assert.equal(evidence.candidateRevision, revisionB);
      assert.equal(evidence.direction, "forward");
      assert.match(evidence.baseManifestSha256, /^[0-9a-f]{64}$/u);
      assert.match(evidence.candidateManifestSha256, /^[0-9a-f]{64}$/u);
      assert.equal(evidence.targetAuthority.mergeBaseSha, revisionB);
      assert.equal(plan.snapshots["task-service"].baseSha, revisionA);
      assert.equal(plan.snapshots["task-service"].headSha, revisionB);
      assert.ok(changedPathSet(plan.snapshots["task-service"]).has("task-verification.json"));
      assert.ok(changedPathSet(plan.snapshots["task-service"]).has("src/app.txt"));
      for (const action of [
        "task-service:service-full-a",
        "task-service:service-full-b",
        "task-service:service-meta-a",
        "task-service:service-meta-b",
        "task-registry:relation-verify",
        "task-consumer:consumer-unit",
      ]) {
        assert.ok(actions.has(action), `не выбрано действие ${action}`);
      }
      assert.ok(reasonCodeSet(plan).has("REVISION_FULL_BOUNDARY"));
      assert.ok(reasonCodeSet(plan).has("REVISION_META_GATE"));
      const report = formatHumanReport(plan);
      assert.ok(report.includes(`Переход revision task-service: ${revisionA} -> ${revisionB} (forward)`));
      assert.ok(report.includes(`Доверенная база: ${fixture.baseShas["task-registry"]}`));
      const verifier = plan.actions.find((action) => action.id === "relation-verify");
      assert.deepEqual(
        new Set(verifier.reasons
          .filter((reason) => reason.code === "CROSS_REPOSITORY_RELATION")
          .map((reason) => reason.provenance)),
        new Set(["base", "candidate"]),
      );
    });
  });

  await context.test("переход revision не маскирует пустое локальное покрытие владельца", async () => {
    const options = transitionOptions();
    options.manifests["task-registry"].areas.registry.coverage = {
      affected: [],
      testing: [],
      pr: ["repository-full"],
      release: ["repository-full"],
    };
    await withWorkspace(options, async (fixture) => {
      const revisionB = await advanceService(fixture);
      await writePinnedRevision(fixture, revisionB);

      const plan = await buildVerificationPlan(ownerPlanInput(fixture));

      assert.equal(plan.outcome, "requires_boundary");
      assert.ok(plan.fallbackIssues.some((issue) => issue.code === "EMPTY_SELECTION"));
      assert.ok(actionIdSet(plan).has("task-service:service-full-a"));
      assert.ok(actionIdSet(plan).has("task-service:service-full-b"));
    });
  });

  await context.test("exact-copy читает base из A, а candidate из B", async () => {
    const options = transitionOptions();
    options.workspace.relations = [{ ...structuredClone(relation), type: "exact-copy" }];
    await withWorkspace(options, async (fixture) => {
      const serviceContract = join(
        fixture.repositoryRoots["task-service"],
        "contracts",
        "shared.json",
      );
      const consumerContract = join(
        fixture.repositoryRoots["task-consumer"],
        "contracts",
        "shared.json",
      );
      await mkdir(dirname(serviceContract), { recursive: true });
      await mkdir(dirname(consumerContract), { recursive: true });
      await writeFile(serviceContract, "old contract\n", "utf8");
      await writeFile(consumerContract, "old contract\n", "utf8");
      const revisionA = await commitAll(
        fixture.repositoryRoots["task-service"],
        "service contract A",
      );
      const consumerRevision = await commitAll(
        fixture.repositoryRoots["task-consumer"],
        "consumer contract A",
      );
      const trustedRegistry = JSON.parse(await readFile(fixture.workspacePath, "utf8"));
      trustedRegistry.repositories["task-service"].revision = revisionA;
      trustedRegistry.repositories["task-consumer"].revision = consumerRevision;
      await writeJson(fixture.workspacePath, trustedRegistry);
      const registryBase = await commitAll(
        fixture.repositoryRoots["task-registry"],
        "pin exact-copy contract A",
      );

      await writeFile(serviceContract, "new contract\n", "utf8");
      const revisionB = await advanceService(fixture, "service contract B");
      await writePinnedRevision(fixture, revisionB);

      const plan = await buildVerificationPlan(ownerPlanInput(fixture, registryBase));
      const evidenceBySource = new Map(
        plan.relationEvidence.map((evidence) => [evidence.provenance, evidence]),
      );

      assert.equal(plan.outcome, "blocked");
      assert.equal(evidenceBySource.get("base")?.code, "EXACT_COPY_EQUAL");
      assert.equal(evidenceBySource.get("candidate")?.code, "EXACT_COPY_DIFFERENT");
      assert.equal(plan.snapshots["task-service"].baseSha, revisionA);
      assert.equal(plan.snapshots["task-service"].headSha, revisionB);
    });
  });

  await context.test("откат к предку сохраняет старую и новую версии", async () => {
    await withWorkspace(transitionOptions(), async (fixture) => {
      const revisionA = fixture.baseShas["task-service"];
      const revisionB = await advanceService(fixture);
      await writePinnedRevision(fixture, revisionB);
      const registryBase = await commitAll(fixture.repositoryRoots["task-registry"], "pin service revision B");
      await git(fixture.repositoryRoots["task-service"], ["switch", "--detach", revisionA]);
      await writePinnedRevision(fixture, revisionA);

      const plan = await buildVerificationPlan(ownerPlanInput(fixture, registryBase));
      const evidence = plan.revisionEvidence[0];

      assert.equal(plan.outcome, "planned");
      assert.equal(evidence.baseRevision, revisionB);
      assert.equal(evidence.candidateRevision, revisionA);
      assert.equal(evidence.direction, "rollback");
      assert.equal(plan.snapshots["task-service"].baseSha, revisionB);
      assert.equal(plan.snapshots["task-service"].headSha, revisionA);
    });
  });

  await context.test("незалитая ветка не становится закреплённой revision", async () => {
    await withWorkspace(transitionOptions(), async (fixture) => {
      const serviceRoot = fixture.repositoryRoots["task-service"];
      await git(serviceRoot, ["switch", "-c", "unreleased"]);
      const revisionB = await advanceService(fixture, "unreleased service revision");
      await writePinnedRevision(fixture, revisionB);

      await rejectsVerificationCode(
        buildVerificationPlan(ownerPlanInput(fixture)),
        "REVISION_TARGET_UNTRUSTED",
      );
    });
  });

  await context.test("несовпадающий HEAD и грязный checkout отклоняются", async (transitionContext) => {
    await transitionContext.test("HEAD не равен новой revision", async () => {
      await withWorkspace(transitionOptions(), async (fixture) => {
        const revisionB = await advanceService(fixture);
        await writePinnedRevision(fixture, revisionB);
        await writeFile(join(fixture.repositoryRoots["task-service"], "src", "later.txt"), "later\n", "utf8");
        const revisionC = await commitAll(fixture.repositoryRoots["task-service"], "service revision C");

        const error = await rejectsVerificationCode(
          buildVerificationPlan(ownerPlanInput(fixture)),
          "REVISION_TRANSITION_NOT_READY",
        );
        assert.equal(error.expected, revisionB);
        assert.equal(error.actual, revisionC);
      });
    });

    await transitionContext.test("checkout новой revision содержит локальные изменения", async () => {
      await withWorkspace(transitionOptions(), async (fixture) => {
        const revisionB = await advanceService(fixture);
        await writePinnedRevision(fixture, revisionB);
        await writeFile(join(fixture.repositoryRoots["task-service"], "src", "app.txt"), "dirty\n", "utf8");

        const error = await rejectsVerificationCode(
          buildVerificationPlan(ownerPlanInput(fixture)),
          "REVISION_TRANSITION_NOT_READY",
        );
        assert.match(error.details.snapshotFingerprint, /^[0-9a-f]{64}$/u);
      });
    });
  });

  await context.test("расходящиеся выпущенные версии не образуют переход", async () => {
    await withWorkspace(transitionOptions(), async (fixture) => {
      const serviceRoot = fixture.repositoryRoots["task-service"];
      const common = fixture.baseShas["task-service"];
      await git(serviceRoot, ["switch", "-c", "old-release", common]);
      await writeFile(join(serviceRoot, "src", "old.txt"), "old branch\n", "utf8");
      const revisionA = await commitAll(serviceRoot, "old released revision");
      await writePinnedRevision(fixture, revisionA);
      const registryBase = await commitAll(fixture.repositoryRoots["task-registry"], "pin old released revision");

      await git(serviceRoot, ["switch", "master"]);
      await git(serviceRoot, ["switch", "-c", "candidate-release", common]);
      await writeFile(join(serviceRoot, "src", "candidate.txt"), "candidate branch\n", "utf8");
      const revisionB = await commitAll(serviceRoot, "candidate released revision");
      await git(serviceRoot, ["switch", "master"]);
      for (const branch of ["old-release", "candidate-release"]) {
        await git(serviceRoot, [
          "-c", "user.name=W Verify Test",
          "-c", "user.email=task-verify@example.test",
          "merge", "--no-ff", branch, "-m", `merge ${branch}`,
        ]);
      }
      await git(serviceRoot, ["switch", "--detach", revisionB]);
      await writePinnedRevision(fixture, revisionB);

      await rejectsVerificationCode(
        buildVerificationPlan(ownerPlanInput(fixture, registryBase)),
        "REVISION_TRANSITION_DIVERGED",
      );
    });
  });

  await context.test("чужая задача и смешанное изменение регистрации отклоняются", async (transitionContext) => {
    await transitionContext.test("чужая задача меняет revision", async () => {
      await withWorkspace(transitionOptions(["task-app"]), async (fixture) => {
        const revisionB = await advanceService(fixture);
        await writePinnedRevision(fixture, revisionB);

        await rejectsVerificationCode(
          buildVerificationPlan(planInput(fixture, {
            repository: "task-app",
            repositoryRoot: fixture.repositoryRoots["task-app"],
            base: fixture.baseShas["task-app"],
            registryBase: fixture.baseShas["task-registry"],
          })),
          "REPOSITORY_REGISTRATION_CHANGED",
        );
      });
    });

    await transitionContext.test("revision меняется вместе с manifest", async () => {
      await withWorkspace(transitionOptions(), async (fixture) => {
        const revisionB = await advanceService(fixture);
        await writePinnedRevision(fixture, revisionB, (registration) => {
          registration.manifest = "next-verification.json";
        });

        await rejectsVerificationCode(
          buildVerificationPlan(ownerPlanInput(fixture)),
          "REPOSITORY_REGISTRATION_CHANGED",
        );
      });
    });
  });
});

test("чужая задача требует неизменные bytes registry owner", async (context) => {
  const buildSelectedPlan = async (fixture) => await buildVerificationPlan(planInput(fixture, {
    repository: "task-app",
    repositoryRoot: fixture.repositoryRoots["task-app"],
    base: fixture.baseShas["task-app"],
    registryBase: fixture.baseShas["task-registry"],
  }));

  await context.test("registry bytes совпадают с registryBase", async () => {
    await withWorkspace({ repositories: ["task-registry", "task-app"] }, async (fixture) => {
      await writeFile(join(fixture.repositoryRoots["task-app"], "src", "app.txt"), "candidate\n", "utf8");

      const plan = await buildSelectedPlan(fixture);

      assert.equal(plan.outcome, "planned");
      assert.ok(actionIdSet(plan).has("task-app:unit"));
    });
  });

  await context.test("candidate registry bytes отличаются от registryBase", async () => {
    await withWorkspace({ repositories: ["task-registry", "task-app"] }, async (fixture) => {
      const registryBytes = await readFile(fixture.workspacePath, "utf8");
      await writeFile(fixture.workspacePath, `${registryBytes}\n`, "utf8");
      await writeFile(join(fixture.repositoryRoots["task-app"], "src", "app.txt"), "candidate\n", "utf8");

      await rejectsVerificationCode(
        buildSelectedPlan(fixture),
        "REGISTRY_CONFOUNDER",
      );
    });
  });
});

test("изменённый путь сохраняет проверки base policy и добавляет candidate policy", async () => {
  const manifest = repositoryManifest("task-app", {
    actions: {
      strict: automaticAction(["node", "--version"]),
      weak: automaticAction(["node", "--version"]),
      "repository-full": automaticAction(["node", "--version"]),
    },
    areas: {
      code: {
        paths: ["src/**", "task-verification.json"],
        dependsOn: [],
        coverage: {
          affected: ["strict"],
          testing: ["strict"],
          pr: ["strict", "repository-full"],
          release: ["strict", "repository-full"],
        },
      },
    },
  });
  await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
    const candidate = structuredClone(manifest);
    candidate.areas.code.coverage = {
      affected: ["weak"],
      testing: ["weak"],
      pr: ["weak", "repository-full"],
      release: ["weak", "repository-full"],
    };
    await writeJson(join(fixture.repositoryRoot, "task-verification.json"), candidate);
    await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "changed\n", "utf8");

    const plan = await buildVerificationPlan(planInput(fixture));
    const strict = plan.actions.find((action) => action.id === "strict");
    const weak = plan.actions.find((action) => action.id === "weak");

    assert.ok(actionIdSet(plan).has("task-app:strict"), "base policy должна сохраниться");
    assert.ok(actionIdSet(plan).has("task-app:weak"), "candidate policy должна добавиться");
    assert.ok(strict.reasons.some((reason) => reason.manifestSource === "base"));
    assert.ok(weak.reasons.some((reason) => reason.manifestSource === "candidate"));
  });
});

test("блокирует неизвестные ссылки, повтор relation id и немонотонное покрытие", async (context) => {
  await context.test("неизвестная action", async () => {
    const manifest = repositoryManifest("task-app");
    manifest.areas.code.coverage.affected = ["missing"];
    await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
      await rejectsVerificationCode(buildVerificationPlan(planInput(fixture)), "UNKNOWN_ACTION_REF");
    });
  });

  await context.test("повтор relation id", async () => {
    await withWorkspace({
      workspace: {
        relations: [
          {
            id: "same",
            producer: { repository: "task-app", path: "src/app.txt" },
            consumer: { repository: "task-app", input: "copy" },
            type: "generated",
            verifier: { kind: "action", repository: "task-app", action: "unit" },
          },
          {
            id: "same",
            producer: { repository: "task-app", path: "src/app.txt" },
            consumer: { repository: "task-app", input: "copy" },
            type: "generated",
            verifier: { kind: "action", repository: "task-app", action: "unit" },
          },
        ],
      },
    }, async (fixture) => {
      await rejectsVerificationCode(buildVerificationPlan(planInput(fixture)), "DUPLICATE_RELATION_ID");
    });
  });

  await context.test("нарушение affected ⊆ testing ⊆ pr ⊆ release", async () => {
    const manifest = repositoryManifest("task-app");
    manifest.areas.code.coverage.testing = [];
    await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
      await rejectsVerificationCode(buildVerificationPlan(planInput(fixture)), "COVERAGE_NOT_MONOTONIC");
    });
  });
});

test("fallbackBoundary обязана входить в coverage pr и release", async (context) => {
  for (const profile of ["pr", "release"]) {
    await context.test(profile, () => {
      const manifest = repositoryManifest("task-app");
      manifest.areas.code.coverage[profile] = ["unit"];
      throwsVerificationCode(
        () => validateRepositoryManifest(manifest),
        "BOUNDARY_COVERAGE_MISSING",
      );
    });
  }
});

test("metaGate profiles монотонны по цепочке профилей", async (context) => {
  await context.test("affected без последующих профилей отвергается", () => {
    const manifest = repositoryManifest("task-app");
    manifest.actions.meta = automaticAction(["npm", "run", "meta:check"]);
    manifest.metaGate = {
      actions: ["meta"],
      profiles: ["affected"],
    };

    const error = throwsVerificationCode(
      () => validateRepositoryManifest(manifest),
      "META_GATE_NOT_MONOTONIC",
    );
    assert.equal(error.path, "task-verification.json.metaGate.profiles");
  });

  await context.test("upward-closed список включает meta-action во всех последующих профилях", async () => {
    const manifest = repositoryManifest("task-app");
    manifest.actions.meta = automaticAction(["npm", "run", "meta:check"]);
    manifest.metaGate = {
      actions: ["meta"],
      profiles: ["testing", "pr", "release"],
    };
    await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "candidate\n", "utf8");

      for (const profile of ["testing", "pr", "release"]) {
        const plan = await buildVerificationPlan(planInput(fixture, { profile }));
        assert.ok(
          actionIdSet(plan).has("task-app:meta"),
          `meta-action обязана сохраняться в профиле ${profile}`,
        );
      }
      const affected = await buildVerificationPlan(planInput(fixture, { profile: "affected" }));
      assert.equal(actionIdSet(affected).has("task-app:meta"), false);
    });
  });
});

test("отвергает unknown additional properties во всех ключевых типах", async (context) => {
  const repositoryCases = [
    ["repository manifest", (manifest) => { manifest.unexpected = true; }],
    ["policy", (manifest) => { manifest.policy.unexpected = true; }],
    ["automatic action", (manifest) => { manifest.actions.unit.unexpected = true; }],
    ["obligation action", (manifest) => {
      manifest.actions.approval = obligationAction({ unexpected: true });
    }],
    ["area", (manifest) => { manifest.areas.code.unexpected = true; }],
    ["coverage", (manifest) => { manifest.areas.code.coverage.unexpected = []; }],
    ["boundary", (manifest) => { manifest.boundaries["repository-full"].unexpected = true; }],
    ["metaGate", (manifest) => { manifest.metaGate.unexpected = true; }],
    ["artifact surface", (manifest) => {
      manifest.exports.shared = { paths: ["src/app.txt"], unexpected: true };
    }],
  ];

  for (const [name, mutate] of repositoryCases) {
    await context.test(name, () => {
      const manifest = repositoryManifest("task-app");
      mutate(manifest);
      throwsVerificationCode(
        () => validateRepositoryManifest(manifest),
        "INVALID_CONFIG",
      );
    });
  }

  const relation = {
    id: "shared-contract",
    producer: { repository: "task-app", export: "shared" },
    consumer: { repository: "task-consumer", input: "shared" },
    type: "generated",
    verifier: { kind: "action", repository: "task-app", action: "unit" },
  };
  const exception = {
    id: "temporary-overlap",
    version: 1,
    scope: { repository: "task-app", path: "src/**" },
    owner: "platform-team",
    reason: "Переходное пересечение путей",
    expiresAt: "2999-12-31",
  };
  const workspaceCases = [
    ["workspace registry", (registry) => { registry.unexpected = true; }],
    ["repository registration", (registry) => {
      registry.repositories["task-app"].unexpected = true;
    }],
    ["relation", (registry) => { registry.relations[0].unexpected = true; }],
    ["producer endpoint", (registry) => { registry.relations[0].producer.unexpected = true; }],
    ["consumer endpoint", (registry) => { registry.relations[0].consumer.unexpected = true; }],
    ["action verifier", (registry) => { registry.relations[0].verifier.unexpected = true; }],
    ["obligation verifier", (registry) => {
      registry.relations[0].verifier = {
        kind: "obligation",
        obligationType: "manual",
        reason: "Нужна ручная сверка",
        unexpected: true,
      };
    }],
    ["exception", (registry) => { registry.exceptions[0].unexpected = true; }],
    ["exception scope", (registry) => { registry.exceptions[0].scope.unexpected = true; }],
  ];

  for (const [name, mutate] of workspaceCases) {
    await context.test(name, () => {
      const registry = workspaceManifest(["task-app", "task-consumer"], {
        relations: [structuredClone(relation)],
        exceptions: [structuredClone(exception)],
      });
      mutate(registry);
      throwsVerificationCode(
        () => validateWorkspaceRegistry(registry),
        "INVALID_CONFIG",
      );
    });
  }
});

test("отвергает relation-scope исключения в первой версии registry", () => {
  const registry = workspaceManifest(["task-app"], {
    exceptions: [{
      id: "relation-overlap",
      version: 1,
      scope: { relation: "shared-contract" },
      owner: "platform-team",
      reason: "В первой версии такой scope не поддерживается",
      expiresAt: "2999-12-31",
    }],
  });

  throwsVerificationCode(
    () => validateWorkspaceRegistry(registry),
    "INVALID_CONFIG",
  );
});

test("именованные contract surfaces обязаны принадлежать области", async (context) => {
  for (const collection of ["exports", "inputs"]) {
    await context.test(collection, () => {
      const manifest = repositoryManifest("task-app");
      manifest[collection].shared = { paths: ["contracts/**"] };

      const error = throwsVerificationCode(
        () => validateRepositoryManifest(manifest),
        "CONTRACT_SURFACE_UNOWNED",
      );
      assert.equal(error.details.collection, collection);
      assert.equal(error.details.surface, "shared");
    });
  }
});

test("строгая валидация glob, endpoint, root, argv и manifest path", async (context) => {
  for (const [name, pattern] of [
    ["bad segments", "src//bad.js"],
    ["character class", "src/[ab].js"],
    ["brace", "src/{a,b}.js"],
    ["extglob", "src/@(a|b).js"],
  ]) {
    await context.test(name, () => {
      const manifest = repositoryManifest("task-app");
      manifest.areas.code.paths = [pattern];

      const error = throwsVerificationCode(
        () => validateRepositoryManifest(manifest),
        "INVALID_GLOB",
      );
      assert.equal(error.path, "task-verification.json.areas.code.paths[0]");
      assert.equal(error.actual, pattern);
    });
  }

  await context.test("consumer.path запрещён", () => {
    const registry = workspaceManifest(["task-app", "task-consumer"], {
      relations: [{
        id: "bad-consumer-path",
        producer: { repository: "task-app", path: "src/**" },
        consumer: { repository: "task-consumer", path: "src/**" },
        type: "generated",
        verifier: { kind: "action", repository: "task-app", action: "unit" },
      }],
    });

    const error = throwsVerificationCode(
      () => validateWorkspaceRegistry(registry),
      "INVALID_CONFIG",
    );
    assert.equal(error.path, "workspace-verification.json.relations[0].consumer");
  });

  await context.test("отсутствующий repositoryRoot имеет типизированную ошибку", async () => {
    await withWorkspace({}, async (fixture) => {
      const missingRoot = join(fixture.workspaceRoot, "missing-checkout");
      const error = await rejectsVerificationCode(
        collectGitChanges({ repositoryRoot: missingRoot, base: fixture.baseSha }),
        "REPOSITORY_ROOT_MISSING",
      );
      assert.equal(error.path, missingRoot);
    });
  });

  await context.test("повторы и пустой не первый argv допустимы", () => {
    const manifest = repositoryManifest("task-app");
    manifest.actions.unit.argv = ["node", "--flag", "--flag", ""];

    assert.equal(validateRepositoryManifest(manifest), manifest);
  });

  await context.test("пустой первый argv запрещён", () => {
    const manifest = repositoryManifest("task-app");
    manifest.actions.unit.argv = ["", "--version"];

    const error = throwsVerificationCode(
      () => validateRepositoryManifest(manifest),
      "INVALID_CONFIG",
    );
    assert.equal(error.path, "task-verification.json.actions.unit.argv[0]");
  });

  await context.test("manifest='.' запрещён", () => {
    const registry = workspaceManifest(["task-app"]);
    registry.repositories["task-app"].manifest = ".";

    const error = throwsVerificationCode(
      () => validateWorkspaceRegistry(registry),
      "UNSAFE_PATH",
    );
    assert.equal(error.path, "workspace-verification.json.repositories.task-app.manifest");
  });
});

test("отвергает точку и underscore в идентификаторах", async (context) => {
  for (const identifier of ["unit.test", "unit_test"]) {
    await context.test(identifier, () => {
      const manifest = repositoryManifest("task-app");
      manifest.actions[identifier] = automaticAction(["node", "--version"]);
      throwsVerificationCode(
        () => validateRepositoryManifest(manifest),
        "INVALID_CONFIG",
      );
    });
  }
});

test("отвергает цикл межрепозиторных relations", () => {
  const registry = workspaceManifest(["task-app", "task-consumer"], {
    relations: [
      {
        id: "app-to-consumer",
        producer: { repository: "task-app", export: "shared" },
        consumer: { repository: "task-consumer", input: "shared" },
        type: "generated",
        verifier: { kind: "action", repository: "task-app", action: "unit" },
      },
      {
        id: "consumer-to-app",
        producer: { repository: "task-consumer", export: "shared" },
        consumer: { repository: "task-app", input: "shared" },
        type: "generated",
        verifier: { kind: "action", repository: "task-consumer", action: "unit" },
      },
    ],
  });

  throwsVerificationCode(
    () => validateWorkspaceRegistry(registry),
    "RELATION_CYCLE",
  );
});

test("отвергает транзитивную цепочку с producer.path", () => {
  const registry = workspaceManifest(["task-app", "task-middle", "task-leaf"], {
    relations: [
      {
        id: "app-to-middle",
        producer: { repository: "task-app", export: "shared" },
        consumer: { repository: "task-middle", input: "shared" },
        type: "generated",
        verifier: { kind: "action", repository: "task-app", action: "unit" },
      },
      {
        id: "middle-to-leaf",
        producer: { repository: "task-middle", path: "generated/**" },
        consumer: { repository: "task-leaf", input: "shared" },
        type: "generated",
        verifier: { kind: "action", repository: "task-middle", action: "unit" },
      },
    ],
  });

  throwsVerificationCode(
    () => validateWorkspaceRegistry(registry),
    "TRANSITIVE_PATH_PRODUCER_UNSUPPORTED",
  );
});

test("локальная reverse dependency активирует принадлежащий ей export и downstream relation", async () => {
  const producer = repositoryManifest("task-a", {
    actions: {
      "a-core": automaticAction(["node", "--test", "core.test.mjs"]),
      "a-api": automaticAction(["node", "--test", "api.test.mjs"]),
      "relation-verify": automaticAction(["node", "--test", "relation.test.mjs"]),
      "repository-full": automaticAction(["npm", "test"]),
    },
    areas: {
      core: {
        paths: ["src/core/**"],
        dependsOn: [],
        coverage: {
          affected: ["a-core"],
          testing: ["a-core"],
          pr: ["a-core", "repository-full"],
          release: ["a-core", "repository-full"],
        },
      },
      api: {
        paths: ["src/api/**"],
        dependsOn: ["core"],
        coverage: {
          affected: ["a-api"],
          testing: ["a-api"],
          pr: ["a-api", "repository-full"],
          release: ["a-api", "repository-full"],
        },
      },
    },
    exports: { api: { paths: ["src/api/**"] } },
  });
  const consumer = repositoryManifest("task-b", {
    actions: {
      "b-input": automaticAction(["node", "--test", "input.test.mjs"]),
      "repository-full": automaticAction(["npm", "test"]),
    },
    areas: {
      input: {
        paths: ["generated/**"],
        dependsOn: [],
        coverage: {
          affected: ["b-input"],
          testing: ["b-input"],
          pr: ["b-input", "repository-full"],
          release: ["b-input", "repository-full"],
        },
      },
    },
    inputs: { api: { paths: ["generated/**"] } },
  });
  const relation = {
    id: "a-api-to-b-input",
    producer: { repository: "task-a", export: "api" },
    consumer: { repository: "task-b", input: "api" },
    type: "generated",
    verifier: { kind: "action", repository: "task-a", action: "relation-verify" },
  };

  await withWorkspace({
    repositories: ["task-a", "task-b"],
    manifests: { "task-a": producer, "task-b": consumer },
    workspace: { relations: [relation] },
  }, async (fixture) => {
    const changedPath = join(fixture.repositoryRoots["task-a"], "src", "core", "value.txt");
    await mkdir(dirname(changedPath), { recursive: true });
    await writeFile(changedPath, "changed\n", "utf8");

    const plan = await buildVerificationPlan(planInput(fixture, { repository: "task-a" }));
    const apiAction = plan.actions.find(
      (action) => action.repository === "task-a" && action.id === "a-api",
    );
    const downstreamAction = plan.actions.find(
      (action) => action.repository === "task-b" && action.id === "b-input",
    );

    assert.equal(plan.outcome, "planned");
    assert.deepEqual(
      [...actionIdSet(plan)].sort(),
      ["task-a:a-api", "task-a:a-core", "task-a:relation-verify", "task-b:b-input"],
    );
    assert.ok(apiAction?.reasons.some(
      (reason) => reason.code === "REVERSE_DEPENDENCY" && reason.area === "api",
    ));
    assert.ok(downstreamAction?.reasons.some(
      (reason) => reason.code === "CROSS_REPOSITORY_INPUT"
        && reason.relation === "a-api-to-b-input"
        && reason.area === "input",
    ));
  });
});

test("локальная reverse dependency активирует принадлежащий ей producer.path relation", async () => {
  const producer = repositoryManifest("task-a", {
    actions: {
      "a-core": automaticAction(["node", "--test", "core.test.mjs"]),
      "a-api": automaticAction(["node", "--test", "api.test.mjs"]),
      "relation-verify": automaticAction(["node", "--test", "relation.test.mjs"]),
      "repository-full": automaticAction(["npm", "test"]),
    },
    areas: {
      core: {
        paths: ["src/**"],
        dependsOn: [],
        coverage: {
          affected: ["a-core"],
          testing: ["a-core"],
          pr: ["a-core", "repository-full"],
          release: ["a-core", "repository-full"],
        },
      },
      api: {
        paths: ["api/**"],
        dependsOn: ["core"],
        coverage: {
          affected: ["a-api"],
          testing: ["a-api"],
          pr: ["a-api", "repository-full"],
          release: ["a-api", "repository-full"],
        },
      },
    },
  });
  const consumer = repositoryManifest("task-b", {
    actions: {
      "b-input": automaticAction(["node", "--test", "input.test.mjs"]),
      "repository-full": automaticAction(["npm", "test"]),
    },
    areas: {
      input: {
        paths: ["generated/**"],
        dependsOn: [],
        coverage: {
          affected: ["b-input"],
          testing: ["b-input"],
          pr: ["b-input", "repository-full"],
          release: ["b-input", "repository-full"],
        },
      },
    },
    inputs: { api: { paths: ["generated/**"] } },
  });
  const relation = {
    id: "a-api-path-to-b-input",
    producer: { repository: "task-a", path: "api/contract.json" },
    consumer: { repository: "task-b", input: "api" },
    type: "generated",
    verifier: { kind: "action", repository: "task-a", action: "relation-verify" },
  };

  await withWorkspace({
    repositories: ["task-a", "task-b"],
    manifests: { "task-a": producer, "task-b": consumer },
    workspace: { relations: [relation] },
  }, async (fixture) => {
    await writeFile(join(fixture.repositoryRoots["task-a"], "src", "core.txt"), "changed\n", "utf8");

    const plan = await buildVerificationPlan(planInput(fixture, { repository: "task-a" }));
    const actions = Object.fromEntries(
      plan.actions.map((action) => [`${action.repository}:${action.id}`, action]),
    );

    assert.equal(plan.outcome, "planned");
    assert.deepEqual(
      Object.keys(actions).sort(),
      ["task-a:a-api", "task-a:a-core", "task-a:relation-verify", "task-b:b-input"],
    );
    assert.equal(actions["task-a:a-core"].provenance, "both");
    assert.deepEqual(actions["task-a:a-core"].reasons, [{
      code: "AREA_COVERAGE",
      repository: "task-a",
      area: "core",
      manifestSource: "candidate",
      profile: "affected",
    }]);
    assert.equal(actions["task-a:a-api"].provenance, "both");
    assert.deepEqual(actions["task-a:a-api"].reasons, [{
      code: "REVERSE_DEPENDENCY",
      repository: "task-a",
      area: "api",
      manifestSource: "candidate",
      profile: "affected",
    }]);
    assert.equal(actions["task-a:relation-verify"].provenance, "both");
    assert.deepEqual(actions["task-a:relation-verify"].reasons, [{
      code: "CROSS_REPOSITORY_RELATION",
      relation: "a-api-path-to-b-input",
      provenance: "candidate",
      producer: "task-a",
      consumer: "task-b",
    }]);
    assert.equal(actions["task-b:b-input"].provenance, "both");
    assert.deepEqual(actions["task-b:b-input"].reasons, [{
      code: "CROSS_REPOSITORY_INPUT",
      relation: "a-api-path-to-b-input",
      provenance: "candidate",
      area: "input",
      profile: "affected",
    }]);
  });
});

test("relation propagation учитывает reverse dependencies и транзитивные exports", async () => {
  const producer = repositoryManifest("task-a", {
    actions: {
      "a-unit": automaticAction(["node", "--test", "a.test.mjs"]),
      "relation-verify": automaticAction(["node", "--test", "relations.test.mjs"]),
      "repository-full": automaticAction(["npm", "test"]),
    },
    areas: {
      source: {
        paths: ["src/**"],
        dependsOn: [],
        coverage: {
          affected: ["a-unit"],
          testing: ["a-unit"],
          pr: ["a-unit", "repository-full"],
          release: ["a-unit", "repository-full"],
        },
      },
    },
    exports: { shared: { paths: ["src/api/**"] } },
  });
  const middle = repositoryManifest("task-b", {
    actions: {
      "b-generated": automaticAction(["node", "--test", "generated.test.mjs"]),
      "b-service": automaticAction(["node", "--test", "service.test.mjs"]),
      "repository-full": automaticAction(["npm", "test"]),
    },
    areas: {
      generated: {
        paths: ["generated/**"],
        dependsOn: [],
        coverage: {
          affected: ["b-generated"],
          testing: ["b-generated"],
          pr: ["b-generated", "repository-full"],
          release: ["b-generated", "repository-full"],
        },
      },
      service: {
        paths: ["service/**", "dist/**"],
        dependsOn: ["generated"],
        coverage: {
          affected: ["b-service"],
          testing: ["b-service"],
          pr: ["b-service", "repository-full"],
          release: ["b-service", "repository-full"],
        },
      },
    },
    inputs: { shared: { paths: ["generated/**"] } },
    exports: { dist: { paths: ["dist/**"] } },
  });
  const consumer = repositoryManifest("task-c", {
    actions: {
      "c-input": automaticAction(["node", "--test", "input.test.mjs"]),
      "repository-full": automaticAction(["npm", "test"]),
    },
    areas: {
      input: {
        paths: ["received/**"],
        dependsOn: [],
        coverage: {
          affected: ["c-input"],
          testing: ["c-input"],
          pr: ["c-input", "repository-full"],
          release: ["c-input", "repository-full"],
        },
      },
    },
    inputs: { dist: { paths: ["received/**"] } },
  });
  const relations = [
    {
      id: "a-to-b-generated",
      producer: { repository: "task-a", export: "shared" },
      consumer: { repository: "task-b", input: "shared" },
      type: "generated",
      verifier: { kind: "action", repository: "task-a", action: "relation-verify" },
    },
    {
      id: "b-to-c-dist",
      producer: { repository: "task-b", export: "dist" },
      consumer: { repository: "task-c", input: "dist" },
      type: "generated",
      verifier: { kind: "action", repository: "task-a", action: "relation-verify" },
    },
  ];

  await withWorkspace({
    repositories: ["task-a", "task-b", "task-c"],
    manifests: {
      "task-a": producer,
      "task-b": middle,
      "task-c": consumer,
    },
    workspace: { relations },
  }, async (fixture) => {
    const changedPath = join(fixture.repositoryRoots["task-a"], "src", "api", "contract.json");
    await mkdir(dirname(changedPath), { recursive: true });
    await writeFile(changedPath, "{}\n", "utf8");

    const plan = await buildVerificationPlan(planInput(fixture, { repository: "task-a" }));
    const generatedAction = plan.actions.find(
      (action) => action.repository === "task-b" && action.id === "b-generated",
    );
    const serviceAction = plan.actions.find(
      (action) => action.repository === "task-b" && action.id === "b-service",
    );
    const consumerAction = plan.actions.find(
      (action) => action.repository === "task-c" && action.id === "c-input",
    );

    assert.equal(plan.outcome, "planned");
    assert.ok(generatedAction?.reasons.some(
      (reason) => reason.code === "CROSS_REPOSITORY_INPUT"
        && reason.relation === "a-to-b-generated"
        && reason.area === "generated",
    ));
    assert.ok(serviceAction?.reasons.some(
      (reason) => reason.code === "REVERSE_DEPENDENCY"
        && reason.relation === "a-to-b-generated"
        && reason.area === "service",
    ));
    assert.ok(consumerAction?.reasons.some(
      (reason) => reason.code === "CROSS_REPOSITORY_INPUT"
        && reason.relation === "b-to-c-dist"
        && reason.area === "input",
    ));
  });
});

test("изменение только action.argv сохраняет обе версии action и все incident relations", async () => {
  const producer = repositoryManifest("task-app", {
    actions: {
      unit: automaticAction(["node", "--version"]),
      verify: automaticAction(["node", "--test", "verify-old.test.mjs"]),
      "repository-full": automaticAction(["npm", "test"]),
    },
    areas: {
      code: {
        paths: ["src/**", "task-verification.json"],
        dependsOn: [],
        coverage: {
          affected: ["unit"],
          testing: ["unit"],
          pr: ["unit", "repository-full"],
          release: ["unit", "repository-full"],
        },
      },
    },
    exports: {
      first: { paths: ["src/first/**"] },
      second: { paths: ["src/second/**"] },
    },
  });
  const firstConsumer = repositoryManifest("task-first", {
    inputs: { first: { paths: ["src/generated/**"] } },
  });
  const secondConsumer = repositoryManifest("task-second", {
    inputs: { second: { paths: ["src/generated/**"] } },
  });
  const relations = [
    {
      id: "verify-first",
      producer: { repository: "task-app", export: "first" },
      consumer: { repository: "task-first", input: "first" },
      type: "generated",
      verifier: { kind: "action", repository: "task-app", action: "verify" },
    },
    {
      id: "verify-second",
      producer: { repository: "task-app", export: "second" },
      consumer: { repository: "task-second", input: "second" },
      type: "generated",
      verifier: { kind: "action", repository: "task-app", action: "verify" },
    },
  ];

  await withWorkspace({
    repositories: ["task-app", "task-first", "task-second"],
    manifests: {
      "task-app": producer,
      "task-first": firstConsumer,
      "task-second": secondConsumer,
    },
    workspace: { relations },
  }, async (fixture) => {
    const candidate = structuredClone(producer);
    candidate.actions.verify.argv = ["node", "--test", "verify-new.test.mjs"];
    await writeJson(join(fixture.repositoryRoot, "task-verification.json"), candidate);

    const plan = await buildVerificationPlan(planInput(fixture));
    const verifyVariants = plan.actions
      .filter((action) => action.repository === "task-app" && action.id === "verify")
      .sort((left, right) => left.provenance.localeCompare(right.provenance));
    const expectedRelationVariants = [
      "verify-first:base",
      "verify-first:candidate",
      "verify-second:base",
      "verify-second:candidate",
    ];

    assert.equal(plan.outcome, "planned");
    assert.equal(verifyVariants.length, 2);
    assert.deepEqual(
      verifyVariants.map((action) => ({ provenance: action.provenance, argv: action.definition.argv })),
      [
        { provenance: "base", argv: ["node", "--test", "verify-old.test.mjs"] },
        { provenance: "candidate", argv: ["node", "--test", "verify-new.test.mjs"] },
      ],
    );
    for (const action of verifyVariants) {
      assert.deepEqual(
        action.reasons
          .filter((reason) => reason.code === "CROSS_REPOSITORY_RELATION")
          .map((reason) => `${reason.relation}:${reason.provenance}`)
          .sort(),
        expectedRelationVariants,
      );
    }
    for (const [repository, relation] of [
      ["task-first", "verify-first"],
      ["task-second", "verify-second"],
    ]) {
      const consumerAction = plan.actions.find(
        (action) => action.repository === repository && action.id === "unit",
      );
      assert.ok(consumerAction, `${repository}:unit должна быть выбрана incident relation`);
      assert.deepEqual(
        consumerAction.reasons
          .filter((reason) => reason.code === "CROSS_REPOSITORY_INPUT")
          .map((reason) => `${reason.relation}:${reason.provenance}`)
          .sort(),
        [`${relation}:base`, `${relation}:candidate`],
      );
    }
    assert.ok(reasonCodeSet(plan).has("ACTION_CHANGED"));
  });
});

test("изменение relation принудительно обрабатывает base и candidate variants", async (context) => {
  const manifest = repositoryManifest("task-app", {
    actions: {
      unit: automaticAction(["node", "--version"]),
      "verify-old": automaticAction(["node", "--version"]),
      "verify-new": automaticAction(["node", "--version"]),
      "repository-full": automaticAction(["node", "--version"]),
    },
    areas: {
      code: {
        paths: ["src/**", "workspace-verification.json"],
        dependsOn: [],
        coverage: {
          affected: ["unit"],
          testing: ["unit"],
          pr: ["unit", "repository-full"],
          release: ["unit", "repository-full"],
        },
      },
    },
    exports: { shared: { paths: ["src/app.txt"] } },
    inputs: {
      shared: { paths: ["src/app.txt"] },
      shifted: { paths: ["src/shifted.txt"] },
    },
  });
  const relation = {
    id: "protected-relation",
    producer: { repository: "task-app", export: "shared" },
    consumer: { repository: "task-app", input: "shared" },
    type: "generated",
    verifier: { kind: "action", repository: "task-app", action: "verify-old" },
  };
  const cases = [
    ["verifier", (candidate) => { candidate.relations[0].verifier.action = "verify-new"; }],
    ["endpoint", (candidate) => { candidate.relations[0].consumer.input = "shifted"; }],
  ];

  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      await withWorkspace({
        manifests: { "task-app": manifest },
        workspace: { relations: [relation] },
      }, async (fixture) => {
        const candidate = JSON.parse(await readFile(fixture.workspacePath, "utf8"));
        mutate(candidate);
        await writeJson(fixture.workspacePath, candidate);

        const plan = await buildVerificationPlan(planInput(fixture));
        const relationProvenances = new Set(
          plan.actions
            .flatMap((action) => action.reasons)
            .filter((reason) => reason.code === "CROSS_REPOSITORY_RELATION")
            .map((reason) => reason.provenance),
        );

        assert.equal(plan.outcome, "planned");
        assert.ok(reasonCodeSet(plan).has("RELATION_CHANGED"));
        assert.deepEqual(relationProvenances, new Set(["base", "candidate"]));
      });
    });
  }
});

test("добавленная relation обрабатывает candidate variant", async () => {
  const manifest = repositoryManifest("task-app", {
    actions: {
      unit: automaticAction(["node", "--version"]),
      verify: automaticAction(["node", "--version"]),
      "repository-full": automaticAction(["node", "--version"]),
    },
    areas: {
      code: {
        paths: ["src/**", "task-verification.json", "workspace-verification.json"],
        dependsOn: [],
        coverage: {
          affected: ["unit"],
          testing: ["unit"],
          pr: ["unit", "repository-full"],
          release: ["unit", "repository-full"],
        },
      },
    },
  });
  const relation = {
    id: "new-relation",
    producer: { repository: "task-app", export: "shared" },
    consumer: { repository: "task-app", input: "shared" },
    type: "generated",
    verifier: { kind: "action", repository: "task-app", action: "verify" },
  };

  await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
    const candidateManifest = structuredClone(manifest);
    candidateManifest.exports.shared = { paths: ["src/app.txt"] };
    candidateManifest.inputs.shared = { paths: ["src/app.txt"] };
    await writeJson(join(fixture.repositoryRoot, "task-verification.json"), candidateManifest);
    const candidateRegistry = JSON.parse(await readFile(fixture.workspacePath, "utf8"));
    candidateRegistry.relations.push(relation);
    await writeJson(fixture.workspacePath, candidateRegistry);

    const plan = await buildVerificationPlan(planInput(fixture));
    const verify = plan.actions.find((action) => action.id === "verify");
    assert.ok(verify, "candidate relation обязана выбрать verifier");
    assert.ok(reasonCodeSet(plan).has("RELATION_CHANGED"));
    assert.deepEqual(
      new Set(
        verify.reasons
          .filter((reason) => reason.code === "CROSS_REPOSITORY_RELATION")
          .map((reason) => reason.provenance),
      ),
      new Set(["candidate"]),
    );
  });
});

test("owner не может добавить relation с unowned producer.path downstream-репозитория", async () => {
  const owner = repositoryManifest("task-owner");
  owner.areas.code.paths.push("workspace-verification.json");
  const producer = repositoryManifest("task-producer");
  const consumer = repositoryManifest("task-consumer", {
    inputs: { generated: { paths: ["src/generated/**"] } },
  });
  const relation = {
    id: "owner-added-unowned-path",
    producer: { repository: "task-producer", path: "unowned/generated.json" },
    consumer: { repository: "task-consumer", input: "generated" },
    type: "generated",
    verifier: { kind: "action", repository: "task-producer", action: "unit" },
  };

  await withWorkspace({
    repositories: ["task-owner", "task-producer", "task-consumer"],
    manifests: {
      "task-owner": owner,
      "task-producer": producer,
      "task-consumer": consumer,
    },
  }, async (fixture) => {
    const candidateRegistry = JSON.parse(await readFile(fixture.workspacePath, "utf8"));
    candidateRegistry.relations.push(relation);
    await writeJson(fixture.workspacePath, candidateRegistry);

    const error = await rejectsVerificationCode(
      buildVerificationPlan(planInput(fixture, { repository: "task-owner" })),
      "CONTRACT_SURFACE_UNOWNED",
    );

    assert.equal(error.stage, "config_validation");
    assert.equal(
      error.path,
      "downstream-candidate.relations.owner-added-unowned-path.producer.path",
    );
    assert.equal(error.actual, "unowned/generated.json");
    assert.deepEqual(error.details, {
      repository: "task-producer",
      relation: "owner-added-unowned-path",
      source: "downstream-candidate",
    });
  });
});

test("неизвестный путь требует явно объявленную полную границу", async () => {
  await withWorkspace({}, async (fixture) => {
    await mkdir(join(fixture.repositoryRoot, "docs"), { recursive: true });
    await writeFile(join(fixture.repositoryRoot, "docs", "note.md"), "unknown area\n", "utf8");

    const plan = await buildVerificationPlan(planInput(fixture));

    assert.equal(plan.outcome, "requires_boundary");
    assert.equal(plan.requiredBoundary, "repository-full");
    assert.equal(actionIdSet(plan).has("task-app:repository-full"), false);
    assert.equal(Object.hasOwn(plan, "checks"), false);
    assert.ok(reasonCodeSet(plan).has("PATH_UNMATCHED"), JSON.stringify(plan.fallbackIssues));
  });
});

test("доверенная fallback boundary обрабатывает все incident relations и pending downstream", async () => {
  const producer = repositoryManifest("task-app", {
    exports: {
      first: { paths: ["src/first/**"] },
      second: { paths: ["src/second/**"] },
    },
  });
  const relations = [
    {
      id: "fallback-first",
      producer: { repository: "task-app", export: "first" },
      consumer: { repository: "task-first", input: "first" },
      type: "generated",
      verifier: { kind: "action", repository: "task-app", action: "unit" },
    },
    {
      id: "fallback-second",
      producer: { repository: "task-app", export: "second" },
      consumer: { repository: "task-second", input: "second" },
      type: "generated",
      verifier: { kind: "action", repository: "task-app", action: "unit" },
    },
  ];
  const repositories = {
    "task-app": {
      status: "active",
      enrollment: "enrolled",
      root: ".",
      manifest: "task-verification.json",
    },
    "task-first": {
      status: "active",
      enrollment: "pending",
      root: "../task-first",
    },
    "task-second": {
      status: "active",
      enrollment: "pending",
      root: "../task-second",
    },
  };

  await withWorkspace({
    manifests: { "task-app": producer },
    workspace: { repositories, relations },
  }, async (fixture) => {
    await mkdir(join(fixture.repositoryRoot, "docs"), { recursive: true });
    await writeFile(join(fixture.repositoryRoot, "docs", "unknown.txt"), "unknown\n", "utf8");

    const plan = await buildVerificationPlan(planInput(fixture, {
      boundary: "repository-full",
    }));
    const pendingRelations = plan.obligations
      .filter((obligation) => obligation.code === "DOWNSTREAM_UNVERIFIED")
      .map((obligation) => `${obligation.relation}:${obligation.provenance}:${obligation.repository}`)
      .sort();

    assert.equal(plan.outcome, "unverified");
    assert.deepEqual(plan.fallbackIssues, []);
    assert.ok(plan.resolvedFallbackIssues.some(
      (issue) => issue.code === "PATH_UNMATCHED" && issue.path === "docs/unknown.txt",
    ));
    assert.ok(actionIdSet(plan).has("task-app:repository-full"));
    assert.deepEqual(pendingRelations, [
      "fallback-first:base:task-first",
      "fallback-first:candidate:task-first",
      "fallback-second:base:task-second",
      "fallback-second:candidate:task-second",
    ]);
  });
});

test("EMPTY_SELECTION обнаруживается до замыкания явной полной границы", async () => {
  const selected = repositoryManifest("task-app", {
    actions: {
      verify: automaticAction(["node", "--test", "relation.test.mjs"]),
      "contract-unit": automaticAction(["node", "--test", "contract.test.mjs"]),
      "repository-full": automaticAction(["npm", "test"]),
    },
    areas: {
      source: {
        paths: ["src/**"],
        dependsOn: [],
        coverage: {
          affected: [],
          testing: [],
          pr: ["repository-full"],
          release: ["repository-full"],
        },
      },
      contract: {
        paths: ["contracts/**"],
        dependsOn: [],
        coverage: {
          affected: ["contract-unit"],
          testing: ["contract-unit"],
          pr: ["contract-unit", "repository-full"],
          release: ["contract-unit", "repository-full"],
        },
      },
    },
    inputs: { shared: { paths: ["contracts/shared.json"] } },
  });
  const producer = repositoryManifest("task-producer", {
    exports: { shared: { paths: ["contracts/shared.json"] } },
    areas: {
      producer: {
        paths: ["src/**", "contracts/**"],
        dependsOn: [],
        coverage: {
          affected: ["unit"],
          testing: ["unit"],
          pr: ["unit", "repository-full"],
          release: ["unit", "repository-full"],
        },
      },
    },
  });
  const relation = {
    id: "fallback-input",
    producer: { repository: "task-producer", export: "shared" },
    consumer: { repository: "task-app", input: "shared" },
    type: "generated",
    verifier: { kind: "action", repository: "task-app", action: "verify" },
  };

  await withWorkspace({
    repositories: ["task-app", "task-producer"],
    manifests: { "task-app": selected, "task-producer": producer },
    workspace: { relations: [relation] },
  }, async (fixture) => {
    await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "empty local selection\n", "utf8");

    const plan = await buildVerificationPlan(planInput(fixture, { boundary: "repository-full" }));
    const actions = actionIdSet(plan);

    assert.equal(plan.outcome, "planned");
    assert.deepEqual(plan.fallbackIssues, []);
    assert.ok(plan.resolvedFallbackIssues.some((issue) => issue.code === "EMPTY_SELECTION"));
    assert.ok(actions.has("task-app:repository-full"));
    assert.ok(actions.has("task-app:verify"));
    assert.ok(actions.has("task-app:contract-unit"));
    const verifier = plan.actions.find((action) => action.id === "verify");
    assert.deepEqual(
      new Set(verifier.reasons
        .filter((reason) => reason.code === "CROSS_REPOSITORY_RELATION")
        .map((reason) => reason.provenance)),
      new Set(["base", "candidate"]),
    );
  });
});

test("неоднозначный путь не выбирает удобную область и требует полную границу", async () => {
  const manifest = repositoryManifest("task-app");
  manifest.areas["also-code"] = structuredClone(manifest.areas.code);
  await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
    await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "ambiguous\n", "utf8");

    const plan = await buildVerificationPlan(planInput(fixture));

    assert.equal(plan.outcome, "requires_boundary");
    assert.equal(actionIdSet(plan).has("task-app:repository-full"), false);
    assert.equal(Object.hasOwn(plan, "checks"), false);
    assert.ok(reasonCodeSet(plan).has("PATH_AMBIGUOUS"), JSON.stringify(plan.fallbackIssues));
  });
});

test("path-exception активируется только после попадания в base", async (context) => {
  const manifest = repositoryManifest("task-app", {
    areas: {
      code: {
        paths: ["src/**", "workspace-verification.json"],
        dependsOn: [],
        coverage: {
          affected: ["unit"],
          testing: ["unit"],
          pr: ["unit", "repository-full"],
          release: ["unit", "repository-full"],
        },
      },
      "also-code": {
        paths: ["src/**"],
        dependsOn: [],
        coverage: {
          affected: ["unit"],
          testing: ["unit"],
          pr: ["unit", "repository-full"],
          release: ["unit", "repository-full"],
        },
      },
    },
  });
  const exception = {
    id: "temporary-overlap",
    version: 1,
    scope: { repository: "task-app", path: "src/**" },
    owner: "platform-team",
    reason: "Переходное пересечение областей",
    expiresAt: "2999-12-31",
  };

  await context.test("candidate-only exception не снимает ambiguity", async () => {
    await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
      const candidate = JSON.parse(await readFile(fixture.workspacePath, "utf8"));
      candidate.exceptions.push(exception);
      await writeJson(fixture.workspacePath, candidate);
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "ambiguous\n", "utf8");

      const plan = await buildVerificationPlan(planInput(fixture));

      assert.equal(plan.outcome, "requires_boundary");
      assert.ok(reasonCodeSet(plan).has("PATH_AMBIGUOUS"));
      assert.ok(reasonCodeSet(plan).has("EXCEPTION_PENDING_ACTIVATION"));
      assert.equal(actionIdSet(plan).has("task-app:repository-full"), false);
    });
  });

  await context.test("base exception действует после удаления из candidate", async () => {
    await withWorkspace({
      manifests: { "task-app": manifest },
      workspace: { exceptions: [exception] },
    }, async (fixture) => {
      const candidate = JSON.parse(await readFile(fixture.workspacePath, "utf8"));
      candidate.exceptions = [];
      await writeJson(fixture.workspacePath, candidate);
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "ambiguous\n", "utf8");

      const plan = await buildVerificationPlan(planInput(fixture));

      assert.equal(plan.outcome, "planned");
      assert.ok(reasonCodeSet(plan).has("PATH_OVERLAP_EXPLAINED"));
      assert.equal(reasonCodeSet(plan).has("PATH_AMBIGUOUS"), false);
    });
  });
});

test("только base fallback boundary закрывает неизвестный путь", async () => {
  const manifest = repositoryManifest("task-app", {
    actions: {
      unit: automaticAction(["node", "--version"]),
      quick: automaticAction(["node", "--version"]),
      "repository-full": automaticAction(["node", "--version"]),
    },
    boundaries: {
      quick: { actions: ["quick"] },
      "repository-full": { actions: ["repository-full"] },
    },
  });
  await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
    await mkdir(join(fixture.repositoryRoot, "docs"), { recursive: true });
    await writeFile(join(fixture.repositoryRoot, "docs", "note.md"), "unknown area\n", "utf8");

    const otherBoundary = await buildVerificationPlan(planInput(fixture, { boundary: "quick" }));
    assert.equal(otherBoundary.outcome, "requires_boundary");
    assert.equal(otherBoundary.requiredBoundary, "repository-full");
    assert.ok(actionIdSet(otherBoundary).has("task-app:quick"));
    assert.equal(actionIdSet(otherBoundary).has("task-app:repository-full"), false);

    const baseFallback = await buildVerificationPlan(planInput(fixture, { boundary: "repository-full" }));
    assert.equal(baseFallback.outcome, "planned");
    assert.equal(baseFallback.requiredBoundary, null);
    assert.ok(actionIdSet(baseFallback).has("task-app:repository-full"));
    assert.deepEqual(baseFallback.fallbackIssues, []);
    assert.deepEqual(
      baseFallback.resolvedFallbackIssues.map((issue) => issue.code),
      ["PATH_UNMATCHED"],
    );
    const report = formatHumanReport(baseFallback);
    assert.doesNotMatch(report, /Блокирующие причины/u);
    assert.match(report, /Причины, закрытые явной границей: 1\./u);
    assert.match(report, /PATH_UNMATCHED;[^\n]*path=docs\/note\.md/u);
  });
});

test("candidate fallbackBoundary не ослабляет base requiredBoundary", async () => {
  const manifest = repositoryManifest("task-app", {
    actions: {
      unit: automaticAction(["node", "--version"]),
      "candidate-full": automaticAction(["node", "--version"]),
      "repository-full": automaticAction(["node", "--version"]),
    },
    areas: {
      code: {
        paths: ["src/**", "task-verification.json"],
        dependsOn: [],
        coverage: {
          affected: ["unit"],
          testing: ["unit"],
          pr: ["unit", "repository-full"],
          release: ["unit", "repository-full"],
        },
      },
    },
    boundaries: {
      "candidate-full": { actions: ["candidate-full"] },
      "repository-full": { actions: ["repository-full"] },
    },
  });
  await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
    const candidate = structuredClone(manifest);
    candidate.policy.fallbackBoundary = "candidate-full";
    candidate.areas.code.coverage.pr.push("candidate-full");
    candidate.areas.code.coverage.release.push("candidate-full");
    await writeJson(join(fixture.repositoryRoot, "task-verification.json"), candidate);
    await mkdir(join(fixture.repositoryRoot, "docs"), { recursive: true });
    await writeFile(join(fixture.repositoryRoot, "docs", "note.md"), "unknown area\n", "utf8");

    const plan = await buildVerificationPlan(planInput(fixture));

    assert.equal(plan.outcome, "requires_boundary");
    assert.equal(plan.requiredBoundary, "repository-full");
    assert.equal(actionIdSet(plan).has("task-app:repository-full"), false);
    assert.equal(actionIdSet(plan).has("task-app:candidate-full"), false);
  });
});

test("пустая полная граница не может считаться безопасным fallback", async () => {
  const manifest = repositoryManifest("task-app");
  manifest.boundaries["repository-full"].actions = [];
  await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
    await rejectsVerificationCode(
      buildVerificationPlan(planInput(fixture)),
      "EMPTY_BOUNDARY",
    );
  });
});

test("pending и reserved репозитории требуют явного действия и не дают ложный успех", async (context) => {
  for (const repositoryState of [
    { name: "pending", status: "active", code: "REPOSITORY_PENDING", outcome: "unverified" },
    { name: "reserved", status: "reserved", code: "REPOSITORY_RESERVED", outcome: "not_applicable" },
  ]) {
    await context.test(repositoryState.name, async () => {
      await withWorkspace({
        repositories: ["task-registry", "task-app"],
        workspace: {
          repositories: {
            "task-registry": {
              status: "active",
              enrollment: "enrolled",
              root: ".",
              manifest: "task-verification.json",
            },
            "task-app": {
              status: repositoryState.status,
              enrollment: "pending",
              root: "../task-app",
            },
          },
        },
      }, async (fixture) => {
        await writeFile(join(fixture.repositoryRoots["task-app"], "src", "app.txt"), "candidate\n", "utf8");
        const plan = await buildVerificationPlan(planInput(fixture, {
          repository: "task-app",
          repositoryRoot: fixture.repositoryRoots["task-app"],
          base: fixture.baseShas["task-app"],
          registryBase: fixture.baseShas["task-registry"],
        }));
        assert.equal(plan.outcome, repositoryState.outcome);
        assert.equal(plan.actions.length, 0);
        assert.ok(reasonCodeSet(plan).has(repositoryState.code));
        const report = formatHumanReport(plan);
        assert.match(
          report,
          new RegExp(`${repositoryState.code};[^\\n]*repository=task-app`, "u"),
        );
      });
    });
  }
});

test("не планирует historical/unmanaged и блокирует расхождение статуса manifest", async (context) => {
  for (const status of ["historical", "unmanaged"]) {
    await context.test(status, async () => {
      await withWorkspace({
        repositories: ["task-registry", "task-app"],
        manifests: {
          "task-app": repositoryManifest("task-app", { status }),
        },
        workspace: {
          repositories: {
            "task-registry": {
              status: "active",
              enrollment: "enrolled",
              root: ".",
              manifest: "task-verification.json",
            },
            "task-app": {
              status,
              enrollment: "enrolled",
              root: "../task-app",
              manifest: "task-verification.json",
            },
          },
        },
      }, async (fixture) => {
        await rejectsVerificationCode(
          buildVerificationPlan(planInput(fixture, {
            repository: "task-app",
            repositoryRoot: fixture.repositoryRoots["task-app"],
            base: fixture.baseShas["task-app"],
            registryBase: fixture.baseShas["task-registry"],
          })),
          "REPOSITORY_STATE_INVALID",
        );
      });
    });
  }

  await context.test("registry и manifest расходятся", async () => {
    const manifest = repositoryManifest("task-app", { status: "reserved" });
    await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
      await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture)),
        "REPOSITORY_STATUS_MISMATCH",
      );
    });
  });
});

test("enrolled downstream требует pinned full revision и совпадающий clean HEAD", async (context) => {
  await context.test("revision обязателен и имеет lowercase full SHA", () => {
    const missing = workspaceManifest(["task-registry", "task-consumer"]);
    delete missing.repositories["task-consumer"].revision;
    const missingError = throwsVerificationCode(
      () => validateWorkspaceRegistry(missing),
      "DOWNSTREAM_REVISION_REQUIRED",
    );
    assert.equal(
      missingError.path,
      "workspace-verification.json.repositories.task-consumer.revision",
    );

    for (const revision of ["abc123", "A".repeat(40)]) {
      const invalid = workspaceManifest(["task-registry", "task-consumer"]);
      invalid.repositories["task-consumer"].revision = revision;
      const error = throwsVerificationCode(
        () => validateWorkspaceRegistry(invalid),
        "INVALID_CONFIG",
      );
      assert.equal(error.path, "workspace-verification.json.repositories.task-consumer.revision");
      assert.equal(error.actual, revision);
    }
  });

  const producer = repositoryManifest("task-app", {
    actions: {
      unit: automaticAction(["node", "--version"]),
      verify: automaticAction(["node", "--test", "relation.test.mjs"]),
      "repository-full": automaticAction(["npm", "test"]),
    },
    exports: { shared: { paths: ["src/app.txt"] } },
  });
  const consumer = repositoryManifest("task-consumer", {
    inputs: { shared: { paths: ["src/app.txt"] } },
  });
  const relation = {
    id: "revision-pinned",
    producer: { repository: "task-app", export: "shared" },
    consumer: { repository: "task-consumer", input: "shared" },
    type: "generated",
    verifier: { kind: "action", repository: "task-app", action: "verify" },
  };
  const options = {
    repositories: ["task-app", "task-consumer"],
    manifests: { "task-app": producer, "task-consumer": consumer },
    workspace: { relations: [relation] },
  };

  await context.test("mismatch чистого HEAD блокирует план структурным confounder", async () => {
    await withWorkspace(options, async (fixture) => {
      const pinnedRevision = fixture.baseShas["task-consumer"];
      await writeFile(
        join(fixture.repositoryRoots["task-consumer"], "src", "app.txt"),
        "advanced downstream\n",
        "utf8",
      );
      const actualRevision = await commitAll(
        fixture.repositoryRoots["task-consumer"],
        "advance clean downstream",
      );
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "producer change\n", "utf8");

      const plan = await buildVerificationPlan(planInput(fixture));
      const mismatch = plan.confounders.find(
        (confounder) => confounder.repository === "task-consumer",
      );

      assert.equal(plan.outcome, "blocked");
      assert.ok(mismatch, JSON.stringify(plan.confounders));
      assert.equal(mismatch.code, "DOWNSTREAM_CONFOUNDER");
      assert.equal(mismatch.expected, pinnedRevision);
      assert.equal(mismatch.actual, actualRevision);
      assert.equal(typeof mismatch.next, "string");
      assert.equal(mismatch.details.trustedRevision, pinnedRevision);
      assert.equal(mismatch.details.relationSource, "base");
      assert.deepEqual(plan.snapshots["task-consumer"], undefined);
    });
  });

  await context.test("совпадающий revision допускает связанный план", async () => {
    await withWorkspace(options, async (fixture) => {
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "producer change\n", "utf8");

      const plan = await buildVerificationPlan(planInput(fixture));

      assert.equal(plan.outcome, "planned");
      assert.deepEqual(plan.confounders, []);
      assert.ok(actionIdSet(plan).has("task-app:verify"));
      assert.ok(actionIdSet(plan).has("task-consumer:unit"));
      assert.equal(
        plan.snapshots["task-consumer"].headSha,
        fixture.baseShas["task-consumer"],
      );
    });
  });

  await context.test("один checkout сохраняет блокер каждой relation и версии", async () => {
    const relations = [
      { ...structuredClone(relation), id: "revision-pinned-first" },
      { ...structuredClone(relation), id: "revision-pinned-second" },
    ];
    await withWorkspace({
      ...options,
      workspace: { relations },
    }, async (fixture) => {
      const pinnedRevision = fixture.baseShas["task-consumer"];
      await writeFile(
        join(fixture.repositoryRoots["task-consumer"], "src", "app.txt"),
        "advanced downstream\n",
        "utf8",
      );
      const actualRevision = await commitAll(
        fixture.repositoryRoots["task-consumer"],
        "advance shared downstream once",
      );
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "producer change\n", "utf8");

      const plan = await buildVerificationPlan(planInput(fixture));
      const issues = plan.confounders
        .filter((issue) => issue.code === "DOWNSTREAM_CONFOUNDER")
        .sort((left, right) => `${left.relation}:${left.relationSource}`
          .localeCompare(`${right.relation}:${right.relationSource}`));

      assert.equal(plan.outcome, "blocked");
      assert.deepEqual(
        issues.map((issue) => `${issue.relation}:${issue.relationSource}`),
        [
          "revision-pinned-first:base",
          "revision-pinned-first:candidate",
          "revision-pinned-second:base",
          "revision-pinned-second:candidate",
        ],
      );
      for (const issue of issues) {
        assert.equal(issue.repository, "task-consumer");
        assert.equal(issue.expected, pinnedRevision);
        assert.equal(issue.actual, actualRevision);
        assert.equal(issue.details.trustedRevision, pinnedRevision);
        assert.equal(issue.details.relationSource, issue.relationSource);
        assert.equal(issue.details.relation, issue.relation);
      }
      assert.equal(plan.snapshots["task-consumer"], undefined);
    });
  });
});

test("отсутствующий или грязный downstream checkout блокирует межрепозиторную связь", async (context) => {
  const producer = repositoryManifest("task-app", {
    actions: {
      unit: automaticAction(["node", "--version"]),
      verify: automaticAction(["node", "--version"]),
      "repository-full": automaticAction(["node", "--version"]),
    },
    exports: { shared: { paths: ["src/app.txt"] } },
  });
  const consumer = repositoryManifest("task-consumer", {
    inputs: { shared: { paths: ["src/app.txt"] } },
  });
  const relation = {
    id: "shared-contract",
    producer: { repository: "task-app", export: "shared" },
    consumer: { repository: "task-consumer", input: "shared" },
    type: "generated",
    verifier: { kind: "action", repository: "task-app", action: "verify" },
  };

  await context.test("missing", async () => {
    await withWorkspace({
      repositories: ["task-app", "task-consumer"],
      manifests: { "task-app": producer, "task-consumer": consumer },
      workspace: { relations: [relation] },
    }, async (fixture) => {
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "changed\n", "utf8");
      await rm(fixture.repositoryRoots["task-consumer"], { recursive: true, force: true });
      const plan = await buildVerificationPlan(planInput(fixture));
      assert.equal(plan.outcome, "unverified");
      assert.ok(reasonCodeSet(plan).has("DOWNSTREAM_MISSING"));
    });
  });

  await context.test("dirty", async () => {
    await withWorkspace({
      repositories: ["task-app", "task-consumer"],
      manifests: { "task-app": producer, "task-consumer": consumer },
      workspace: { relations: [relation] },
    }, async (fixture) => {
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "changed\n", "utf8");
      await writeFile(join(fixture.repositoryRoots["task-consumer"], "src", "app.txt"), "local drift\n", "utf8");
      const plan = await buildVerificationPlan(planInput(fixture));
      assert.equal(plan.outcome, "blocked");
      assert.ok(reasonCodeSet(plan).has("DOWNSTREAM_CONFOUNDER"));
    });
  });
});

test("exact-copy сравнивает candidate bytes и executable mode", async (context) => {
  const manifest = repositoryManifest("task-app", {
    actions: {
      verify: automaticAction(["node", "--version"]),
      "repository-full": automaticAction(["node", "--version"]),
    },
    areas: {
      source: {
        paths: ["templates/**"],
        dependsOn: [],
        coverage: {
          affected: ["verify"],
          testing: ["verify"],
          pr: ["verify", "repository-full"],
          release: ["verify", "repository-full"],
        },
      },
      generated: {
        paths: ["generated/**"],
        dependsOn: ["source"],
        coverage: {
          affected: ["verify"],
          testing: ["verify"],
          pr: ["verify", "repository-full"],
          release: ["verify", "repository-full"],
        },
      },
    },
    exports: { shared: { paths: ["templates/shared.bin"] } },
    inputs: { shared: { paths: ["generated/shared.bin"] } },
  });
  const relation = {
    id: "shared-copy",
    producer: { repository: "task-app", export: "shared" },
    consumer: { repository: "task-app", input: "shared" },
    type: "exact-copy",
    verifier: { kind: "action", repository: "task-app", action: "verify" },
  };

  async function runVariant({
    producerBytes,
    consumerBytes,
    producerMode = 0o644,
    consumerMode = 0o644,
    planOverrides = {},
  }) {
    return await withWorkspace({
      manifests: { "task-app": manifest },
      workspace: { relations: [relation] },
    }, async (fixture) => {
      const producerPath = join(fixture.repositoryRoot, "templates", "shared.bin");
      const consumerPath = join(fixture.repositoryRoot, "generated", "shared.bin");
      await mkdir(dirname(producerPath), { recursive: true });
      await mkdir(dirname(consumerPath), { recursive: true });
      await writeFile(producerPath, "base\n", "utf8");
      await writeFile(consumerPath, "base\n", "utf8");
      const baseRef = await commitAll(fixture.repositoryRoot, "artifact baseline");

      await writeFile(producerPath, producerBytes);
      await writeFile(consumerPath, consumerBytes);
      await chmod(producerPath, producerMode);
      await chmod(consumerPath, consumerMode);
      return await buildVerificationPlan(planInput(fixture, { base: baseRef, ...planOverrides }));
    });
  }

  async function rejectSymlinkVariant(createTarget) {
    await withWorkspace({
      manifests: { "task-app": manifest },
      workspace: { relations: [relation] },
    }, async (fixture) => {
      const producerPath = join(fixture.repositoryRoot, "templates", "shared.bin");
      const internalTarget = join(fixture.repositoryRoot, "templates", "target.bin");
      const consumerPath = join(fixture.repositoryRoot, "generated", "shared.bin");
      await mkdir(dirname(producerPath), { recursive: true });
      await mkdir(dirname(consumerPath), { recursive: true });
      await writeFile(producerPath, "base\n", "utf8");
      await writeFile(internalTarget, "target\n", "utf8");
      await writeFile(consumerPath, "base\n", "utf8");
      const baseRef = await commitAll(fixture.repositoryRoot, "artifact baseline");

      await rm(producerPath);
      await symlink(await createTarget(fixture), producerPath);
      const error = await rejectsVerificationCode(
        buildVerificationPlan(planInput(fixture, { base: baseRef })),
        "GIT_SYMLINK_UNSAFE",
      );

      assert.equal(error.stage, "git_snapshot");
      assert.equal(error.path, "templates/shared.bin");
    });
  }

  await context.test("равные candidate bytes и mode допускают verifier", async () => {
    const plan = await runVariant({ producerBytes: "candidate\n", consumerBytes: "candidate\n" });
    assert.equal(plan.outcome, "planned");
    assert.ok(actionIdSet(plan).has("task-app:verify"));
    assert.ok(reasonCodeSet(plan).has("EXACT_COPY_EQUAL"));
  });

  await context.test("неизменённые endpoints входят в общий снимок", async () => {
    await withWorkspace({
      manifests: { "task-app": manifest },
      workspace: { relations: [relation] },
    }, async (fixture) => {
      const producerPath = join(fixture.repositoryRoot, "templates", "shared.bin");
      const consumerPath = join(fixture.repositoryRoot, "generated", "shared.bin");
      const triggerPath = join(fixture.repositoryRoot, "templates", "trigger.txt");
      await mkdir(dirname(producerPath), { recursive: true });
      await mkdir(dirname(consumerPath), { recursive: true });
      await writeFile(producerPath, "same\n", "utf8");
      await writeFile(consumerPath, "same\n", "utf8");
      await writeFile(triggerPath, "base\n", "utf8");
      const baseRef = await commitAll(fixture.repositoryRoot, "unchanged exact-copy endpoints");
      await writeFile(triggerPath, "candidate\n", "utf8");

      const plan = await buildVerificationPlan(planInput(fixture, { base: baseRef }));
      const snapshot = plan.snapshots["task-app"];
      const stateByPath = new Map(snapshot.pathStates.map((state) => [state.path, state]));
      const evidence = plan.relationEvidence
        .filter((item) => item.relation === "shared-copy")
        .map((item) => `${item.provenance}:${item.code}`)
        .sort();

      assert.equal(plan.outcome, "planned");
      assert.ok(changedPathSet(snapshot).has("templates/trigger.txt"));
      assert.equal(changedPathSet(snapshot).has("templates/shared.bin"), false);
      assert.equal(changedPathSet(snapshot).has("generated/shared.bin"), false);
      for (const path of ["templates/shared.bin", "generated/shared.bin"]) {
        assert.equal(stateByPath.get(path)?.base.type, "file");
        assert.equal(stateByPath.get(path)?.candidate.type, "file");
      }
      assert.deepEqual(evidence, ["base:EXACT_COPY_EQUAL", "candidate:EXACT_COPY_EQUAL"]);
      assert.match(snapshot.fingerprint, /^[0-9a-f]{64}$/u);
    });
  });

  await context.test("разные candidate bytes блокируют план", async () => {
    const plan = await runVariant({ producerBytes: "producer\n", consumerBytes: "consumer\n" });
    assert.equal(plan.outcome, "blocked");
    assert.ok(reasonCodeSet(plan).has("EXACT_COPY_DIFFERENT"));
  });

  await context.test("разный executable mode блокирует план", async () => {
    const plan = await runVariant({
      producerBytes: "candidate\n",
      consumerBytes: "candidate\n",
      producerMode: 0o755,
      consumerMode: 0o644,
    });
    assert.equal(plan.outcome, "blocked");
    assert.ok(reasonCodeSet(plan).has("EXACT_COPY_DIFFERENT"));
    const pair = plan.relationEvidence
      .flatMap((relationResult) => relationResult.pairs ?? [])
      .find((item) => item.producer?.executable !== item.consumer?.executable);
    assert.ok(pair, "отчёт обязан показать несовпавший executable bit");
  });

  await context.test("явная граница добавляется и не удаляет проверку связи", async () => {
    const plan = await runVariant({
      producerBytes: "candidate\n",
      consumerBytes: "candidate\n",
      planOverrides: { boundary: "repository-full" },
    });
    assert.equal(plan.outcome, "planned");
    assert.ok(actionIdSet(plan).has("task-app:repository-full"));
    assert.ok(reasonCodeSet(plan).has("EXACT_COPY_EQUAL"));
  });

  await context.test("внутренняя symlink отвергается", async () => {
    await rejectSymlinkVariant(async () => "target.bin");
  });

  await context.test("внешняя symlink отвергается", async () => {
    await rejectSymlinkVariant(async (fixture) => {
      const outside = join(fixture.workspaceRoot, "outside.bin");
      await writeFile(outside, "outside\n", "utf8");
      return outside;
    });
  });

  await context.test("broken symlink отвергается", async () => {
    await rejectSymlinkVariant(async () => "missing.bin");
  });
});

test("candidate не может скрыть relation или export удалением собственного контракта", async () => {
  const manifest = repositoryManifest("task-app", {
    actions: {
      unit: automaticAction(["node", "--version"]),
      verify: automaticAction(["node", "--version"]),
      "repository-full": automaticAction(["node", "--version"]),
    },
    exports: { shared: { paths: ["src/app.txt"] } },
    inputs: { shared: { paths: ["src/app.txt"] } },
  });
  const relation = {
    id: "protected-edge",
    producer: { repository: "task-app", export: "shared" },
    consumer: { repository: "task-app", input: "shared" },
    type: "exact-copy",
    verifier: { kind: "action", repository: "task-app", action: "verify" },
  };
  await withWorkspace({
    manifests: { "task-app": manifest },
    workspace: { relations: [relation] },
  }, async (fixture) => {
    const candidateManifest = structuredClone(manifest);
    delete candidateManifest.exports.shared;
    await writeJson(join(fixture.repositoryRoot, "task-verification.json"), candidateManifest);

    const candidateWorkspace = workspaceManifest(["task-app"], { relations: [] });
    await writeJson(fixture.workspacePath, candidateWorkspace);

    const plan = await buildVerificationPlan(planInput(fixture));

    assert.equal(plan.outcome, "blocked");
    assert.ok(reasonCodeSet(plan).has("RELATION_REMOVED"));
    assert.ok(reasonCodeSet(plan).has("EXPORT_REMOVED"));
  });
});

test("изменение export/input paths сохраняет старую и новую поверхность связи", async () => {
  const manifest = repositoryManifest("task-app", {
    actions: {
      unit: automaticAction(["node", "--version"]),
      verify: automaticAction(["node", "--version"]),
      "repository-full": automaticAction(["node", "--version"]),
    },
    areas: {
      code: {
        paths: ["src/**", "task-verification.json"],
        dependsOn: [],
        coverage: {
          affected: ["unit"],
          testing: ["unit"],
          pr: ["unit", "repository-full"],
          release: ["unit", "repository-full"],
        },
      },
    },
    exports: { shared: { paths: ["src/export-old.txt"] } },
    inputs: { shared: { paths: ["src/input-old.txt"] } },
  });
  const relation = {
    id: "moving-surface",
    producer: { repository: "task-app", export: "shared" },
    consumer: { repository: "task-app", input: "shared" },
    type: "generated",
    verifier: { kind: "action", repository: "task-app", action: "verify" },
  };

  await withWorkspace({
    manifests: { "task-app": manifest },
    workspace: { relations: [relation] },
  }, async (fixture) => {
    const candidate = structuredClone(manifest);
    candidate.exports.shared.paths = ["src/export-new.txt"];
    candidate.inputs.shared.paths = ["src/input-new.txt"];
    await writeJson(join(fixture.repositoryRoot, "task-verification.json"), candidate);

    const plan = await buildVerificationPlan(planInput(fixture));
    const verify = plan.actions.find((action) => action.id === "verify");
    assert.ok(verify, "обе версии relation обязаны выбрать verifier");
    const provenances = new Set(
      verify.reasons
        .filter((reason) => reason.code === "CROSS_REPOSITORY_RELATION")
        .map((reason) => reason.provenance),
    );

    assert.equal(plan.outcome, "planned");
    assert.deepEqual(provenances, new Set(["base", "candidate"]));
    assert.ok(reasonCodeSet(plan).has("EXPORT_CHANGED"));
    assert.ok(reasonCodeSet(plan).has("INPUT_CHANGED"));
  });
});

test("human report объясняет план и точную fallback-команду", async (context) => {
  const downstreamProducer = repositoryManifest("task-app", {
    actions: {
      unit: automaticAction(["node", "--version"]),
      verify: automaticAction(["node", "--test", "relation.test.mjs"]),
      "repository-full": automaticAction(["npm", "test"]),
    },
    exports: { shared: { paths: ["src/app.txt"] } },
  });
  const downstreamConsumer = repositoryManifest("task-consumer", {
    inputs: { shared: { paths: ["src/app.txt"] } },
  });
  const downstreamRelation = {
    id: "report-shared-contract",
    producer: { repository: "task-app", export: "shared" },
    consumer: { repository: "task-consumer", input: "shared" },
    type: "generated",
    verifier: { kind: "action", repository: "task-app", action: "verify" },
  };
  const downstreamOptions = {
    repositories: ["task-app", "task-consumer"],
    manifests: {
      "task-app": downstreamProducer,
      "task-consumer": downstreamConsumer,
    },
    workspace: { relations: [downstreamRelation] },
  };

  await context.test("planned", async () => {
    await withWorkspace({}, async (fixture) => {
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "candidate\n", "utf8");
      const report = formatHumanReport(await buildVerificationPlan(planInput(fixture)));

      assert.match(report, /task-app:unit/u);
      assert.match(report, /AREA_COVERAGE:code/u);
      assert.match(report, /Планировщик не запускал выбранные проверки и не изменял файлы проекта\./u);
    });
  });

  await context.test("requires_boundary", async () => {
    await withWorkspace({}, async (fixture) => {
      await mkdir(join(fixture.repositoryRoot, "docs"), { recursive: true });
      await writeFile(join(fixture.repositoryRoot, "docs", "note.md"), "unknown\n", "utf8");
      const report = formatHumanReport(await buildVerificationPlan(planInput(fixture)));

      assert.match(report, /PATH_UNMATCHED;[^\n]*path=docs\/note\.md/u);
      assert.match(report, /--boundary repository-full/u);
    });
  });

  await context.test("DOWNSTREAM_CONFOUNDER раскрывает checkout и точное восстановление", async () => {
    await withWorkspace(downstreamOptions, async (fixture) => {
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "producer change\n", "utf8");
      await writeFile(
        join(fixture.repositoryRoots["task-consumer"], "src", "app.txt"),
        "dirty downstream\n",
        "utf8",
      );

      const plan = await buildVerificationPlan(planInput(fixture));
      const issue = plan.confounders.find((item) => item.code === "DOWNSTREAM_CONFOUNDER");
      const report = formatHumanReport(plan);

      assert.ok(issue, JSON.stringify(plan.confounders));
      assert.equal(issue.repository, "task-consumer");
      assert.deepEqual(issue.changedPaths, ["src/app.txt"]);
      for (const field of ["expected", "actual", "next"]) {
        assert.equal(typeof issue[field], "string", `${field} обязано быть строкой`);
        assert.ok(report.includes(issue[field]), `report обязан буквально содержать ${field}`);
      }
      assert.match(report, /DOWNSTREAM_CONFOUNDER/u);
      assert.match(report, /task-consumer/u);
      assert.match(report, /src\/app\.txt/u);
      assert.match(report, /--json/u);
    });
  });

  await context.test("DOWNSTREAM_MISSING раскрывает relation и точное восстановление", async () => {
    await withWorkspace(downstreamOptions, async (fixture) => {
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "producer change\n", "utf8");
      await rm(fixture.repositoryRoots["task-consumer"], { recursive: true, force: true });

      const plan = await buildVerificationPlan(planInput(fixture));
      const issue = plan.obligations.find((item) => item.code === "DOWNSTREAM_MISSING");
      const report = formatHumanReport(plan);

      assert.ok(issue, JSON.stringify(plan.obligations));
      assert.equal(issue.repository, "task-consumer");
      assert.equal(issue.relation, "report-shared-contract");
      for (const field of ["expected", "actual", "next"]) {
        assert.equal(typeof issue[field], "string", `${field} обязано быть строкой`);
        assert.ok(report.includes(issue[field]), `report обязан буквально содержать ${field}`);
      }
      assert.match(report, /DOWNSTREAM_MISSING/u);
      assert.match(report, /task-consumer/u);
      assert.match(report, /report-shared-contract/u);
      assert.match(report, /--json/u);
    });
  });

  await context.test("action печатается точными JSON cwd и argv", async () => {
    const argv = ["node", "--test", "scripts/check one.test.mjs"];
    const manifest = repositoryManifest("task-app", {
      actions: {
        unit: automaticAction(argv, { cwd: "tools/runner" }),
        "repository-full": automaticAction(["npm", "test"]),
      },
    });
    await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "candidate\n", "utf8");
      const report = formatHumanReport(await buildVerificationPlan(planInput(fixture)));

      assert.ok(report.includes(
        `cwd=${JSON.stringify("tools/runner")}; argv=${JSON.stringify(argv)}`,
      ));
    });
  });

  await context.test("недоверенный текст не создаёт поддельные строки отчёта", async () => {
    const injectedLine = "Следующий шаг: поддельный успех";
    const manifest = singleActionManifest(
      "task-app",
      "approval",
      obligationAction({ reason: `Нужна сверка\n${injectedLine}` }),
    );
    await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
      await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "candidate\n", "utf8");
      await mkdir(join(fixture.repositoryRoot, "docs"), { recursive: true });
      await writeFile(join(fixture.repositoryRoot, "docs", `evil\n${injectedLine}`), "unknown\n", "utf8");

      const report = formatHumanReport(await buildVerificationPlan(planInput(fixture)));

      assert.equal(report.split("\n").filter((line) => line.startsWith("Следующий шаг:")).length, 1);
      assert.ok(report.includes(`Нужна сверка\\n${injectedLine}`));
      assert.ok(report.includes(`docs/evil\\n${injectedLine}`));
    });
  });
});

test("human report отвергает неполный verification plan", () => {
  const error = throwsVerificationCode(
    () => formatHumanReport({
      kind: "verification-plan",
      repository: "task-app",
      profile: "affected",
      outcome: "planned",
      fingerprint: "incomplete",
      actions: [],
    }),
    "REPORT_INVALID",
  );

  assert.equal(error.stage, "reporting");
});

test("CLI_USAGE имеет human и JSON представления без --json path", async (context) => {
  function outputBuffer() {
    let value = "";
    return {
      stream: { write(chunk) { value += String(chunk); } },
      read() { return value; },
    };
  }

  async function runCli(argv, cwd = process.cwd()) {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const exitCode = await main(argv, {
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    return { exitCode, stdout: stdout.read(), stderr: stderr.read() };
  }

  await context.test("human error", async () => {
    const result = await runCli(["plan"]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /CLI_USAGE/u);
    assert.match(result.stderr, /input_validation/u);
    assert.match(result.stderr, /Следующий шаг: .+/u);
  });

  await context.test("human error экранирует поддельную строку", async () => {
    const result = await runCli(["unknown\nСледующий шаг: поддельный успех"]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr.split("\n").filter((line) => line.startsWith("Следующий шаг:")).length, 1);
    assert.match(result.stderr, /unknown\\nСледующий шаг: поддельный успех/u);
  });

  await context.test("JSON error", async () => {
    const result = await runCli(["plan", "--json"]);
    const error = JSON.parse(result.stderr);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.equal(error.code, "CLI_USAGE");
    assert.equal(error.stage, "input_validation");
    assert.equal(typeof error.next, "string");
    assert.ok(error.next.length > 0);
  });

  await context.test("--json не принимает output path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "task-verify-cli-"));
    try {
      const result = await runCli(["plan", "--json", "result.json"], cwd);
      const error = JSON.parse(result.stderr);

      assert.equal(result.exitCode, 1);
      assert.equal(error.code, "CLI_USAGE");
      await assert.rejects(readFile(join(cwd, "result.json")), { code: "ENOENT" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("сохраняет argv буквально, но не исполняет декларативный план", async () => {
  const literal = "$(touch shell-owned); > injected && exit 91";
  const argv = [
    "node",
    "-e",
    `if (process.argv[1] !== ${JSON.stringify(literal)}) process.exit(42)`,
    literal,
  ];
  const manifest = singleActionManifest(
    "task-app",
    "literal",
    automaticAction(argv),
  );
  await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
    await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "changed\n", "utf8");
    const plan = await buildVerificationPlan(planInput(fixture));
    const action = plan.actions.find((item) => item.id === "literal");

    assert.equal(plan.outcome, "planned");
    assert.ok(action, "literal action должна остаться в плане");
    assert.deepEqual(action.definition, automaticAction(argv));
    assert.equal(action.definition.argv.at(-1), literal);
    assert.equal(Object.hasOwn(action, "executionEligible"), false);
    assert.equal(Object.hasOwn(plan, "checks"), false);
    assert.equal(Object.hasOwn(plan, "actionResults"), false);
    assert.notEqual(plan.outcome.toUpperCase(), "PASSED");
    assert.equal(Object.hasOwn(verificationApi, "executeVerificationPlan"), false);
    await assert.rejects(readFile(join(fixture.repositoryRoot, "shell-owned")), { code: "ENOENT" });
    await assert.rejects(readFile(join(fixture.repositoryRoot, "injected")), { code: "ENOENT" });
  });
});

test("ручное обязательство и чтение плана никогда не маркируются passed", async () => {
  const manifest = singleActionManifest("task-app", "approval", obligationAction());
  await withWorkspace({ manifests: { "task-app": manifest } }, async (fixture) => {
    await writeFile(join(fixture.repositoryRoot, "src", "app.txt"), "candidate\n", "utf8");
    const plan = await buildVerificationPlan(planInput(fixture));

    assert.equal(plan.outcome, "action_required");
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.obligations.length, 1);
    assert.equal(Object.hasOwn(plan, "checks"), false);
    assert.equal(Object.hasOwn(plan, "actionResults"), false);
    assert.notEqual(plan.outcome.toUpperCase(), "PASSED");
  });
});
