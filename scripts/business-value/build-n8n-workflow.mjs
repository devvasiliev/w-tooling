#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const actorExpression = "={{ $('Запуск: код задачи').first().json.user.email || $('Запуск: код задачи').first().json.user.id }}";

const headers = () => ({
  parameters: [
    { name: "x-task-run-origin", value: "n8n-form" },
    { name: "x-identity-serviceenticated-user", value: actorExpression },
  ],
});

const responseOptions = {
  response: {
    response: {
      neverError: true,
      responseFormat: "json",
    },
  },
};

const baseNode = ({ id, name, type, typeVersion, position, parameters, notes }) => ({
  parameters,
  id,
  name,
  type,
  typeVersion,
  position,
  notesInFlow: true,
  notes,
});

const codeNode = (id, name, position, jsCode, notes) =>
  baseNode({
    id,
    name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    parameters: { mode: "runOnceForAllItems", jsCode },
    notes,
  });

const ifNode = (id, name, position, notes) =>
  baseNode({
    id,
    name,
    type: "n8n-nodes-base.if",
    typeVersion: 2.3,
    position,
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: "",
          typeValidation: "strict",
          version: 3,
        },
        conditions: [
          {
            id: `${id}-condition`,
            leftValue: "={{ $json.flowOk }}",
            rightValue: "",
            operator: { type: "boolean", operation: "true", singleValue: true },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
    notes,
  });

const httpNode = (id, name, position, url, jsonBody, notes) =>
  baseNode({
    id,
    name,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.4,
    position,
    parameters: {
      method: "POST",
      url,
      sendHeaders: true,
      specifyHeaders: "keypair",
      headerParameters: headers(),
      ...(jsonBody
        ? {
            sendBody: true,
            contentType: "json",
            specifyBody: "json",
            jsonBody,
          }
        : {}),
      options: responseOptions,
    },
    notes,
  });

const normalizedResponse = (validationSource) => `const data = $input.first().json;
${validationSource}
return [{ json: { ...data, flowOk, reasonCode, human, runId } }];`;

const validateInput = `const data = $input.first().json;
const taskCode = String(data.taskCode || '').trim().toUpperCase();
const actor = data.user?.email || data.user?.id || '';
const flowOk = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(taskCode) && Boolean(actor);
return [{ json: {
  ...data,
  taskCode,
  flowOk,
  reasonCode: flowOk ? 'INPUT_VALID' : 'INPUT_INVALID',
  human: flowOk
    ? 'Код задачи и пользователь подтверждены.'
    : 'Укажи код задачи вида ACME-123 и войди в n8n пользователем с правом запуска workflow.',
} }];`;

const validatePrepare = normalizedResponse(`const runId = data?.result?.runId || '';
const status = data?.result?.status || '';
const responseValid = data?.ok === true && /^[0-9a-f-]{36}$/.test(runId) && ['PREPARED', 'NEEDS_INPUT'].includes(status);
const flowOk = responseValid && status === 'PREPARED';
const reasonCode = responseValid ? (data.reasonCode || status) : (data.reasonCode || 'PREPARE_RESPONSE_INVALID');
const human = responseValid ? String(data.human || '') : 'Runner вернул повреждённый prepare response.';`);

const validateResearch = normalizedResponse(`const runId = $('Проверка prepare').first().json.runId;
const status = data?.result?.status || '';
const flowOk = data?.ok === true && ['RESEARCHED', 'RESEARCH_SKIPPED'].includes(status);
const reasonCode = flowOk ? String(data.reasonCode || status) : String(data.reasonCode || 'RESEARCH_RESPONSE_INVALID');
const human = flowOk ? String(data.human || 'Research завершён.') : String(data.message || data.human || 'Research stage завершился ошибкой.');`);

const validateAnalyze = normalizedResponse(`const runId = $('Проверка prepare').first().json.runId;
const flowOk = data?.ok === true && data?.result?.status === 'ANALYZED' && data?.reasonCode === 'MODEL_OUTPUT_VALID';
const reasonCode = flowOk ? data.reasonCode : String(data.reasonCode || 'ANALYZE_RESPONSE_INVALID');
const human = flowOk ? String(data.human || 'Анализ завершён.') : String(data.message || data.human || 'Analysis stage завершился ошибкой.');`);

const validateScore = normalizedResponse(`const runId = $('Проверка prepare').first().json.runId;
const score = data?.result?.score;
const responseValid = data?.ok === true && data?.result?.status === 'SCORED' && score && typeof score.status === 'string';
const flowOk = responseValid && !['BLOCKED', 'NEEDS_INPUT'].includes(score.status) && Number.isInteger(score.value);
const reasonCode = responseValid ? String(data.reasonCode || score.status) : String(data.reasonCode || 'SCORE_RESPONSE_INVALID');
const human = responseValid ? String(data.human || '') : String(data.message || 'Scorer вернул повреждённый response.');`);

const validatePreview = `const data = $input.first().json;
const preview = data?.result;
const runId = $('Проверка prepare').first().json.runId;
const responseValid = data?.ok === true && data?.reasonCode === 'PREVIEW_READY' && preview?.runId === runId && typeof preview?.managedSectionMarkdown === 'string';
const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const score = preview?.proposed?.value;
const summary = responseValid
  ? '<p><strong>' + escapeHtml(preview.taskCode) + '</strong>: Business Value <strong>' + escapeHtml(score) + '</strong>; статус ' + escapeHtml(preview.proposed.status) + '; уверенность ' + escapeHtml(preview.proposed.confidence) + '.</p><pre style="white-space:pre-wrap">' + escapeHtml(preview.managedSectionMarkdown) + '</pre>'
  : '';
return [{ json: {
  ...data,
  runId,
  flowOk: responseValid,
  reasonCode: responseValid ? 'PREVIEW_READY' : String(data.reasonCode || 'PREVIEW_RESPONSE_INVALID'),
  human: responseValid ? String(data.human || 'Preview готов.') : String(data.message || data.human || 'Preview stage завершился ошибкой.'),
  previewHtml: summary,
} }];`;

const validateDecision = `const data = $input.first().json;
const decision = String(data.decision || '');
const allowed = ['Опубликовать', 'Отменить'];
const valid = allowed.includes(decision);
return [{ json: {
  ...data,
  runId: $('Проверка prepare').first().json.runId,
  flowOk: valid && decision === 'Опубликовать',
  reasonCode: valid ? (decision === 'Опубликовать' ? 'USER_APPROVED' : 'USER_CANCELLED') : 'DECISION_INVALID',
  human: valid ? 'Решение пользователя подтверждено.' : 'Выбери «Опубликовать» или «Отменить».',
} }];`;

const validatePublish = normalizedResponse(`const runId = $('Проверка prepare').first().json.runId;
const flowOk = data?.ok === true && data?.reasonCode === 'PUBLISHED' && Number.isInteger(data?.result?.value);
const reasonCode = flowOk ? 'PUBLISHED' : String(data.reasonCode || 'PUBLISH_RESPONSE_INVALID');
const human = flowOk ? String(data.human || 'Business Value опубликован.') : String(data.message || data.human || 'Публикация завершилась ошибкой; проверь rollback по run id.');`);

const validateCancel = normalizedResponse(`const runId = $('Проверка prepare').first().json.runId;
const flowOk = data?.ok === true && data?.reasonCode === 'USER_CANCELLED';
const reasonCode = flowOk ? 'USER_CANCELLED' : String(data.reasonCode || 'CANCEL_RESPONSE_INVALID');
const human = flowOk ? String(data.human || 'Оценка отменена без записи в Notion.') : String(data.message || data.human || 'Cancel stage завершился ошибкой.');`);

const nodes = [
  baseNode({
    id: "09048be5-5ac0-4e74-9509-2ddf29378b05",
    name: "Запуск: код задачи",
    type: "n8n-nodes-base.formTrigger",
    typeVersion: 2.6,
    position: [-1600, 0],
    parameters: {
      authentication: "n8nUserAuth",
      requireExecuteAccess: true,
      formTitle: "Оценка Business Value",
      formDescription: "Введи код Эпика, Истории, Бага или Задачи. Оценка не запустится без этого действия.",
      formFields: {
        values: [
          {
            fieldLabel: "код задачи",
            fieldName: "taskCode",
            fieldType: "text",
            placeholder: "ACME-123",
            requiredField: true,
          },
        ],
      },
      responseMode: "lastNode",
      options: {
        path: "business-value",
        buttonLabel: "Подготовить оценку",
        appendAttribution: false,
        includeUserInOutput: true,
        ignoreBots: true,
      },
    },
    notes: "Единственная точка запуска. Требует вход в n8n и право Execute для workflow.",
  }),
  codeNode("a9b683e1-e536-4fa9-a909-242ce848be8e", "Проверка кода задачи", [-1380, 0], validateInput, "Строго проверяет код и наличие аутентифицированного пользователя."),
  ifNode("13bb3362-d13d-4b95-a9f6-3305a07c3af0", "код задачи допустим?", [-1160, 0], "Невалидный ввод сразу завершает форму без обращения к runner."),
  httpNode("2202e86c-aa29-489f-a86b-2032d55c31bb", "Prepare", [-920, -120], "http://business-value-runner:8080/v1/runs/prepare", "={{ JSON.stringify({ taskCode: $('Проверка кода задачи').first().json.taskCode }) }}", "Читает одну карточку Notion и выполняет preflight. Модель не вызывается."),
  codeNode("4fd87e88-d4a9-4eb9-bbd8-346a9348c137", "Проверка prepare", [-700, -120], validatePrepare, "Проверяет typed prepare response и сохраняет run id."),
  ifNode("2db0efec-3885-489f-8a02-e97270dd325d", "Данных достаточно?", [-480, -120], "При NEEDS_INPUT числовая оценка не выполняется."),
  httpNode("24fc6d9e-a722-44d8-8cf2-b82c4e981a57", "Research", [-240, -240], "=http://business-value-runner:8080/v1/runs/{{$('Проверка prepare').first().json.runId}}/research", null, "Формирует обезличенный brief и при возможности ищет внешнее evidence."),
  codeNode("b47f5fbf-fe8e-4dc4-9b1b-91c135b21013", "Проверка research", [-20, -240], validateResearch, "Допускает валидное evidence либо privacy-safe пропуск поиска."),
  ifNode("61e21eb8-c4c8-44c3-b882-4483279451de", "Research завершён?", [200, -240], "При ошибке модельный анализ не выполняется."),
  httpNode("4f31acb6-fe36-4afc-bf23-1890608c0723", "Analyze", [440, -360], "=http://business-value-runner:8080/v1/runs/{{$('Проверка prepare').first().json.runId}}/analyze", null, "Tool-less structured analysis. Вес и итог модели недоступны."),
  codeNode("014a7e18-5090-4997-a4eb-7a8534d9491e", "Проверка analyze", [660, -360], validateAnalyze, "Пропускает только schema-valid assessment."),
  ifNode("cb467318-23bf-469e-ac5a-f291ca14ba0c", "Assessment валиден?", [880, -360], "Невалидный model output не попадает в scorer."),
  httpNode("fd1d6888-c91b-4bd2-a341-8ea97d0b72bc", "Score", [1120, -480], "=http://business-value-runner:8080/v1/runs/{{$('Проверка prepare').first().json.runId}}/score", null, "Deterministic scorer применяет baseline, caps, evidence и дедупликацию."),
  codeNode("814e9952-04a8-45cb-92e1-ec7c9673059c", "Проверка score", [1340, -480], validateScore, "Блокирует preview при NEEDS_INPUT или material downside."),
  ifNode("26cc41f8-7cfb-41d5-9594-c25f886104eb", "Число публикуемо?", [1560, -480], "Число существует только после механического scorer."),
  httpNode("04d7302e-c08a-4cbf-b25b-fd691984080e", "Preview", [1800, -600], "=http://business-value-runner:8080/v1/runs/{{$('Проверка prepare').first().json.runId}}/preview", null, "Повторно читает Notion, проверяет fingerprint и строит полный diff."),
  codeNode("0cde4fb4-5d09-4340-813c-413a50d442e7", "Проверка preview", [2020, -600], validatePreview, "Проверяет preview и HTML-экранирует его перед показом."),
  ifNode("6cf0c4b9-c46c-45ce-b4f5-4197e090db87", "Preview валиден?", [2240, -600], "Только валидный и актуальный preview доступен пользователю."),
  baseNode({
    id: "613d2f97-91dc-481d-9a9b-5712387c4569",
    name: "Подтверждение preview",
    type: "n8n-nodes-base.form",
    typeVersion: 2.5,
    position: [2480, -720],
    parameters: {
      operation: "page",
      defineForm: "json",
      jsonOutput: "={{ JSON.stringify([{ fieldType: 'html', elementName: 'preview', html: $json.previewHtml }, { fieldLabel: 'Решение', fieldName: 'decision', fieldType: 'radio', fieldOptions: { values: [{ option: 'Опубликовать' }, { option: 'Отменить' }] }, requiredField: true }]) }}",
      options: {
        formTitle: "Проверка Business Value",
        formDescription: "До подтверждения Notion не изменяется.",
        buttonLabel: "Подтвердить решение",
      },
    },
    notes: "Явная human-in-the-loop граница перед первой мутацией Notion.",
  }),
  codeNode("c15822ee-cf4a-489d-9449-75e6cca82f08", "Проверка решения", [2700, -720], validateDecision, "Принимает только «Опубликовать» или «Отменить»."),
  ifNode("9ad405d1-256e-4fb2-8405-b72ac30475f1", "Опубликовать?", [2920, -720], "Разделяет publish и cancel без неявного решения."),
  httpNode("edac6654-d476-4204-b3f5-68555f04930a", "Publish", [3160, -840], "=http://business-value-runner:8080/v1/runs/{{$('Проверка prepare').first().json.runId}}/publish", null, "Optimistic publication с rollback при конфликте."),
  codeNode("b3e1add2-d735-4eeb-9b68-0371155f8c4c", "Проверка publish", [3380, -840], validatePublish, "Показывает подтверждённый результат либо typed failure."),
  httpNode("fc6f8ec0-e27e-4525-afc9-8e804d969130", "Cancel", [3160, -600], "=http://business-value-runner:8080/v1/runs/{{$('Проверка prepare').first().json.runId}}/cancel", null, "Отменяет preview без мутаций Notion."),
  codeNode("ef407a3c-e33a-4feb-8e53-ff8a1204c061", "Проверка cancel", [3380, -600], validateCancel, "Подтверждает отсутствие публикации."),
  baseNode({
    id: "c9ac294b-d04a-4dbd-aace-3242619ee3ce",
    name: "Результат",
    type: "n8n-nodes-base.form",
    typeVersion: 2.5,
    position: [3620, -120],
    parameters: {
      operation: "completion",
      respondWith: "text",
      completionTitle: "={{ $json.flowOk ? 'Операция завершена' : 'Оценка остановлена' }}",
      completionMessage: "={{ String($json.human || $json.message || 'Нет результата') + '\n\nКод: ' + String($json.reasonCode || 'UNKNOWN') + ($json.runId ? '\nRun ID: ' + $json.runId : '') }}",
      options: { formTitle: "Оценка Business Value" },
    },
    notes: "Единый человекочитаемый финал для success, cancel, needs-input и errors.",
  }),
];

const connections = {};
const connect = (from, to, output = 0) => {
  connections[from] ||= { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: "main", index: 0 });
};

connect("Запуск: код задачи", "Проверка кода задачи");
connect("Проверка кода задачи", "код задачи допустим?");
connect("код задачи допустим?", "Prepare", 0);
connect("код задачи допустим?", "Результат", 1);
connect("Prepare", "Проверка prepare");
connect("Проверка prepare", "Данных достаточно?");
connect("Данных достаточно?", "Research", 0);
connect("Данных достаточно?", "Результат", 1);
connect("Research", "Проверка research");
connect("Проверка research", "Research завершён?");
connect("Research завершён?", "Analyze", 0);
connect("Research завершён?", "Результат", 1);
connect("Analyze", "Проверка analyze");
connect("Проверка analyze", "Assessment валиден?");
connect("Assessment валиден?", "Score", 0);
connect("Assessment валиден?", "Результат", 1);
connect("Score", "Проверка score");
connect("Проверка score", "Число публикуемо?");
connect("Число публикуемо?", "Preview", 0);
connect("Число публикуемо?", "Результат", 1);
connect("Preview", "Проверка preview");
connect("Проверка preview", "Preview валиден?");
connect("Preview валиден?", "Подтверждение preview", 0);
connect("Preview валиден?", "Результат", 1);
connect("Подтверждение preview", "Проверка решения");
connect("Проверка решения", "Опубликовать?");
connect("Опубликовать?", "Publish", 0);
connect("Опубликовать?", "Cancel", 1);
connect("Publish", "Проверка publish");
connect("Проверка publish", "Результат");
connect("Cancel", "Проверка cancel");
connect("Проверка cancel", "Результат");

export const workflow = {
  name: "Оценка Business Value",
  nodes,
  connections,
  settings: {
    executionOrder: "v1",
    saveDataErrorExecution: "all",
    saveDataSuccessExecution: "none",
    saveManualExecutions: false,
    saveExecutionProgress: false,
    timezone: "UTC",
  },
};

if (process.argv[1]?.endsWith("build-n8n-workflow.mjs")) {
  const target = resolve(process.argv[2] || "templates/n8n/business-value/workflow.json");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(workflow, null, 2)}\n`);
  process.stdout.write(`${target}\n`);
}
