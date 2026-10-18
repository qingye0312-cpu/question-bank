// Validate a real old database on a new executable without modifying the source.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../../',import.meta.url));
if(!process.argv[2]||!process.argv[3]) throw Error('Usage: node windows-migration-smoke.mjs OLD_DATABASE NEW_EXE');
const source=path.resolve(process.argv[2]), executable=path.resolve(process.argv[3]);
await fs.mkdir(path.join(root,'artifacts'),{recursive:true});
const output=await fs.mkdtemp(path.join(root,'artifacts','windows-migration-'));
const database=path.join(output,'question-bank.sqlite');
const digest=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const originalHash=await digest(source);
const old=new DatabaseSync(source,{readOnly:true});
try { await backup(old,database); } finally {old.close();}
const queries={
  questions:'SELECT rowid,bank_id,id,kind,status,external_id,data,deleted FROM questions ORDER BY rowid',
  banks:'SELECT * FROM banks ORDER BY rowid',
  history:'SELECT * FROM history ORDER BY id',
};
function snapshot(){const db=new DatabaseSync(database,{readOnly:true});try{return {
  version:db.prepare('PRAGMA user_version').get().user_version,
  ...Object.fromEntries(Object.entries(queries).map(([key,sql])=>[key,db.prepare(sql).all()])),
};}finally{db.close();}}
const before=snapshot();
assert.equal(before.version,3,'Expected a v3 database from the previous Windows release');
const server=net.createServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
await new Promise(resolve=>server.close(resolve));
const modulePath=process.env.QBANK_PLAYWRIGHT_MODULE;
const {chromium}=await import(modulePath?pathToFileURL(modulePath).href:'playwright');
const app=spawn(executable,[],{cwd:output,windowsHide:true,stdio:'ignore',env:{...process.env,
  QBANK_DATA_DIR:output,WEBVIEW2_USER_DATA_FOLDER:path.join(output,'webview'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port} --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=tauri.localhost;ipc.localhost;127.0.0.1;localhost`,
}});
let browser,spawnError;app.on('error',e=>{spawnError=e});
try{
  for(let i=0;i<120;i++){
    if(spawnError)throw spawnError;
    if(app.exitCode!==null)throw Error(`App exited: ${app.exitCode}`);
    try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page=browser.contexts()[0].pages()[0];
  await page.waitForFunction(()=>window.__TAURI_INTERNALS__&&document.querySelector('.result,.speed-row'));
  const info=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('app_info'));
  assert.equal(path.resolve(info.database),database);
  const after=snapshot();
  assert.equal(after.version,4);
  for(const key of Object.keys(queries))assert.deepEqual(after[key],before[key],key);
  const backups=await fs.readdir(path.join(output,'backups'));
  assert.ok(backups.some(name=>name.includes('migration')));
  assert.equal(await digest(source),originalHash);
  const report={passed:true,executable,source,output,version:info.version,from:before.version,to:after.version,
    questions:after.questions.length,trashed:after.questions.filter(q=>q.deleted).length,history:after.history.length,
    backups,sourceUnchanged:true};
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}finally{
  if(browser)await browser.close().catch(()=>{});
  if(app.pid&&app.exitCode===null){const stopped=new Promise(resolve=>app.once('exit',resolve));app.kill();await stopped;}
}
