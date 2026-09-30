#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { loadProject, SetupError } from "./project-config.mjs";
import { NotionClient, notionToken, inspectTasks, findTask, summarize, updateStatus, createTask, readBlockTree } from "./notion-tasks.mjs";

/** Общая команда использует схему подключённой базы и не меняет её автоматически. */
export async function run(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    config: { type: "string" }, title: { type: "string" }, code: { type: "string" },
    status: { type: "string" }, parent: { type: "string" }, strict: { type: "boolean" }, help: { type: "boolean" },
  } });
  const [command, reference, status] = positionals;
  if (!command || values.help || command === "help") {
    console.log("notion doctor | find CODE/URL | read CODE/URL | status CODE/URL STATUS | create --title TEXT [--status STATUS] [--parent CODE/URL]"); return;
  }
  if (!["doctor", "find", "read", "status", "create"].includes(command)) throw new SetupError("INVALID_COMMAND", "Неизвестная команда Notion.");
  const project = loadProject(values.config);
  const token = await notionToken(resolve(dirname(project.configPath), ".."));
  if (!token) throw new SetupError("NOTION_TOKEN_REQUIRED", "Задай NOTION_TOKEN или используй prepare.sh --token-stdin.");
  const client = new NotionClient({ token });
  let result;
  if (command === "doctor") {
    const { source, schema } = await inspectTasks(client, project);
    result = { source: source.id, properties: schema, ready: true };
  } else if (command === "create") result = await createTask(client, project, values);
  else if (command === "status") result = await updateStatus(client, project, reference, status);
  else {
    const selected = await findTask(client, project, reference);
    result = summarize(selected.page, selected.schema, project.code);
    if (command === "read") result.blocks = await readBlockTree(client, selected.page.id);
  }
  console.log(JSON.stringify(result, null, 2));
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) run().catch(error => { console.error(`${error.code || "NOTION_FAILED"}: ${error.message}`); process.exitCode = 1; });
