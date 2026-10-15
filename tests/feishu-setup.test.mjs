import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FeishuClient} from '../tools/feishu/client.mjs';
import {tables} from '../tools/feishu/schema.mjs';
import {initializeEnv, readConfig, inspectSchema, applySchema} from '../tools/feishu/setup.mjs';

const ok = data => Response.json({code: 0, data});
const credentials = {appId: 'cli_test', appSecret: 'local-secret-do-not-log', baseToken: 'basetest'};
const tokenResponse = () => Response.json({code: 0, tenant_access_token: 'private-access-token', expire: 7200});
const copy = value => structuredClone(value);

test('configuration initialization preserves an existing secret and reads only supported keys', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'qbank-feishu-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const path = join(folder, '.env.feishu.local');
  assert.equal(await initializeEnv(path), 'created');
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await readConfig(path, {})).missing, ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BASE_APP_TOKEN']);
  const content = 'FEISHU_APP_ID=cli_test\nFEISHU_APP_SECRET="private value"\nFEISHU_BASE_APP_TOKEN=baseExample\n';
  await writeFile(path, content);
  assert.equal(await initializeEnv(path), 'preserved');
  assert.equal(await readFile(path, 'utf8'), content);
  assert.equal((await readConfig(path, {})).appSecret, 'private value');
  assert.equal((await readConfig(path, {FEISHU_APP_SECRET: 'server-secret'})).appSecret, 'server-secret');
  await assert.rejects(readConfig(path, {FEISHU_BASE_APP_TOKEN: 'https://example.feishu.cn/base/abc'}), /只填/);
});

test('read-only inspection follows all pages and keeps the application token cached', async () => {
  let authCalls = 0;
  const requests = [];
  const client = new FeishuClient({...credentials, fetchImpl: async (url, options) => {
    assert.equal(url.origin, 'https://open.feishu.cn');
    assert.equal(options.redirect, 'error');
    requests.push({url: url.href, method: options.method});
    if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
      authCalls++;
      assert.equal(options.headers.Authorization, undefined);
      return tokenResponse();
    }
    assert.equal(options.headers.Authorization, 'Bearer private-access-token');
    return ok(url.searchParams.has('page_token')
      ? {items: [{table_id: 'tblSecond', name: 'second'}], has_more: false}
      : {items: [{table_id: 'tblFirst', name: 'first'}], has_more: true, page_token: 'next+cursor/='});
  }});
  assert.equal((await client.listTables()).length, 2);
  assert.equal(authCalls, 1);
  assert.equal(new URL(requests[2].url).searchParams.get('page_token'), 'next+cursor/=');
  assert.ok(requests.slice(1).every(r => r.method === 'GET'));
});

test('HTTP 200 with a business error fails without echoing secrets or raw provider messages', async () => {
  const client = new FeishuClient({...credentials, fetchImpl: async url => url.pathname.includes('/auth/')
    ? tokenResponse() : Response.json({code: 99991672, msg: 'local-secret-do-not-log private-access-token'})});
  await assert.rejects(client.listTables(), error => {
    assert.match(error.message, /99991672/);
    assert.doesNotMatch(error.message, /local-secret|private-access-token/);
    return true;
  });
});

test('expired application token is refreshed once, other failures do not replay writes', async () => {
  let authCalls = 0, reads = 0;
  const client = new FeishuClient({...credentials, fetchImpl: async url => {
    if (url.pathname.includes('/auth/')) {authCalls++; return tokenResponse();}
    if (++reads === 1) return Response.json({code: 99991663});
    return ok({items: [], has_more: false});
  }});
  assert.deepEqual(await client.listTables(), []);
  assert.equal(authCalls, 2);
  let writes = 0;
  const failure = new FeishuClient({...credentials, fetchImpl: async url => {
    if (url.pathname.includes('/auth/')) return tokenResponse();
    writes++; throw new Error('request body contained local-secret-do-not-log');
  }});
  await assert.rejects(failure.createTable(tables[0]), /结果可能未知/);
  assert.equal(writes, 1);
});

test('invalid repeated cursors and missing response envelopes stop safely', async () => {
  let count = 0;
  const client = new FeishuClient({...credentials, fetchImpl: async url => {
    if (url.pathname.includes('/auth/')) return tokenResponse();
    count++;
    return ok({items: [], has_more: true, page_token: 'same'});
  }});
  await assert.rejects(client.listTables(), /游标异常/);
  assert.equal(count, 2);
  const malformed = new FeishuClient({...credentials, fetchImpl: async url => url.pathname.includes('/auth/')
    ? tokenResponse() : ok({items: [], has_more: true})});
  await assert.rejects(malformed.listTables(), /游标异常/);
});

function fakeTables(initial = []) {
  const data = copy(initial);
  const writes = [];
  return {
    data, writes,
    async listTables() {return data.map(t => ({name: t.name, table_id: t.id}));},
    async listFields(id) {return copy(data.find(t => t.id === id).fields);},
    async createTable(definition) {
      const id = `tblCreated${data.length}`;
      writes.push(['table', definition.name]);
      data.push({id, name: definition.name, fields: copy(definition.fields)});
      return id;
    },
    async createField(id, field) {
      writes.push(['field', field.field_name]);
      data.find(t => t.id === id).fields.push(copy(field));
      return {field_id: 'fldNew', ...field};
    },
  };
}

test('setup creates three tables and a second run makes no changes or question writes', async () => {
  const client = fakeTables();
  const preview = await inspectSchema(client);
  assert.equal(preview.filter(t => t.action === 'create_table').length, 3);
  assert.equal(client.writes.length, 0);
  const first = await applySchema(client);
  assert.equal(client.writes.length, 3);
  assert.deepEqual((await applySchema(client, first.ids)).ids, first.ids);
  assert.equal(client.writes.length, 3);
  assert.ok(tables.every(t => !t.fields.some(f => f.type === 17 || f.ui_type === 'Attachment')));
});

test('setup adds missing fields and preserves additional columns', async () => {
  const client = fakeTables([{id: 'tblExisting', name: tables[0].name,
    fields: [...copy(tables[0].fields.slice(0, -1)), {field_name: '维护者笔记', type: 1, ui_type: 'Text'}]}]);
  await applySchema(client);
  assert.deepEqual(client.writes.filter(w => w[0] === 'field'), [['field', '文字原稿']]);
  assert.ok(client.data[0].fields.some(f => f.field_name === '维护者笔记'));
});

test('preflight detects later table conflicts before creating any earlier table', async () => {
  const client = fakeTables([{id: 'tblReleases', name: '发布记录',
    fields: [{field_name: '版本号', type: 1, ui_type: 'Text'}]}]);
  await assert.rejects(applySchema(client), /字段类型不匹配/);
  assert.equal(client.writes.length, 0);
});

test('ambiguous names or explicit foreign IDs cannot silently bind another table', async () => {
  const client = fakeTables([{id: 'tblOne', name: '候选题', fields: copy(tables[0].fields)},
    {id: 'tblTwo', name: '候选题', fields: copy(tables[0].fields)}]);
  await assert.rejects(inspectSchema(client), /多个同名表/);
  await assert.rejects(inspectSchema(client, {candidates: 'tblForeign'}), /不在当前/);
  assert.equal((await inspectSchema(client, {candidates: 'tblTwo'}))[0].tableId, 'tblTwo');
  assert.equal(client.writes.length, 0);
});

test('create-table and create-field send the documented envelopes', async () => {
  const bodies = [];
  const client = new FeishuClient({...credentials, fetchImpl: async (url, options) => {
    if (url.pathname.includes('/auth/')) return tokenResponse();
    bodies.push(JSON.parse(options.body));
    return ok(url.pathname.endsWith('/fields') ? {field: {field_id: 'fldExample'}} : {table_id: 'tblExample'});
  }});
  assert.equal(await client.createTable(tables[0]), 'tblExample');
  await client.createField('tblExample', tables[0].fields[0]);
  assert.deepEqual(bodies[0].table.fields, tables[0].fields);
  assert.equal(bodies[0].table.name, '候选题');
  assert.deepEqual(bodies[1], tables[0].fields[0]);
});
