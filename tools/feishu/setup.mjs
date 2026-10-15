import {readFile, writeFile, mkdir, open, rename, unlink} from 'node:fs/promises';
import {parseEnv, parseArgs} from 'node:util';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {FeishuClient} from './client.mjs';
import {tables} from './schema.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const defaultEnvPath = resolve(root, '.env.feishu.local');
const stateDirectory = resolve(root, '.local/feishu');
const bindingPath = resolve(stateDirectory, 'table-bindings.json');

export async function initializeEnv(path = defaultEnvPath) {
  const template = await readFile(new URL('.env.example', import.meta.url), 'utf8');
  try {await writeFile(path, template, {flag: 'wx', mode: 0o600}); return 'created';}
  catch (error) {if (error.code === 'EEXIST') return 'preserved'; throw error;}
}

export async function readConfig(path = defaultEnvPath, environment = process.env) {
  let local = {};
  try {local = parseEnv(await readFile(path, 'utf8'));}
  catch (error) {if (error.code !== 'ENOENT') throw new Error('无法读取飞书本机配置，请检查文件权限和格式');}
  const names = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BASE_APP_TOKEN', ...tables.map(t => t.env)];
  const values = Object.fromEntries(names.map(name => [name, (environment[name] ?? local[name] ?? '').trim()]));
  const missing = names.slice(0, 3).filter(name => !values[name]);
  if (values.FEISHU_APP_ID && !/^cli_[a-zA-Z0-9]+$/.test(values.FEISHU_APP_ID)) throw new Error('FEISHU_APP_ID 格式应为 cli_ 开头的应用 ID');
  if (values.FEISHU_BASE_APP_TOKEN && !/^[a-zA-Z0-9]+$/.test(values.FEISHU_BASE_APP_TOKEN)) throw new Error('FEISHU_BASE_APP_TOKEN 只填 /base/ 后的标识，不填整个网址');
  for (const t of tables) if (values[t.env] && !/^tbl[a-zA-Z0-9]+$/.test(values[t.env])) throw new Error(`${t.env} 应为 tbl 开头的数据表 ID`);
  return {missing, appId: values.FEISHU_APP_ID, appSecret: values.FEISHU_APP_SECRET,
    baseToken: values.FEISHU_BASE_APP_TOKEN, tableIds: Object.fromEntries(tables.map(t => [t.key, values[t.env]]))};
}

export async function inspectSchema(client, tableIds = {}) {
  const existing = await client.listTables();
  const plan = [];
  // Finish ALL preflight reads before making any schema changes.
  for (const definition of tables) {
    const explicit = tableIds[definition.key];
    const matches = existing.filter(t => explicit ? t.table_id === explicit : t.name === definition.name);
    if (explicit && matches.length === 0) throw new Error(`${definition.name}：配置的表 ID 不在当前多维表格中`);
    if (matches.length > 1) throw new Error(`${definition.name}：存在多个同名表，请在本机配置中指定表 ID`);
    const table = matches[0];
    if (table && (!/^tbl[a-zA-Z0-9]+$/.test(table.table_id) || table.name !== definition.name)) throw new Error(`${definition.name}：数据表身份或名称不匹配，停止操作`);
    if (!table) {plan.push({key: definition.key, name: definition.name, action: 'create_table', missingFields: definition.fields}); continue;}
    const actual = await client.listFields(table.table_id);
    const missingFields = [];
    const warnings = [];
    for (const field of definition.fields) {
      const matches = actual.filter(f => f.field_name === field.field_name);
      if (matches.length > 1) throw new Error(`${definition.name} / ${field.field_name}：存在重复字段名`);
      const found = matches[0];
      if (!found) {missingFields.push(field); continue;}
      if (found.type !== field.type || (found.ui_type && found.ui_type !== field.ui_type)) {
        throw new Error(`${definition.name} / ${field.field_name}：字段类型不匹配，请先人工核对；不会自动改类型`);
      }
      const missingOptions = field.property?.options?.filter(o => !found.property?.options?.some(v => v.name === o.name));
      if (missingOptions?.length) warnings.push(`${field.field_name} 缺少预设选项：${missingOptions.map(o => o.name).join('、')}`);
    }
    plan.push({key: definition.key, name: definition.name, tableId: table.table_id,
      action: missingFields.length ? 'add_fields' : 'ready', missingFields, warnings});
  }
  return plan;
}

export async function applySchema(client, tableIds = {}, onProgress = () => {}) {
  const plan = await inspectSchema(client, tableIds);
  const ids = {};
  for (const entry of plan) {
    const definition = tables.find(t => t.key === entry.key);
    const id = entry.tableId ?? await client.createTable(definition);
    ids[entry.key] = id;
    if (entry.tableId) for (const field of entry.missingFields) {
      await client.createField(id, field);
      onProgress(`${entry.name}：已补充 ${field.field_name}`);
    }
    onProgress(`${entry.name}：${entry.tableId ? '保留已有表' : '已创建'}`);
  }
  const verified = await inspectSchema(client, ids);
  if (verified.some(t => t.action !== 'ready')) throw new Error('建表后字段仍不完整，请保留现场并重新运行 feishu:plan');
  return {ids, warnings: verified.flatMap(t => t.warnings)};
}

const summary = plan => plan.map(t => ({table: t.name, action: t.action,
  table_id: t.tableId ?? null, fields_to_add: t.missingFields.map(f => f.field_name), warnings: t.warnings ?? []}));

async function bindingConfig(config) {
  let previous;
  try {previous = JSON.parse(await readFile(bindingPath, 'utf8'));}
  catch (error) {if (error.code === 'ENOENT') return config.tableIds; throw new Error('本机飞书表绑定记录损坏，请先检查 .local/feishu/table-bindings.json');}
  if (previous.app_id !== config.appId || previous.app_token !== config.baseToken) {
    throw new Error('本机已有另一应用或表格的绑定；如需切换，请先备份并移走 .local/feishu/table-bindings.json');
  }
  for (const t of tables) if (config.tableIds[t.key] && previous.tables?.[t.key] && config.tableIds[t.key] !== previous.tables[t.key]) {
    throw new Error(`${t.name}：配置与已保存绑定不一致，请先核对，停止操作`);
  }
  return Object.fromEntries(tables.map(t => [t.key, config.tableIds[t.key] || previous.tables?.[t.key] || '']));
}

export async function main(args = process.argv.slice(2)) {
  const {values, positionals} = parseArgs({args, allowPositionals: true, options: {env: {type: 'string'}, help: {type: 'boolean'}}});
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') {
    console.log('用法：node tools/feishu/setup.mjs <init|schema|doctor|plan|apply> [--env 配置文件]\ninit 创建本机空白配置；schema 查看字段；doctor/plan 只读检查；apply 在目标多维表格新增缺失表和字段。');
    return;
  }
  if (positionals.length !== 1 || !['init', 'schema', 'doctor', 'plan', 'apply'].includes(command)) throw new Error('未知命令，请使用 --help');
  const envPath = values.env ? resolve(values.env) : defaultEnvPath;
  if (command === 'init') {
    console.log(JSON.stringify({config: envPath, status: await initializeEnv(envPath), next: '填写三个必填配置后运行 pnpm feishu:check；密钥不用发到聊天里'}, null, 2));
    return;
  }
  if (command === 'schema') {console.log(JSON.stringify(tables, null, 2)); return;}
  const config = await readConfig(envPath);
  if (config.missing.length) {
    console.log(JSON.stringify({status: 'needs_configuration', config: envPath, missing: config.missing,
      next: '创建自建应用、授权空白多维表格，再填写本机配置'}, null, 2));
    process.exitCode = 2;
    return;
  }
  const ids = await bindingConfig(config);
  const client = new FeishuClient(config);
  if (command !== 'apply') {
    const plan = await inspectSchema(client, ids);
    const ready = plan.every(t => t.action === 'ready');
    console.log(JSON.stringify({status: ready ? 'schema_ready' : 'needs_setup',
      note: '仅检查访问和表结构，尚未验证真实投稿写入权限', tables: summary(plan)}, null, 2));
    return;
  }
  await mkdir(stateDirectory, {recursive: true, mode: 0o700});
  let lock;
  try {lock = await open(resolve(stateDirectory, 'setup.lock'), 'wx', 0o600);}
  catch (error) {if (error.code === 'EEXIST') throw new Error('已有建表操作或遗留锁，请确认没有其他建表进程后再处理 .local/feishu/setup.lock'); throw error;}
  try {
    const {ids: createdIds, warnings} = await applySchema(client, ids, message => console.log(message));
    const saved = {schema_version: 1, app_id: config.appId, app_token: config.baseToken,
      tables: createdIds, checked_at: new Date().toISOString()};
    const temporary = resolve(dirname(bindingPath), `.bindings-${randomUUID()}.json`);
    await writeFile(temporary, JSON.stringify(saved, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    await rename(temporary, bindingPath);
    console.log(JSON.stringify({status: 'schema_ready', binding_file: bindingPath, tables: createdIds, warnings,
      next: '请在飞书检查三个表及字段；尚未导入正式题目或部署投稿接口'}, null, 2));
  } finally {
    await lock.close();
    await unlink(resolve(stateDirectory, 'setup.lock'));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {console.error(error instanceof Error ? error.message : '飞书准备工具执行失败'); process.exitCode = 1;});
}
