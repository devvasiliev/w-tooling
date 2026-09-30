import assert from 'node:assert/strict';
import test from 'node:test';
import { closeConfirmedItem, validateRetrospective } from './release-retrospective.mjs';

test('закрытие использует тип поля Notion и проверяет фактический статус', async () => {
  for (const statusType of ['select', 'status']) {
    const schema = { statusName: 'Статус', statusType };
    const page = { id: 'page', properties: { Статус: { [statusType]: { name: 'Разработка' } } } };
    const calls = [];
    const client = { request: async (path, options) => {
      calls.push({ path, options });
      if (options) Object.assign(page.properties, options.body.properties);
      return structuredClone(page);
    } };
    await closeConfirmedItem(client, schema, page);
    assert.equal(calls[0].options.body.properties.Статус[statusType].name, 'Закрыто');
    await closeConfirmedItem(client, schema, page);
    assert.equal(calls.filter(x => x.options).length, 1);
    const stale = { request: async () => ({ id: 'page', properties: { Статус: { [statusType]: { name: 'Разработка' } } } }) };
    await assert.rejects(closeConfirmedItem(stale, schema, page), { code: 'RETROSPECTIVE_CONFLICT' });
  }
});

test('неподтверждённый commit не создаёт ретроспективную работу', () => {
  const plan = { schemaVersion: 1, governingTask: 'W-000', milestones: [{ key: 'split', tasks: [{ repository: 'catalog-service', commit: 'a'.repeat(40), releaseSetId: 'one', title: 'Обработка заказов', changes: ['Проверены входящие заказы.'] }] }] };
  assert.throws(() => validateRetrospective(plan, { releaseSets: [] }, '/missing'), { code: 'RETROSPECTIVE_CONFLICT' });
});

test('ретроспектива принимает технический код другой команды', () => {
  assert.doesNotThrow(() => validateRetrospective({ schemaVersion: 1, governingTask: 'ACME-000', milestones: [] }, { releaseSets: [] }, '/missing'));
});
