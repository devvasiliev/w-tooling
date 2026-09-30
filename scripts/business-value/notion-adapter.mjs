import {
  blockText,
  pageTaskType,
  pageTitle,
  readBlockTree,
} from "../notion-workflow-lib.mjs";
import { buildSignificantFingerprint } from "./fingerprint.mjs";
import {
  parseManagedSections,
  renameManagedToggleBody,
} from "./managed-section.mjs";
import { blocksToMarkdown, readTaskSource } from "./source.mjs";

const WRITABLE_BV_FIELDS = [
  "BV значение",
  "BV результат",
  "BV уверенность",
  "BV baseline",
  "BV версия модели",
  "BV рассчитан",
  "BV fingerprint",
];

const richTextValue = (property) =>
  (property?.rich_text || []).map((item) => item.plain_text || item.text?.content || "").join("");

const pageValue = (property) => {
  if (!property) return null;
  if (property.type === "number") return property.number;
  if (property.type === "select") return property.select?.name || null;
  if (property.type === "rich_text") return richTextValue(property);
  if (property.type === "date") return property.date?.start || null;
  return null;
};

const textObject = (content) => ({
  type: "text",
  text: { content: String(content) },
});

const pagePropertyBody = (name, value) => {
  if (["BV значение", "BV уверенность"].includes(name)) {
    return { number: value ?? null };
  }
  if (name === "BV результат") {
    return { select: value ? { name: value } : null };
  }
  if (["BV baseline", "BV версия модели", "BV fingerprint"].includes(name)) {
    return { rich_text: value === null || value === undefined ? [] : [textObject(value)] };
  }
  if (name === "BV рассчитан") {
    return { date: value ? { start: value } : null };
  }
  throw new Error(`UNSUPPORTED_BV_PROPERTY: ${name}`);
};

export class NotionBusinessValueAdapter {
  constructor({ client, config, taskCode }) {
    this.client = client;
    this.config = config;
    this.taskCode = taskCode;
    this.context = null;
  }

  async initialize() {
    if (!this.context) {
      this.context = await readTaskSource(this.client, this.config, this.taskCode);
    }
    return this.context;
  }

  async currentSource(page, blocks) {
    const context = await this.initialize();
    return {
      ...context.source,
      taskType: pageTaskType(page, context.schema),
      title: pageTitle(page, context.schema.titleName),
      descriptionMarkdown: blocksToMarkdown(blocks),
      descriptionBlocks: blocks,
      properties: page.properties || {},
    };
  }

  async readPublicationState(pageId) {
    const context = await this.initialize();
    const resolvedPageId = pageId || context.pageId;
    const [page, blocks] = await Promise.all([
      this.client.request(`/pages/${resolvedPageId}`),
      readBlockTree(this.client, resolvedPageId),
    ]);
    const source = await this.currentSource(page, blocks);
    const managed = parseManagedSections(blocks);
    const properties = page.properties || {};
    return {
      fingerprint: buildSignificantFingerprint(source),
      source,
      bvFields: Object.fromEntries(
        WRITABLE_BV_FIELDS.map((name) => [name, pageValue(properties[name])]),
      ),
      canonicalSection: managed.canonical,
      temporarySections: managed.temporary,
      formulaCurrent:
        properties["BV актуален"]?.formula?.type === "boolean"
          ? properties["BV актуален"].formula.boolean
          : false,
      visibleBusinessValue:
        properties["Business Value"]?.formula?.type === "number"
          ? properties["Business Value"].formula.number
          : null,
      displayStatus:
        properties["BV статус"]?.formula?.type === "string"
          ? properties["BV статус"].formula.string
          : "Не оценено",
      lastEditedBy: properties["BV изменил"]?.last_edited_by || null,
      lastEditedTime: properties["BV изменено"]?.last_edited_time || null,
      page,
      blocks,
      pageUrl: page.url || "",
    };
  }

  async createTemporary(pageId, toggle) {
    const response = await this.client.request(`/blocks/${pageId}/children`, {
      method: "PATCH",
      body: { children: [toggle] },
    });
    const created = response.results?.[0];
    if (!created?.id) throw new Error("NOTION_TEMPORARY_BLOCK_MISSING");
    return created;
  }

  async readManaged(blockId) {
    const [block, children] = await Promise.all([
      this.client.request(`/blocks/${blockId}`),
      readBlockTree(this.client, blockId),
    ]);
    return { ...block, children };
  }

  async updateFields(pageId, fields) {
    return this.client.request(`/pages/${pageId}`, {
      method: "PATCH",
      body: {
        properties: Object.fromEntries(
          Object.entries(fields).map(([name, value]) => [
            name,
            pagePropertyBody(name, value),
          ]),
        ),
      },
    });
  }

  async archiveBlock(blockId, archived) {
    return this.client.request(`/blocks/${blockId}`, {
      method: "PATCH",
      body: { archived },
    });
  }

  async renameBlock(blockId, title) {
    return this.client.request(`/blocks/${blockId}`, {
      method: "PATCH",
      body: renameManagedToggleBody(title),
    });
  }
}

export { pagePropertyBody, pageValue, WRITABLE_BV_FIELDS };
