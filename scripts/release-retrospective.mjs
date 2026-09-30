import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as notion from './notion-workflow-lib.mjs';
import { loadProject } from './project-config.mjs';

const requireThat = (condition, message) => { if (!condition) throw new notion.TaskNotionError('RETROSPECTIVE_CONFLICT', message); };
function repositoryPath(repositories, name) {
  if (typeof repositories === 'string') return resolve(repositories, name);
  requireThat(repositories.has(name), `Репозиторий ${name} отсутствует в конфигурации проекта.`);
  return repositories.get(name);
}
async function createItem(client, config, input) {
  for (let attempt = 0; ; attempt++) {
    try { return await notion.createTaskItem(client, config, input); }
    catch (error) {
      if (error.code !== 'TASK_NOT_FOUND' || !input.parentCode || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

const paragraph = content => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content } }] } });
async function save(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

/** До записи проверяет принадлежность подтверждающего коммита фактически выпущенной поставке. */
export function validateRetrospective(plan, history, repositories) {
  requireThat(plan.schemaVersion === 1 && /^[A-Z][A-Z0-9]*-0+$/u.test(plan.governingTask || ''), 'Нужен явный план ретроспективного восстановления с техническим кодом проекта.');
  const keys = new Set();
  for (const milestone of plan.milestones) {
    requireThat(!keys.has(milestone.key) && milestone.tasks.length > 0, 'Повторная или пустая веха.'); keys.add(milestone.key);
    const repos = new Set();
    for (const task of milestone.tasks) {
      requireThat(!repos.has(task.repository), 'В одной вехе нужен один самостоятельный результат на сервис.'); repos.add(task.repository);
      requireThat(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(task.repository) && /^[a-f0-9]{40}$/u.test(task.commit), 'Нужны имя сервиса и полный SHA.');
      const release = history.releaseSets.find(x => x.id === task.releaseSetId);
      const delivery = release?.deliveries[task.repository];
      requireThat(delivery && release.notion?.releasePageId && delivery.commits.some(x => x.sha === task.commit), `Нет доказательства поставки ${task.title}.`);
      execFileSync('git', ['-C', repositoryPath(repositories, task.repository), 'merge-base', '--is-ancestor', task.commit, delivery.headSha]);
      requireThat(task.changes.length > 0 && task.changes.every(x => typeof x === 'string' && x.trim()), 'Нужен результат задачи для человека.');
    }
  }
}

/** Дописывает доказательство один раз; потеря ответа не создаёт повторный абзац. */
async function appendNote(client, pageId, content) {
  const blocks = await notion.listAllChildren(client, pageId);
  if (!blocks.some(b => notion.blockText(b) === content))
    await client.request(`/blocks/${pageId}/children`, { method: 'PATCH', body: { children: [paragraph(content)] } });
}

/** Закрывает подтверждённую работу в фактическом типе поля и проверяет чтение. */
export async function closeConfirmedItem(client, schema, page) {
  if (notion.pageStatus(page, schema) !== 'Закрыто')
    await client.request(`/pages/${page.id}`, { method: 'PATCH', body: notion.statusUpdateBody(schema, 'Закрыто') });
  const actual = await client.request(`/pages/${page.id}`);
  requireThat(notion.pageStatus(actual, schema) === 'Закрыто', 'Notion не подтвердил закрытие страницы.');
  Object.assign(page, actual);
}

/** Регистрирует историю post factum по явной команде оператора; создание страницы не датируется задним числом. */
export async function reconcileRetrospective(client, config, planPath, { apply = false, progress = console.log, project = loadProject() } = {}) {
  const root = dirname(resolve(planPath));
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const history = JSON.parse(await readFile(resolve(root, 'release-history.json'), 'utf8'));
  const repositories = new Map(project.repositories.map(item => [item.name, resolve(project.workspace, item.path)]));
  validateRetrospective(plan, history, repositories);
  const workspace = await notion.inspectBacklogWorkspace(client, config, { requireTyped: true });
  let pages = await notion.queryAllPages(client, workspace.source.id);
  const schema = workspace.schema;
  const find = code => pages.find(p => notion.pageTaskCode(p, schema.idName) === code);
  const business = await notion.inspectBusinessRequirements(client, config);
  // Полный снимок и семантический выбор владельцев сохраняются перед применением плана.
  for (const milestone of plan.milestones) {
    const epic = find(milestone.epic);
    requireThat(epic && notion.pageTaskType(epic, schema) === 'Эпик', `Не найден эпик ${milestone.epic}.`);
    if (milestone.code) requireThat(find(milestone.code) && notion.pageParentIds(find(milestone.code), schema).includes(epic.id), 'История относится к другому эпику.');
  }
  if (!apply) return { milestones: plan.milestones.length, tasks: plan.milestones.reduce((n, x) => n + x.tasks.length, 0), businessFingerprint: business.snapshotFingerprint };
  for (const item of Object.values(plan.business)) {
    if (item.id) continue;
    const current = await notion.inspectBusinessRequirements(client, config);
    const match = current.items.filter(x => x.title === item.title);
    requireThat(match.length <= 1, 'Несколько бизнес-требований с одним названием.');
    if (match.length) item.id = match[0].id;
    else item.id = (await notion.createBusinessRequirement(client, config, { ...item, snapshotFingerprint: current.snapshotFingerprint })).page.id;
    await save(planPath, plan);
  }
  for (const support of plan.supportTasks || []) {
    const page = find(support.code), parent = find(support.storyCode);
    requireThat(page && parent && notion.pageParentIds(page, schema).includes(parent.id), 'Неверный владелец вспомогательной задачи.');
    requireThat(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(support.repository) && /^[a-f0-9]{40}$/u.test(support.commit), 'Неверный источник вспомогательной задачи.');
    execFileSync('git', ['-C', repositoryPath(repositories, support.repository), 'merge-base', '--is-ancestor', support.commit, 'master']);
    await appendNote(client, page.id, `Ретроспективное закрытие по поручению оператора. ${support.evidence} Commit: ${support.commit}.`);
    await closeConfirmedItem(client, schema, page);
  }
  for (const milestone of plan.milestones) {
    const epic = find(milestone.epic);
    const businessId = milestone.business ? plan.business[milestone.business].id : '';
    if (businessId) {
      const blocks = await notion.readBlockTree(client, epic.id);
      const mentions = blocks.flatMap(function collect(b) { return [...notion.blockPageMentions(b), ...(b.children || []).flatMap(collect)]; });
      if (!mentions.includes(businessId)) await client.request(`/blocks/${epic.id}/children`, { method: 'PATCH', body: { children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'mention', mention: { type: 'page', page: { id: businessId } } }] } }] } });
    }
    if (!milestone.code) {
      const result = await createItem(client, config, { type: 'История', title: milestone.title,
        parentCode: milestone.epic, businessRequirementIds: businessId ? [businessId] : [], estimatedCodeLines: 5001,
        description: `Состав этой выпущенной возможности не был полностью отражён в задачах и истории поставок.\n\n${milestone.tasks.flatMap(x => x.changes).join(' ')}\n\nИстория зарегистрирована ретроспективно по подтверждённым поставкам.`,
        steps: milestone.tasks.map(t => `${t.repository}: ${t.title}.`), checks: ['У каждого результата есть подтверждающий Git commit в диапазоне выпущенной поставки и ссылка на релиз.'] });
      milestone.code = notion.pageTaskCode(result.page, schema.idName); pages.push(result.page); await save(planPath, plan);
    }
    const story = find(milestone.code);
    if (businessId) {
      const blocks = await notion.readBlockTree(client, story.id);
      if (!blocks.flatMap(b => notion.blockPageMentions(b)).includes(businessId))
        await client.request(`/blocks/${story.id}/children`, { method: 'PATCH', body: { children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'mention', mention: { type: 'page', page: { id: businessId } } }] } }] } });
    }
    for (const task of milestone.tasks) {
      const release = history.releaseSets.find(x => x.id === task.releaseSetId);
      const delivery = release.deliveries[task.repository];
      const note = `Ретроспективная регистрация по поручению оператора. Выпущено ${release.deployedAt}: ${task.repository} ${delivery.version}, ${release.notion.releaseUrl}. Подтверждающий commit: ${task.commit}. Диапазон поставки: ${delivery.baseSha || 'начало истории'}..${delivery.headSha}. Выпуск подтверждён production evidence; повторная приёмка UI в этой регистрации не выполнялась.`;
      if (!task.code) {
        const result = await createItem(client, config, { type: 'Задача', title: task.title, parentCode: milestone.code,
          description: `${task.changes.join('\n\n')}\n\n${note}`, estimatedCodeLines: 1001,
          steps: [`Реализовать результат в ${task.repository}.`], expectedResults: task.changes,
          checks: ['Сверены полный состав и фактическое развёртывание поставки, принадлежность коммита выпущенному SHA.'] });
        task.code = notion.pageTaskCode(result.page, schema.idName); pages.push(result.page); await save(planPath, plan);
      }
      const page = find(task.code);
      requireThat(page && notion.pageTaskType(page, schema) === 'Задача' && notion.pageParentIds(page, schema).includes(story.id), `Неверный владелец ${task.code}.`);
      await appendNote(client, page.id, note);
      await closeConfirmedItem(client, schema, page);
      task.notionUrl = `https://www.notion.so/${page.id.replaceAll('-', '')}`;
      await save(planPath, plan);
      progress(`${task.code}: ${task.title} (${task.repository} ${delivery.version})`);
    }
    const children = pages.filter(p => notion.pageParentIds(p, schema).includes(story.id));
    milestone.closed = children.every(p => notion.pageStatus(p, schema) === 'Закрыто');
    if (milestone.closed) {
      await closeConfirmedItem(client, schema, story);
    }
    milestone.notionUrl = `https://www.notion.so/${story.id.replaceAll('-', '')}`;
    await appendNote(client, story.id, `Ретроспективно восстановлен состав: ${milestone.tasks.map(t => `${t.code} (${t.repository})`).join(', ')}. Основание: production evidence и Git diff поставок. Дата регистрации страницы сохранена.`);
    await save(planPath, plan);
  }
  return { milestones: plan.milestones.length, tasks: plan.milestones.reduce((n, x) => n + x.tasks.length, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [path, flag] = process.argv.slice(2);
  if (!path || (flag && flag !== '--approved')) throw new Error('release-retrospective.mjs retrospective-plan.json [--approved]');
  const config = await notion.loadConfig();
  console.log(await reconcileRetrospective(new notion.NotionClient(config), config, resolve(path), { apply: flag === '--approved' }));
}
