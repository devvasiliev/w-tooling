import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, realpath, mkdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { provisionTasks, standardProperties, NotionClient, taskSchema, findTask, updateStatus, createTask } from "./notion-tasks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parent = "11111111111111111111111111111111";
const database = "22222222222222222222222222222222";
const source = "33333333333333333333333333333333";
const pageId = "44444444444444444444444444444444";
const project = { code: "ACME", name: "Acme", notion: { databaseId: source, properties: { code: "Ticket", status: "Phase" } } };
function metadata(properties) { return Object.fromEntries(Object.entries(properties).map(([name, property]) => [name, { name, type: Object.keys(property)[0], ...property }])); }

test("два независимых кода, путь с пробелами, повтор prepare и чистые соседние файлы", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "portable workspace ")));
  try {
    const tooling = join(workspace, "w-tooling");
    await cp(ROOT, tooling, { recursive: true, filter: path => ![".git", "node_modules", ".project", ".agents"].some(segment => path.split("/").includes(segment)) });
    await mkdir(join(workspace, "w-releases"));
    await mkdir(join(workspace, "teams/workspace"), { recursive: true });
    const projectPath = join(tooling, "config/project.json");
    const local = JSON.parse(await readFile(projectPath));
    local.repositories.push({ name: "workspace", path: "teams/workspace", role: "service" });
    await writeFile(projectPath, JSON.stringify(local));
    await writeFile(join(workspace, "AGENTS.md"), "workspace sentinel\n");
    await writeFile(join(workspace, "package.json"), "workspace sentinel\n");
    for (const code of ["ACME", "ZX9"]) {
      execFileSync("bash", [join(tooling, "prepare.sh"), "--code", code, "--name", `Project ${code}`]);
      const before = await readFile(join(tooling, "config/project.json"), "utf8");
      execFileSync("bash", [join(tooling, "prepare.sh")]);
      assert.equal(await readFile(join(tooling, "config/project.json"), "utf8"), before);
      assert.equal(JSON.parse(await readFile(join(workspace, "w-releases/config/project.json"))).code, code);
      execFileSync("bash", [join(tooling, "prepare.sh"), "--check"]);
      assert.ok((await stat(join(workspace, "w-releases/.agents/skills/prepare-env/SKILL.md"))).isFile());
    }
    assert.equal(await readFile(join(workspace, "AGENTS.md"), "utf8"), "workspace sentinel\n");
    assert.equal(await readFile(join(workspace, "package.json"), "utf8"), "workspace sentinel\n");
    const before = await readFile(join(tooling, "config/project.json"), "utf8");
    const releasePath = join(workspace, "w-releases/config/project.json");
    const savedRelease = await readFile(releasePath);
    await writeFile(releasePath, "invalid json");
    assert.throws(() => execFileSync("bash", [join(tooling, "prepare.sh"), "--code", "FAIL"], { stdio: "pipe" }));
    assert.equal(await readFile(projectPath, "utf8"), before);
    await writeFile(releasePath, savedRelease);
    await symlink(join(workspace, "AGENTS.md"), join(workspace, "w-releases/.codex/rules/foreign.md"));
    assert.throws(() => execFileSync("bash", [join(tooling, "prepare.sh"), "--code", "FAIL"], { stdio: "pipe" }));
    assert.equal(await readFile(join(tooling, "config/project.json"), "utf8"), before);
    assert.equal(await readFile(join(workspace, "AGENTS.md"), "utf8"), "workspace sentinel\n");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("создание базы сохраняет intent, ID и продолжает read-back без второго POST", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "notion-provision-")));
  const journalPath = join(root, "journal.json");
  let creates = 0; let reads = 0;
  let properties = metadata(standardProperties("ACME"));
  const client = { request: async (path, { method = "GET", body } = {}) => {
    if (path === "/databases" && method === "POST") {
      creates++;
      assert.equal(JSON.parse(await readFile(journalPath)).stage, "intent");
      assert.equal(body.initial_data_source.properties.ID.unique_id.prefix, "ACME");
      return { id: database };
    }
    if (path === `/databases/${database}`) {
      if (++reads === 1) throw new Error("read-back unavailable");
      return { id: database, parent: { page_id: parent } };
    }
    if (method === "PATCH") { properties = { ...properties, ...metadata(body.properties) }; return {}; }
    return { id: source, object: "data_source", properties };
  } };
  try {
    await assert.rejects(provisionTasks(client, project, { parent, journalPath }));
    assert.equal(JSON.parse(await readFile(journalPath)).databaseId, database);
    const connected = await provisionTasks(client, project, { parent, journalPath });
    assert.equal(connected.databaseId, source);
    await provisionTasks(client, project, { parent, journalPath });
    assert.equal(creates, 1);
    assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("потерянный ответ создания блокирует второй POST", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "notion-unknown-"))); let creates = 0;
  const client = new NotionClient({ token: "private-token", fetchImpl: async () => { creates++; throw new Error("lost response"); } });
  try {
    const args = { parent, journalPath: join(root, "intent.json") };
    await assert.rejects(provisionTasks(client, project, args), { code: "NOTION_WRITE_OUTCOME_UNKNOWN" });
    await assert.rejects(provisionTasks(client, project, args), { code: "NOTION_CREATE_OUTCOME_UNKNOWN" });
    assert.equal(creates, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("произвольная база с text ID и select статусом обходится без иерархии", async () => {
  const properties = metadata({ Caption: { title: {} }, Ticket: { rich_text: {} }, Phase: { select: { options: [{ name: "Queued" }, { name: "Shipped" }] } } });
  const page = { object: "page", id: pageId, parent: { data_source_id: source }, properties: {
    Caption: { type: "title", title: [{ text: { content: "Ship order" } }] },
    Ticket: { type: "rich_text", rich_text: [{ text: { content: "OPS-73" } }] },
    Phase: { type: "select", select: { name: "Queued" } },
  } };
  const writes = [];
  const client = new NotionClient({ token: "private-token", fetchImpl: async (url, options) => {
    const path = new URL(url).pathname.replace("/v1", "");
    const body = options.body ? JSON.parse(options.body) : null;
    let data;
    if (path.endsWith("/query")) data = { results: [page], has_more: false };
    else if (path.startsWith("/data_sources/")) data = { id: source, object: "data_source", properties };
    else if (options.method === "PATCH") { writes.push(body); Object.assign(page.properties, body.properties); data = page; }
    else if (options.method === "POST") { writes.push(body); data = { ...page, properties: body.properties }; }
    else data = page;
    return new Response(JSON.stringify(data), { status: 200 });
  } });
  assert.equal(taskSchema({ properties }, project.notion.properties).parent, null);
  assert.equal((await findTask(client, project, "OPS-73")).page.id, pageId);
  assert.equal((await updateStatus(client, project, "OPS-73", "Shipped")).status, "Shipped");
  await assert.rejects(updateStatus(client, project, "OPS-73", "Invented"), { code: "NOTION_STATUS_INVALID" });
  await createTask(client, project, { title: "Next order", code: "OPS-74" });
  assert.equal(writes.length, 2);
  assert.equal(writes[1].parent.data_source_id, source);
});
