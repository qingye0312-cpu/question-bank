const origin = 'https://open.feishu.cn';

const hints = new Map([
  [20002, 'App ID 与 App Secret 不匹配'],
  [10014, '应用不可用，请检查启用与发布状态'],
  [10015, 'App Secret 无效'],
  [91403, '请在多维表格中添加文档应用并授权；启用高级权限时还需检查应用角色'],
  [99991403, '本月 API 调用额度已用完'],
  [99991663, '应用访问令牌无效或已过期'],
  [99991672, '应用缺少 API 权限，请检查权限管理并发布生效'],
  [99991673, '应用未授权或未生效，请检查组织内的安装和发布状态'],
  [1254003, '请检查多维表格 app_token，不要使用应用 App ID 或 wiki 节点标识'],
  [1254040, '多维表格不存在或 app_token 不正确'],
  [1254041, '数据表不存在，请检查 table_id'],
  [1254290, '请求被限流，请稍后重试'],
  [1254291, '发生并发写入，请停止其他建表任务后重新检查'],
  [1254302, '应用没有该表的访问权限，请检查文档授权和高级权限'],
  [1254306, '多维表格容量或套餐额度不足'],
]);

export class FeishuError extends Error {
  constructor(status, code) {
    // Never include raw response bodies/HTTP configs: they can echo credentials.
    super(`飞书请求失败（HTTP ${status}，业务码 ${Number.isSafeInteger(code) ? code : '未知'}）：${hints.get(code) ?? '请按业务码查询飞书文档并检查配置'}`);
    this.status = status;
    this.code = code;
  }
}

export class FeishuClient {
  #token;
  #expiresAt = 0;
  #tokenRequest;

  constructor({appId, appSecret, baseToken, fetchImpl = fetch}) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseToken = baseToken;
    this.fetchImpl = fetchImpl;
  }

  async #send(path, {method = 'GET', body, token} = {}) {
    let response;
    let result;
    try {
      response = await this.fetchImpl(new URL(path, origin), {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: {'Content-Type': 'application/json; charset=utf-8', ...(token ? {Authorization: `Bearer ${token}`} : {})},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
      result = await response.json();
    } catch {
      throw new Error('飞书连接失败、超时或返回了非 JSON 内容。若正在建表，结果可能未知；先重新运行 feishu:plan，不要并发重试。');
    }
    if (!response.ok || result?.code !== 0) throw new FeishuError(response.status, result?.code);
    return result;
  }

  async #accessToken() {
    if (this.#token && Date.now() < this.#expiresAt) return this.#token;
    if (!this.#tokenRequest) this.#tokenRequest = (async () => {
      const result = await this.#send('/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', body: {app_id: this.appId, app_secret: this.appSecret},
      });
      if (typeof result.tenant_access_token !== 'string' || !result.tenant_access_token
        || !Number.isFinite(result.expire) || result.expire <= 0) throw new Error('飞书未返回有效的应用令牌及有效期');
      this.#token = result.tenant_access_token;
      this.#expiresAt = Date.now() + Math.max(0, result.expire - 180) * 1000;
      return this.#token;
    })();
    try {return await this.#tokenRequest;} finally {this.#tokenRequest = undefined;}
  }

  async request(path, options) {
    // Only this fixed provider origin receives app credentials or tokens.
    if (!path.startsWith('/open-apis/bitable/v1/') || path.includes('://')) throw new Error('不允许的飞书 API 路径');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {return (await this.#send(path, {...options, token: await this.#accessToken()})).data;}
      catch (error) {
        if (error instanceof FeishuError && error.code === 99991663 && attempt === 0) {
          this.#token = undefined;
          continue;
        }
        throw error;
      }
    }
  }

  get tablesPath() {return `/open-apis/bitable/v1/apps/${encodeURIComponent(this.baseToken)}/tables`;}

  async #list(path) {
    const items = [];
    const seen = new Set();
    let pageToken;
    do {
      const query = new URLSearchParams({page_size: '100', ...(pageToken ? {page_token: pageToken} : {})});
      const data = await this.request(`${path}?${query}`);
      if (!Array.isArray(data?.items) || typeof data.has_more !== 'boolean') throw new Error('飞书列表响应不完整，停止操作');
      items.push(...data.items);
      if (!data.has_more) return items;
      pageToken = data.page_token;
      if (typeof pageToken !== 'string' || !pageToken || seen.has(pageToken)) throw new Error('飞书列表游标异常，停止操作');
      seen.add(pageToken);
    } while (true);
  }

  listTables() {return this.#list(this.tablesPath);}
  listFields(tableId) {return this.#list(`${this.tablesPath}/${encodeURIComponent(tableId)}/fields`);}
  async createTable(definition) {
    const data = await this.request(this.tablesPath, {method: 'POST', body: {
      table: {name: definition.name, default_view_name: '全部记录', fields: definition.fields},
    }});
    if (typeof data?.table_id !== 'string' || !/^tbl[a-zA-Z0-9]+$/.test(data.table_id)) throw new Error('新增表的返回结果不完整；请先重新运行 feishu:plan 核对');
    return data.table_id;
  }
  async createField(tableId, field) {
    const data = await this.request(`${this.tablesPath}/${encodeURIComponent(tableId)}/fields`, {method: 'POST', body: field});
    if (!data?.field?.field_id) throw new Error('新增字段的返回结果不完整；请先重新运行 feishu:plan 核对');
    return data.field;
  }
}
