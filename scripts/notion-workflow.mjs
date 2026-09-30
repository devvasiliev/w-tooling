#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import {
  ALLOWED_STATUSES,
  NotionClient,
  TaskNotionError,
  backfillReleaseProcessV1,
  createBusinessRequirement,
  createTaskItem,
  finalizeStoryBusiness,
  findTask,
  inspectBusinessRequirements,
  inspectTaskItem,
  inspectWorkspace,
  loadConfig,
  normalizeNotionId,
  normalizeTaskType,
  pageStatus,
  pageReleaseProcess,
  pageTaskCode,
  pageTaskType,
  publishPlanningTask,
  queryAllPages,
  refreshTaskContents,
  releaseTask,
  syncReleaseTaskRelations,
  updateMasterSpecification,
  updateTaskStatus,
  verifyStoryReady,
} from "./notion-workflow-lib.mjs";

function usage() {
  return [
    "Команды:",
    "  npm run notion:workflow:doctor",
    "  npm run notion:workflow -- find CODE-N [--strict]",
    "  npm run notion:workflow -- inspect CODE-N --strict",
    "  npm run notion:workflow -- release-process-backfill CODE-N --approved --strict",
    '  npm run notion:workflow -- status CODE-N "Аналитика|Дизайн|Разработка|Тестирование" [--strict]',
    '  npm run notion:workflow -- status CODE-N "Ожидание релиза" --approved [--strict]',
    "  npm run notion:workflow -- create --type <тип> --title <название> --description <текст> [--step <шаг>] [--result <результат>] [--check <проверка>] [--approved] [параметры] --strict",
    "  npm run notion:workflow -- business-inspect --strict",
    "  npm run notion:workflow -- business-create --title <название> --description <текст> --snapshot-fingerprint <sha256> [--parent-id <page-id>] --strict",
    "  npm run notion:workflow -- master-update --page-id <page-id> --markdown <файл.md> --expected-fingerprint <sha256> --strict",
    "  npm run notion:workflow -- publish-plan CODE-N --change <каталог change> [--change <каталог change>] --strict",
    "  npm run notion:workflow -- content-refresh CODE-N --manifest <файл.json> (--dry-run|--approved) --strict",
    "  npm run notion:workflow -- story-check CODE-N --strict",
    "  npm run notion:workflow -- release-sync CODE-N --release-task CODE-M [--release-task CODE-K] --strict",
    "  npm run notion:workflow -- story-finalize CODE-N --business-outcome <changed|unchanged> --technical-requirement <capability/requirement> [--master-updates <json>] --approved --strict",
    "  npm run notion:workflow -- release CODE-N --spec <путь/spec.md> --approved [--strict]",
  ].join("\n");
}

function parseArguments(argv) {
  const positional = [];
  const flags = {
    strict: false,
    approved: false,
    businessSubitemApproved: false,
    releaseHistory: false,
    technicalDebt: false,
    dryRun: false,
    businessRequirementIds: [],
    steps: [],
    expectedResults: [],
    checks: [],
    changePaths: [],
    technicalRequirements: [],
    releaseTaskCodes: [],
  };
  const valueFlags = {
    "--spec": "specPath",
    "--type": "type",
    "--title": "title",
    "--description": "description",
    "--parent": "parentCode",
    "--story": "storyCode",
    "--discovered-release": "discoveredReleaseCode",
    "--priority": "priority",
    "--estimate": "estimatedCodeLines",
    "--expected": "expectedResult",
    "--actual": "actualResult",
    "--attachment": "attachmentPath",
    "--snapshot-fingerprint": "snapshotFingerprint",
    "--parent-id": "parentId",
    "--page-id": "pageId",
    "--markdown": "markdownPath",
    "--expected-fingerprint": "expectedFingerprint",
    "--business-outcome": "businessOutcome",
    "--master-updates": "masterUpdatesPath",
    "--manifest": "manifestPath",
  };
  const repeatedFlags = {
    "--business": "businessRequirementIds",
    "--step": "steps",
    "--result": "expectedResults",
    "--check": "checks",
    "--change": "changePaths",
    "--technical-requirement": "technicalRequirements",
    "--release-task": "releaseTaskCodes",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict") flags.strict = true;
    else if (argument === "--approved") flags.approved = true;
    else if (argument === "--business-subitem-approved")
      flags.businessSubitemApproved = true;
    else if (argument === "--release-history") flags.releaseHistory = true;
    else if (argument === "--technical-debt") flags.technicalDebt = true;
    else if (argument === "--dry-run") flags.dryRun = true;
    else if (valueFlags[argument] || repeatedFlags[argument]) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new TaskNotionError(
          "INVALID_ARGUMENT",
          `Не задано значение параметра ${argument}`,
        );
      }
      if (repeatedFlags[argument]) flags[repeatedFlags[argument]].push(value);
      else flags[valueFlags[argument]] = value;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new TaskNotionError(
        "INVALID_ARGUMENT",
        `Неизвестный параметр: ${argument}`,
      );
    } else positional.push(argument);
  }
  return { positional, flags };
}

const output = (stream, message) => stream.write(`${message}\n`);

function outputParentUpdates(stream, updates = []) {
  for (const update of updates) {
    output(
      stream,
      `Родительская задача «${update.title || update.pageId}»: «${update.previousStatus || "не задан"}» → «${update.targetStatus}».`,
    );
  }
}

export async function runCli(
  argv,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    clientFactory,
  } = {},
) {
  let strict = argv.includes("--strict");
  try {
    const parsed = parseArguments(argv);
    strict = parsed.flags.strict;
    const [command, code, status] = parsed.positional;
    if (!command || command === "help") {
      output(stdout, usage());
      return 0;
    }
    const commands = [
      "doctor",
      "find",
      "inspect",
      "release-process-backfill",
      "status",
      "create",
      "business-inspect",
      "business-create",
      "master-update",
      "publish-plan",
      "content-refresh",
      "story-check",
      "release-sync",
      "story-finalize",
      "release",
    ];
    if (!commands.includes(command)) {
      throw new TaskNotionError(
        "INVALID_COMMAND",
        `Неизвестная команда: ${command}`,
      );
    }
    if (
      ["find", "inspect", "release-process-backfill", "status", "publish-plan", "content-refresh", "story-check", "release-sync", "story-finalize", "release"].includes(command) &&
      !code
    ) {
      throw new TaskNotionError(
        "INVALID_ARGUMENT",
        "Не указан код задачи CODE-N",
      );
    }
    if (command === "status" && !status) {
      throw new TaskNotionError("INVALID_ARGUMENT", "Не указан новый статус");
    }

    const needsBusiness = [
      "doctor",
      "inspect",
      "create",
      "business-inspect",
      "business-create",
      "master-update",
      "story-finalize",
      "release",
    ].includes(command);
    const config = await loadConfig({ env, requireBusiness: needsBusiness });
    const client = clientFactory
      ? clientFactory(config)
      : new NotionClient({ token: config.token });

    if (command === "doctor") {
      const { source, schema, businessSource, businessSchema } =
        await inspectWorkspace(client, config);
      const [business, backlogPages] = await Promise.all([
        inspectBusinessRequirements(client, config),
        queryAllPages(client, source.id),
      ]);
      const legacy = backlogPages
        .filter((page) => !pageTaskType(page, schema))
        .map((page) => pageTaskCode(page, schema.idName) || page.id);
      output(stdout, `Notion доступен. Бэклог: ${source.id}`);
      output(
        stdout,
        `Свойства Бэклога: ID «${schema.idName}», title «${schema.titleName}», status «${schema.statusName}», parent «${schema.parentName}», type «${schema.typeName}», priority «${schema.priorityName}», size «${schema.sizeName}», technical debt «${schema.technicalDebtName}», release date «${schema.releaseDateName}», release «${schema.releaseName}», release bug «${schema.releaseBugName}», incoming tasks «${schema.incomingReleaseTasksName}», release process «${schema.releaseProcessName}».`,
      );
      output(
        stdout,
        `Бизнес-требования: ${businessSource.id}; title «${businessSchema.titleName}», parent «${businessSchema.parentName}», sub-item «${businessSchema.subItemName}», страниц ${business.items.length}.`,
      );
      output(
        stdout,
        legacy.length
          ? `Legacy-элементы без типа: ${legacy.length} (${legacy.join(", ")}).`
          : "Legacy-элементов без типа нет.",
      );
      if (config.insecureFileMode) {
        output(
          stderr,
          `Предупреждение: ограничь права на ${config.configPath} командой chmod 600.`,
        );
      }
      return 0;
    }

    if (command === "find") {
      const task = await findTask(client, config, code);
      output(
        stdout,
        `${code}: «${task.title}», page ${task.page.id}, статус «${pageStatus(task.page, task.schema) || "не задан"}», ${task.isChild ? "sub-item" : "верхний уровень"}.`,
      );
      return 0;
    }

    if (command === "inspect") {
      const result = await inspectTaskItem(client, config, code);
      output(
        stdout,
        JSON.stringify(
          {
            code,
            title: result.title,
            pageId: result.page.id,
            type: result.type,
            status: pageStatus(result.page, result.schema),
            priority: result.priority || "",
            size: result.size || "",
            releaseProcess: pageReleaseProcess(result.page, result.schema),
            technicalDebt: result.technicalDebt || false,
            technicalDebtEpicId: result.technicalDebtEpicId || "",
            parentId: result.parentId || "",
            storyId: result.storyId || "",
            discoveredReleaseId: result.discoveredReleaseId || "",
            businessIds: result.businessIds || [],
            warnings: result.warnings,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (command === "release-process-backfill") {
      const result = await backfillReleaseProcessV1(
        client,
        config,
        code,
        { approved: parsed.flags.approved },
      );
      output(
        stdout,
        `${result.rootCode}: release-процесс v1 установлен для ${result.changed} из ${result.total} элементов; уже соответствовали ${result.unchanged}.`,
      );
      return 0;
    }

    if (command === "status") {
      const result = await updateTaskStatus(client, config, code, status, {
        approved: parsed.flags.approved,
      });
      output(
        stdout,
        result.changed
          ? `${code}: «${result.title}» переведена из «${result.previousStatus || "не задан"}» в «${result.targetStatus}».`
          : `${code}: статус «${result.targetStatus}» уже установлен.`,
      );
      outputParentUpdates(stdout, result.parentUpdates);
      return 0;
    }

    if (command === "create") {
      const result = await createTaskItem(client, config, {
        ...parsed.flags,
        type: normalizeTaskType(parsed.flags.type),
        estimatedCodeLines:
          parsed.flags.estimatedCodeLines === undefined
            ? undefined
            : Number(parsed.flags.estimatedCodeLines),
        businessRequirementIds: parsed.flags.businessRequirementIds.map(
          normalizeNotionId,
        ),
      });
      output(
        stdout,
        `${result.resumed ? "Продолжена" : "Создана"} страница ${result.page.id}: тип «${result.type}», приоритет «${result.priority}»${result.size ? `, размер «${result.size}»` : ", размер не применяется"}.`,
      );
      return 0;
    }

    if (command === "business-inspect") {
      const result = await inspectBusinessRequirements(client, config);
      output(
        stdout,
        JSON.stringify(
          {
            sourceId: result.source.id,
            snapshotFingerprint: result.snapshotFingerprint,
            items: result.items.map((item) => ({
              id: item.id,
              title: item.title,
              parentId: item.parentId,
              childIds: item.childIds,
              content: item.content,
              master: item.master,
            })),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (command === "business-create") {
      const result = await createBusinessRequirement(client, config, {
        title: parsed.flags.title,
        description: parsed.flags.description,
        parentId: normalizeNotionId(parsed.flags.parentId),
        snapshotFingerprint: parsed.flags.snapshotFingerprint,
      });
      output(
        stdout,
        `${result.resumed ? "Продолжено" : "Создано"} бизнес-требование ${result.page.id}.`,
      );
      return 0;
    }

    if (command === "master-update") {
      if (!parsed.flags.markdownPath) {
        throw new TaskNotionError(
          "INVALID_ARGUMENT",
          "Не указан файл мастер-спецификации через --markdown",
        );
      }
      const markdown = await readFile(parsed.flags.markdownPath, "utf8");
      const result = await updateMasterSpecification(
        client,
        config,
        normalizeNotionId(parsed.flags.pageId),
        {
          markdown,
          expectedFingerprint: parsed.flags.expectedFingerprint,
        },
      );
      output(stdout, `Мастер-спецификация ${result.pageId} обновлена.`);
      return 0;
    }

    if (command === "publish-plan") {
      const result = await publishPlanningTask(client, config, code, {
        changePaths: parsed.flags.changePaths,
      });
      output(
        stdout,
        `${code}: плановые документы ${result.publication.replaced ? "обновлены" : "добавлены"}; статус не изменён.`,
      );
      return 0;
    }

    if (command === "content-refresh") {
      const result = await refreshTaskContents(client, config, code, {
        approved: parsed.flags.approved,
        dryRun: parsed.flags.dryRun,
        manifestPath: parsed.flags.manifestPath,
      });
      output(
        stdout,
        result.dryRun
          ? `${code}: манифест проверен; карточек: ${result.updated}; переименований: ${result.renamed}.`
          : `${code}: обновлено карточек: ${result.updated}; переименовано: ${result.renamed}.`,
      );
      return 0;
    }

    if (command === "story-check") {
      const result = await verifyStoryReady(client, config, code);
      output(
        stdout,
        `${code}: история готова к отдельной приёмке; проверено задач: ${result.checkedChildren.length}.`,
      );
      return 0;
    }

    if (command === "release-sync") {
      const result = await syncReleaseTaskRelations(
        client,
        config,
        code,
        parsed.flags.releaseTaskCodes,
      );
      output(
        stdout,
        `${code}: отображаемых элементов: ${result.selected.length}; исключено исходных задач: ${result.excluded.length}.`,
      );
      output(
        stdout,
        `Представления: «Входящие задачи» ${result.views.incoming.created ? "создано" : "обновлено"}, «Релизы» ${result.views.history.created ? "создано" : "обновлено"}.`,
      );
      for (const item of result.excluded) {
        output(stdout, `Исключён ${item.code}: статус «${item.status}», причина «${item.reason}».`);
      }
      return 0;
    }

    if (command === "story-finalize") {
      if (!["changed", "unchanged"].includes(parsed.flags.businessOutcome)) {
        throw new TaskNotionError(
          "INVALID_ARGUMENT",
          "--business-outcome принимает changed или unchanged",
        );
      }
      let masterUpdates = [];
      if (parsed.flags.masterUpdatesPath) {
        masterUpdates = JSON.parse(
          await readFile(parsed.flags.masterUpdatesPath, "utf8"),
        );
      }
      const result = await finalizeStoryBusiness(client, config, code, {
        approved: parsed.flags.approved,
        businessChanged: parsed.flags.businessOutcome === "changed",
        technicalRequirements: parsed.flags.technicalRequirements,
        masterUpdates,
      });
      output(
        stdout,
        `${code}: зафиксирован результат business ${result.businessOutcome}; технических requirements: ${result.technicalRequirements.length}.`,
      );
      return 0;
    }

    const result = await releaseTask(client, config, code, {
      approved: parsed.flags.approved,
      specPath: parsed.flags.specPath,
    });
    output(
      stdout,
      `${code}: спецификация ${result.publication.replaced ? "обновлена" : "добавлена"}, статус «Ожидание релиза»${result.statusChanged ? " установлен" : " уже был установлен"}.`,
    );
    outputParentUpdates(stdout, result.parentUpdates);
    return 0;
  } catch (error) {
    const known = error instanceof TaskNotionError;
    const message = known
      ? error.message
      : "Неожиданная ошибка локальной интеграции Notion";
    const argumentError = known && !error.external;
    if (argumentError || strict) {
      output(stderr, `Ошибка: ${message}`);
      if (argumentError) output(stderr, usage());
      return argumentError ? 2 : 1;
    }
    output(
      stderr,
      `Предупреждение: ${message}. Работа продолжается без обновления Notion.`,
    );
    return 0;
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  process.exitCode = await runCli(process.argv.slice(2));
}

export { ALLOWED_STATUSES };
