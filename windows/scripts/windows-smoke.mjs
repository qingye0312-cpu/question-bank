// Run against a built/installed Windows executable, with isolated data only.
// Optional QBANK_PLAYWRIGHT_MODULE points at an existing Playwright index.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import net from 'node:net';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = path.resolve(process.argv[2] || path.join(root, 'src-tauri/target/release/question-bank.exe'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(root, 'artifacts', `windows-smoke-${stamp}`);
const data = path.join(output, '测试数据 data');
const files = path.join(output, '中文路径 files');
await fs.mkdir(files, {recursive: true});
// Start from an empty directory instead of the repository root.
const launchDirectory = path.join(output, '空工作目录');
await fs.mkdir(launchDirectory);
const modulePath = process.env.QBANK_PLAYWRIGHT_MODULE;
const {chromium} = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const report = {at: new Date().toISOString(), executable, output, checks: [], errors: [], requests: []};
let app, browser, page;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, run) {
  const start = performance.now();
  try {
    const detail = await run();
    report.checks.push({name, passed: true, ms: performance.now() - start, detail});
    console.log(`PASS ${name}`);
    return detail;
  } catch (error) {
    report.checks.push({name, passed: false, error: String(error)});
    throw error;
  } finally {
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
}
const invoke = (command, args = {}) => page.evaluate(({command, args}) => window.__TAURI_INTERNALS__.invoke(command, args), {
  command, args: command === 'import_preview' ? {jobId: crypto.randomUUID(), ...args} : args,
});
const search = (text = '', bankId = '', extra = {}) => invoke('search', {query: {text, bank_id: bankId, ...extra}});
async function all(bankId, extra = {}) {
  const items = []; let after = 0;
  for (;;) {
    const result = await search('', bankId, {...extra, after_rowid: after});
    items.push(...result.items);
    if (!result.has_more) break;
    assert.ok(result.items.length && result.items.at(-1).rowid > after);
    after = result.items.at(-1).rowid;
  }
  assert.equal(new Set(items.map(hit => hit.rowid)).size, items.length);
  return items;
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function launch() {
  const port = await freePort();
  app = spawn(executable, [], {cwd: launchDirectory, windowsHide: true, env: {...process.env,
    QBANK_DATA_DIR: data,
    WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview-profile'),
    // External network fails closed; Tauri's local protocol/IPC remain available.
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port} --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=tauri.localhost;ipc.localhost;127.0.0.1;localhost`,
  }, stdio: ['ignore', 'pipe', 'pipe']});
  app.stdout.on('data', data => fs.appendFile(path.join(output, 'app.log'), data));
  app.stderr.on('data', data => fs.appendFile(path.join(output, 'app.log'), data));
  let spawnError; app.on('error', error => {spawnError = error;});
  for (let i = 0; i < 120; i++) {
    if (spawnError) throw spawnError;
    if (app.exitCode !== null) throw Error(`App exited ${app.exitCode}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) break; } catch {}
    await delay(500);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] || await context.waitForEvent('page');
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(String(error)));
  context.on('request', request => {
    if (/^https?:/.test(request.url()) && !['tauri.localhost', 'ipc.localhost', '127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) report.requests.push(request.url());
  });
  await page.waitForFunction(() => window.__TAURI_INTERNALS__ && document.querySelector('.result, .speed-row'));
  const info = await invoke('app_info');
  assert.equal(path.resolve(info.database), path.join(data, 'question-bank.sqlite'));
  assert.equal(info.platform, 'windows');
  return {...info, viewport: await page.evaluate(() => ({width: innerWidth, height: innerHeight, dpr: devicePixelRatio})), webview: await browser.version()};
}
async function stop() {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
  if (app && app.exitCode === null) {
    const closed = new Promise(resolve => app.once('exit', resolve));
    app.kill(); await closed;
  }
}
async function screenshot(name) { await page.screenshot({path: path.join(output, `${name}.png`)}); }
async function settledSearch(value, selector) {
  await page.locator('.search-box input').fill(value);
  await page.waitForFunction(({selector, value}) => {
    const element = document.querySelector(selector);
    return element && document.querySelector('.search-box input')?.value === value && element.textContent.includes(value);
  }, {selector, value});
}
let seedBank, seedHits;
try {
  report.environment = await check('Windows executable starts offline with isolated data', launch);
  seedBank = (await invoke('banks')).find(bank => bank.name === 'HarmonyOS 初级认证');
  await check('all 914 seed records and unknown answers survive Windows initialization', async () => {
    assert.ok(seedBank.read_only); assert.equal(seedBank.count, 914);
    seedHits = await all(seedBank.id);
    assert.equal(seedHits.length, 914);
    assert.deepEqual(seedHits.filter(hit => hit.question.answer === null).map(hit => hit.question.external_id).sort(), ['J-137', 'J-145', 'S-371']);
    for (const [kind, expected] of [['single',501],['multiple',170],['true_false',243]]) assert.equal((await all(seedBank.id,{kind})).length, expected);
    await assert.rejects(invoke('save_question', {bankId: seedBank.id, question: seedHits[0].question}));
    return {count: seedHits.length, protected: true};
  });
  await check('detail continuous scrolling crosses 50 and 100 rows', async () => {
    await page.locator('.pane-heading').getByText('已加载 50 题').waitFor();
    for (const count of [100,150]) {
      await page.locator('.results-list').evaluate(element => {element.scrollTop = element.scrollHeight;});
      await page.locator('.pane-heading').getByText(`已加载 ${count} 题`).waitFor();
    }
    assert.ok(await page.locator('.detail-result-row[aria-posinset="100"]').count());
    await screenshot('detail-pagination');
  });
  await check('search, keyboard focus and IME composition use live results', async () => {
    await page.keyboard.press('Control+k');
    assert.equal(await page.locator('.search-box input').evaluate(element => document.activeElement === element), true);
    await settledSearch('S-371', '.result-meta');
    assert.match(await page.locator('.detail-scroll').innerText(), /待核对/);
    const input = page.locator('.search-box input');
    await input.dispatchEvent('compositionstart', {data: ''});
    await input.fill('鸿蒙');
    await delay(250);
    assert.match(await page.locator('.result-meta').first().innerText(), /S-371/);
    await input.dispatchEvent('compositionend', {data: '鸿蒙'});
    await page.waitForFunction(() => !document.querySelector('.result-meta')?.textContent.includes('S-371'));
    await settledSearch('M-015', '.result-meta');
    await input.fill('一个不存在的题库关键字验证');
    await page.getByText('没有找到题目', {exact:true}).waitFor();
    await input.fill('');
    await page.locator('.result').first().waitFor();
    await page.keyboard.press('Alt+ArrowDown');
    assert.equal(await page.locator('.detail-result-row').nth(1).locator('.result').getAttribute('aria-pressed'),'true');
    await page.keyboard.press('Control+Shift+o');
    await page.getByRole('dialog',{name:'截图 / 粘贴识题'}).waitFor();
    await page.getByRole('button',{name:'关闭识题',exact:true}).click();
  });
  await check('speed scrolling, immediate complete preview and Escape', async () => {
    await page.getByRole('button',{name:'极速模式',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'题目预览',exact:true}).getAttribute('aria-pressed'), 'false');
    await page.locator('.speed-row').first().waitFor();
    for (const index of [50,100]) {
      await page.locator('.speed-viewport').evaluate(element => {element.scrollTop = element.scrollHeight;});
      await page.locator(`.speed-row[data-result-index="${index}"]`).waitFor();
    }
    await page.locator('.search-box input').fill('M-015');
    const expected = seedHits.find(hit => hit.question.external_id === 'M-015').question;
    await page.waitForFunction(stem => document.querySelector('.speed-question')?.textContent.includes(stem.slice(0, 15)), expected.stem);
    await page.getByRole('button',{name:'题目预览',exact:true}).click();
    await page.locator('.speed-row').first().hover();
    await page.locator('.question-preview').waitFor({state:'visible'});
    const preview = await page.locator('.question-preview').innerText();
    assert.ok(preview.includes(expected.stem));
    for (const option of expected.options) assert.ok(preview.includes(option.content));
    const bounds = await page.locator('.question-preview').evaluate(element => {
      const r=element.getBoundingClientRect(); return {fits:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1, scroll:getComputedStyle(element).overflowY};
    });
    assert.ok(bounds.fits); assert.ok(!['scroll','auto'].includes(bounds.scroll));
    await screenshot('speed-preview');
    await page.keyboard.press('Escape');
    await page.locator('.question-preview').waitFor({state:'hidden'});
  });
  await check('four font sizes, six themes and saved layout preferences', async () => {
    await page.getByRole('button',{name:/^设置与维护/}).click();
    for (const [label,id] of [['小','small'],['中默认','medium'],['大','large'],['超大','xlarge']]) {
      await page.locator('.font-options button').filter({hasText:label}).first().click();
      await page.waitForFunction(id=>document.documentElement.dataset.fontSize===id,id);
    }
    for (const [label,id] of [['松绿','forest'],['海蓝','ocean'],['紫藤','violet'],['暖杏','amber'],['石墨','slate'],['深色','night']]) {
      await page.locator('.theme-options').getByRole('button',{name:label,exact:true}).click();
      await page.waitForFunction(id=>document.documentElement.dataset.theme===id,id);
    }
    await screenshot('appearance');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'详细模式',exact:true}).click();
    await page.getByRole('button',{name:'收起侧栏',exact:true}).click();
    await page.getByRole('button',{name:'收起搜索区',exact:true}).click();
    const saved = await page.evaluate(()=>JSON.parse(localStorage.getItem('question-bank.appearance.v1')));
    assert.equal(saved.fontSize,'xlarge'); assert.equal(saved.theme,'night');
    assert.ok(saved.sidebarCollapsed && saved.searchCollapsed && saved.speedPreview);
    return saved;
  });
  await check('real process restart retains SQLite data and UI preferences', async () => {
    await stop(); await launch();
    await page.getByRole('button',{name:'展开侧栏',exact:true}).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'night');
    assert.equal(await page.locator('html').getAttribute('data-font-size'), 'xlarge');
    assert.equal((await invoke('banks')).find(bank=>bank.id===seedBank.id).count, 914);
    await page.getByRole('button',{name:'展开侧栏',exact:true}).click();
    await page.getByRole('button',{name:/^设置与维护/}).click();
    await page.getByRole('button',{name:'恢复默认显示',exact:true}).click();
    await page.keyboard.press('Escape');
  });
  await check('Word Excel JSONL template output and import via real IPC', async () => {
    for (const format of ['docx','xlsx','jsonl']) {
      const destination=path.join(files, `录题 模板.${format}`);
      await invoke('download_template',{path:destination,format});
      const source=path.join(root,'templates',format==='jsonl'?'题库导入示例_v1.jsonl':`题库导入模板_v1.${format}`);
      assert.deepEqual(await fs.readFile(destination), await fs.readFile(source));
      const input=format==='xlsx'?path.join(root,'src-tauri/tests/fixtures/excel-filled-test.xlsx'):destination;
      const preview=await invoke('import_preview',{path:input,bankId:''});
      assert.deepEqual(preview.errors,[]); assert.equal(preview.count,3);
      const bank=await invoke('import_commit',{token:preview.token});
      assert.equal((await all(bank)).length,3);
      const exported=path.join(files,`导出 往返.${format}`);
      assert.equal(await invoke('export_bank',{bankId:bank,path:exported,format}),3);
      const roundtrip=await invoke('import_preview',{path:exported,bankId:''});
      assert.deepEqual(roundtrip.errors,[]); assert.equal(roundtrip.count,3);
    }
  });
  await check('edit history, recycle/restore, package duplicate, rollback and index rebuild', async () => {
    const bankId=await invoke('create_bank',{name:'Windows 验证 test'});
    const question=JSON.parse(await fs.readFile(path.join(root,'src-tauri/resources/examples.json'),'utf8'))[0];
    question.question_id=''; question.base_revision=1; question.stem='Windows 验证 初稿';
    await invoke('save_question',{bankId,question});
    let hit=(await search('',bankId)).items[0];
    hit.question.stem='Windows 验证 修订';
    hit.question.explanation='ExplanationOnlyMarkerXYZ';
    await invoke('save_question',{bankId,question:hit.question});
    assert.ok((await invoke('history',{bankId,questionId:hit.question.question_id})).length>=1);
    assert.equal((await search('ExplanationOnlyMarkerXYZ',bankId)).items.length,0);
    await invoke('delete_question',{rowid:hit.rowid,restore:false});
    assert.equal((await all(bankId)).length,0); assert.equal((await all(bankId,{trash:true})).length,1);
    await invoke('delete_question',{rowid:hit.rowid,restore:true});
    assert.equal((await all(bankId)).length,1);
    const packagePath=path.join(files,'发布 题库.qbank.zip');
    assert.equal(await invoke('export_bank',{bankId:seedBank.id,path:packagePath,format:'package'}),914);
    const duplicate=await invoke('import_preview',{path:packagePath,bankId:''});
    assert.deepEqual(duplicate.errors,[]); assert.match(duplicate.action,/跳过/);
    await invoke('import_commit',{token:duplicate.token});
    const imported=path.join(files,'增量 数据.jsonl');
    question.question_id=''; question.stem='Windows 导入后回退验证';
    await fs.writeFile(imported,JSON.stringify(question)+'\n');
    const preview=await invoke('import_preview',{path:imported,bankId});
    assert.deepEqual(preview.errors,[]);
    await invoke('import_commit',{token:preview.token}); assert.equal((await all(bankId)).length,2);
    await invoke('rollback_bank',{bankId}); assert.equal((await all(bankId)).length,1);
    const copyId=await invoke('fork_bank',{bankId:seedBank.id});
    const copy=(await invoke('banks')).find(bank=>bank.id===copyId);
    assert.ok(!copy.read_only); assert.equal(copy.count,914);
    await invoke('rebuild_index');
    assert.equal((await search('Windows 修订',bankId)).items.length,1);
    assert.equal((await search('ExplanationOnlyMarkerXYZ',bankId)).items.length,0);
    return {editableBank:bankId,copyId};
  });
  await check('OCR system engine on three real PNG fixtures', async () => {
    const results=[];
    for (const name of ['true-false','single-code','multiple-reordered']) {
      const image=await invoke('ocr_image_file',{path:path.join(root,`tests/fixtures/ocr/${name}.png`)});
      const recognition=await invoke('ocr_recognize',{dataUrl:image.data_url});
      assert.equal(recognition.engine,'Windows OCR'); assert.ok(recognition.text.trim());
      const match=await invoke('ocr_match',{bankId:seedBank.id,text:recognition.text});
      assert.ok(match.candidates.length>0);
      results.push({name,recognition,match});
    }
    await fs.writeFile(path.join(output,'system-ocr.json'),JSON.stringify(results,null,2));
    return results.map(({name,recognition,match})=>({name,ms:recognition.elapsed_ms,automatic:match.automatic,answer:match.candidates[0]?.answer}));
  });
  await check('OCR text matching remaps reordered options to B C D', async () => {
    const text=await fs.readFile(path.join(root,'tests/fixtures/ocr/multiple-reordered.txt'),'utf8');
    await page.getByRole('button',{name:'截图或粘贴识题',exact:true}).click();
    await page.getByLabel('识题匹配题库').selectOption(seedBank.id);
    await page.getByLabel('识题文字',{exact:true}).fill(text);
    await page.locator('.ocr-answer strong').waitFor();
    const answer=await page.locator('.ocr-answer strong').innerText();
    assert.equal(answer.replace(/[^A-H]/g,''),'BCD');
    await screenshot('ocr-reordered');
    await page.getByRole('button',{name:'关闭识题',exact:true}).click();
  });
  await check('Windows clipboard text, Ctrl+V image and paste button', async () => {
    await page.bringToFront();
    await page.context().grantPermissions(['clipboard-read','clipboard-write']);
    await page.evaluate(async()=>{window.__smokeSavedClipboard=await navigator.clipboard.read();});
    try {
      const text=await fs.readFile(path.join(root,'tests/fixtures/ocr/multiple-reordered.txt'),'utf8');
      await page.evaluate(text=>navigator.clipboard.writeText(text),text);
      assert.equal((await invoke('ocr_clipboard')).text.replace(/\r\n/g,'\n'),text.replace(/\r\n/g,'\n'));
      await page.locator('.search-box input').focus();
      await page.keyboard.press('Control+v');
      await page.getByRole('dialog',{name:'截图 / 粘贴识题'}).waitFor();
      await page.getByLabel('识题匹配题库').selectOption(seedBank.id);
      await page.locator('.ocr-answer strong').waitFor();
      assert.equal((await page.locator('.ocr-answer strong').innerText()).replace(/[^A-H]/g,''),'BCD');
      await page.getByRole('button',{name:'关闭识题',exact:true}).click();
      const bytes=await fs.readFile(path.join(root,'tests/fixtures/ocr/true-false.png'));
      await page.evaluate(async base64=>{
        const bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));
        await navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([bytes],{type:'image/png'})})]);
      },bytes.toString('base64'));
      const pasted=await invoke('ocr_clipboard'); assert.ok(pasted.image?.width>0);
      await page.locator('.search-box input').focus();
      await page.keyboard.press('Control+v');
      await page.locator('.ocr-image img').waitFor();
      await page.locator('.ocr-candidates button').first().waitFor();
      await page.getByLabel('识题文字',{exact:true}).fill('');
      await page.locator('.ocr-candidates').waitFor({state:'hidden'});
      await page.getByRole('button',{name:'粘贴识别',exact:true}).click();
      await page.waitForFunction(()=>{
        const text=document.querySelector('textarea[aria-label="识题文字"]');return text&&!text.disabled&&text.value.length>10;
      });
      await page.locator('.ocr-candidates button').first().waitFor();
      assert.ok((await page.getByLabel('识题文字',{exact:true}).inputValue()).length>10);
      await screenshot('clipboard-ocr');
      await page.getByRole('button',{name:'关闭识题',exact:true}).click();
    } finally {
      await page.evaluate(async()=>{
        if(window.__smokeSavedClipboard?.length) await navigator.clipboard.write(window.__smokeSavedClipboard);
        else await navigator.clipboard.writeText('');
        delete window.__smokeSavedClipboard;
      });
    }
  });
  await check('packaged offline worker WASM and Chinese/English models recognize an image', async () => {
    await page.getByRole('button',{name:'截图或粘贴识题',exact:true}).click();
    await page.getByLabel('识题匹配题库').selectOption(seedBank.id);
    await page.getByLabel('识别引擎').selectOption('builtin');
    await page.locator('.ocr-actions input[type=file]').setInputFiles(path.join(root,'tests/fixtures/ocr/true-false.png'));
    await page.waitForFunction(()=>document.querySelector('.ocr-source .ocr-meta')?.textContent.includes('Tesseract'),null,{timeout:120000});
    assert.ok((await page.getByLabel('识题文字',{exact:true}).inputValue()).length>10);
    await page.locator('.ocr-candidates button').first().waitFor();
    assert.equal(await page.locator('.ocr-error').count(),0);
    await screenshot('builtin-ocr-offline');
    return {engine:await page.locator('.ocr-source .ocr-meta').innerText(),text:await page.getByLabel('识题文字',{exact:true}).inputValue()};
  });
  await check('image drop, uncertain OCR confirmation and recognition cancellation', async () => {
    await page.getByLabel('识别引擎').selectOption('system');
    const bytes=await fs.readFile(path.join(root,'tests/fixtures/ocr/multiple-reordered.png'));
    const transfer=await page.evaluateHandle(base64=>{
      const bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));
      const transfer=new DataTransfer();transfer.items.add(new File([bytes],'多选 换序.png',{type:'image/png'}));return transfer;
    },bytes.toString('base64'));
    await page.locator('.ocr-modal').dispatchEvent('drop',{dataTransfer:transfer});
    await transfer.dispose();
    await page.locator('.ocr-candidates button').first().waitFor();
    assert.equal(await page.locator('.ocr-answer').count(),0);
    await page.locator('.ocr-candidates button').first().click();
    assert.equal((await page.locator('.ocr-answer strong').innerText()).replace(/[^A-H]/g,''),'BCD');
    await page.getByLabel('识别引擎').selectOption('builtin');
    await page.locator('.ocr-actions input[type=file]').setInputFiles(path.join(root,'tests/fixtures/ocr/multiple-reordered.png'));
    await page.getByRole('button',{name:'取消识别',exact:true}).click();
    await page.getByText('已取消，可重新截图或粘贴',{exact:true}).waitFor();
    await page.getByLabel('识题文字',{exact:true}).fill(await fs.readFile(path.join(root,'tests/fixtures/ocr/multiple-reordered.txt'),'utf8'));
    await page.locator('.ocr-answer strong').waitFor();
    assert.equal((await page.locator('.ocr-answer strong').innerText()).replace(/[^A-H]/g,''),'BCD');
    await page.getByRole('button',{name:'关闭识题',exact:true}).click();
  });
  await check('no uncaught page errors or external resource requests', async () => {
    assert.deepEqual(report.errors,[]); assert.deepEqual(report.requests,[]);
  });
  await check('Windows tray and global shortcut register; unsigned build leaves updater disabled', async () => {
    const info = await invoke('app_info');
    assert.equal(info.version, '0.2.7');
    assert.equal(info.tray, 'true');
    assert.equal(info.global_shortcut, 'Ctrl + Alt + Q');
    assert.deepEqual(await invoke('software_update_check'), {configured:false});
    return info;
  });
  await check('continuous intake edits answers and preserves pending questions and draft after restart', async () => {
    await page.getByRole('button',{name:'大模型录题',exact:true}).click();
    await page.getByLabel('录入题库').selectOption(seedBank.id);
    const reply = {format:'qbank-photo-question-1',type:'single',stem:'Windows 0.2.7 原生录题验证',options:[{key:'A',content:'第一个选项'},{key:'B',content:'正确选项'}],answer:['B'],answer_origin:'inferred',explanation:'隔离测试',model:{name:'Synthetic',version:'test',version_source:'user'},warnings:[]};
    await page.getByLabel('模型原文',{exact:true}).fill(JSON.stringify(reply));
    await page.locator('.intake-editor .model-editor textarea').first().waitFor();
    await page.locator('.editable-option').nth(1).getByRole('button',{name:'上移',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'A 正确答案',exact:true}).getAttribute('aria-pressed'),'true');
    await page.getByRole('button',{name:'保存本题，继续下一题',exact:true}).click();
    await page.getByRole('heading',{name:'待上传 · 1 题',exact:true}).waitFor();
    const batches = await invoke('intake_batches');
    const batch = batches.find(b=>b.bank_id===seedBank.id);
    assert.equal(batch.pending,1);
    const entry = (await invoke('intake_entries',{batchId:batch.id}))[0];
    assert.deepEqual(entry.question.answer,['A']);
    assert.ok(entry.question.sources.some(s=>s.recorded_at));
    reply.stem = 'Windows 尚未保存的草稿';
    await page.getByLabel('模型原文',{exact:true}).fill(JSON.stringify(reply));
    await page.waitForFunction(()=>document.querySelector('.intake-editor textarea')?.value==='Windows 尚未保存的草稿');
    await page.getByRole('button',{name:'关闭录题窗口',exact:true}).click();
    await stop(); await launch();
    await page.getByRole('button',{name:'大模型录题',exact:true}).click();
    await page.getByLabel('录入题库').selectOption(seedBank.id);
    await page.waitForFunction(()=>document.querySelector('.intake-editor textarea')?.value==='Windows 尚未保存的草稿');
    await page.getByRole('heading',{name:'待上传 · 1 题',exact:true}).waitFor();
    await screenshot('intake-restart');
    assert.equal((await invoke('intake_entries',{batchId:batch.id}))[0].upload_status,entry.upload_status);
    assert.deepEqual(await invoke('client_state',{key:'upload-queue',value:null}),null);
    await page.getByRole('button',{name:'关闭录题窗口',exact:true}).click();
    return {batchId:batch.id,answer:entry.question.answer,uploaded:false};
  });
  await check('import preview survives process restart and selective undo restores the bank', async () => {
    const bankId=await invoke('create_bank',{name:'Windows 持久导入'});
    const source=path.join(root,'templates','题库导入示例_v1.jsonl');
    const preview=await invoke('import_preview',{path:source,bankId});
    assert.deepEqual(preview.errors,[]);
    await stop(); await launch();
    assert.ok((await invoke('import_jobs_list')).some(j=>j.preview.token===preview.token));
    await invoke('import_commit',{token:preview.token});
    assert.equal((await all(bankId)).length,3);
    const runs=await invoke('import_runs',{bankId});
    await invoke('import_undo',{runId:runs[0].id});
    assert.equal((await all(bankId)).length,0);
  });
  await check('real SQLite backup restore preserves state and rejects corrupt input', async () => {
    const before=await invoke('banks');
    const backup=path.join(files,'完整备份.sqlite');
    const count=await invoke('backup_database',{path:backup,restore:false});
    assert.ok(count>=914);
    const added=await invoke('create_bank',{name:'仅在备份之后存在'});
    await invoke('backup_database',{path:backup,restore:true});
    assert.ok(!(await invoke('banks')).some(b=>b.id===added));
    assert.deepEqual(await invoke('banks'),before);
    const invalid=path.join(files,'损坏备份.sqlite');
    await fs.writeFile(invalid,'not a database');
    await assert.rejects(invoke('backup_database',{path:invalid,restore:true}));
    assert.deepEqual(await invoke('banks'),before);
  });
  await check('second executable launch exits and focuses the existing instance', async () => {
    await page.getByRole('button',{name:'极速模式',exact:true}).click();
    const second=spawn(executable,[],{cwd:launchDirectory,windowsHide:true,stdio:'ignore'});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{second.kill();reject(Error('Second instance did not exit'));},10000);
      second.once('error',e=>{clearTimeout(timer);reject(e)});
      second.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error(`Second instance exited ${code}`))});
    });
    assert.equal(app.exitCode,null);
    await page.waitForFunction(()=>document.activeElement===document.querySelector('.search-box input'));
    assert.deepEqual(report.errors,[]); assert.deepEqual(report.requests,[]);
  });
  if (process.env.QBANK_SMOKE_NATIVE_REVIEW === '1') {
    await fs.writeFile(path.join(output,'native-ready.json'),JSON.stringify({pid:app.pid,executable}));
    console.log(`Native review ready: ${output}`);
    const deadline=Date.now()+600000;
    while(Date.now()<deadline && !(await fs.stat(path.join(output,'native-done')).catch(()=>null))) await delay(1000);
  }
} catch (error) {
  report.failure=String(error.stack||error);
  console.error(error);
  if(page) await screenshot('failure').catch(()=>{});
  process.exitCode=1;
} finally {
  await stop();
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(`Report: ${path.join(output,'report.json')}`);
}
