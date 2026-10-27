import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256,parseDelta} from '../shared/intake.ts';
import {readManifest,readSnapshot} from '../shared/sync.ts';
import {encodeUpload} from '../tools/encode-upload.mjs';

const runtime = '../artifacts/self-host/qbank-auth/';
const { createFileStore } = await import(`${runtime}fs-store.cjs`);
const { createLocalServer } = await import(`${runtime}local-server.cjs`);
const {unpackText}=await import(`${runtime}codec.cjs`);

const bankId = 'ad50971f-66af-51c2-bb0e-dc798b03b369';
const batchId = '00000000-0000-4000-8000-000000000001';

function localRequest(server, method, path, body, token) {
  const req = new EventEmitter();
  req.method = method;
  req.url = path;
  req.headers = {host: '127.0.0.1','content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})};
  return new Promise((resolve, reject) => {
    const response = {statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body = '') {
      try { resolve({status: this.statusCode, headers: this.headers, data: JSON.parse(body || 'null')}); }
      catch (error) { reject(error); }
    }};
    try { server.listeners('request')[0](req, response);queueMicrotask(()=>{if(body!==undefined)req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end')}); } catch (error) { reject(error); }
  });
}

test('filesystem store keeps immutable state and idempotent submissions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbank-store-'));
  const store = createFileStore({ root });
  const state = { format: 'qbank-state-1', bank_id: bankId, name: '测试库', revision: 1,
    release_version: 1, formal: [], pending: [], resolved: [], batches: [], merge_history: [], updated_at: new Date().toISOString() };
  assert.equal(await store.createState(state), true);
  assert.equal(await store.createState(state), false);
  assert.equal((await store.readState(bankId)).revision, 1);
  const record = { format: 'qbank-submission-1', bank_id: bankId, batch_id: batchId, sha256: 'a'.repeat(64), package: {} };
  assert.equal((await store.createSubmission(`inbox/${bankId}/${batchId}.json`, record)).created, true);
  const retry = await store.createSubmission(`inbox/${bankId}/${batchId}.json`, record);
  assert.equal(retry.created, false);
  assert.equal(retry.record.batch_id, batchId);
  await assert.rejects(() => store.createState({ ...state, revision: 0 }), /Invalid state revision/);
  await fs.rm(root, { recursive: true, force: true });
});

test('local HTTP host handler preserves health and catalog routes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbank-host-'));
  const env = { QBANK_STORAGE_ROOT: root, QBANK_BIND_HOST: '127.0.0.1',
    QBANK_BANKS: JSON.stringify([{ bank_id: bankId, name: '测试库' }]), QBANK_SYNC_ENABLED: 'true',
    QBANK_UPLOAD_ENABLED: 'false', QBANK_ALLOWED_ORIGINS: '[]', QBANK_MAINTAINERS: '[]',
    QBANK_CLOUD_CREATORS: '[]', QBANK_SESSION_SECRET: 'a'.repeat(64) };
  const {server} = createLocalServer({env});
  const health = await localRequest(server, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.service, 'qbank-auth');
  assert.equal(health.data.auth_configured, true);
  const catalog = await localRequest(server, 'GET', '/v1/catalog');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.data.banks[0].bank_id, bankId);
  assert.equal(catalog.data.banks[0].revision, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test('concurrent filesystem commits expose one complete compressed version and reject plaintext files',async(t)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'qbank-atomic-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=createFileStore({root}),base={format:'qbank-state-1',bank_id:bankId,revision:1,formal:[],marker:'a'};
 const results=await Promise.all([store.createState(base),store.createState({...base,marker:'b'})]);
 assert.deepEqual(results.sort(),[false,true]);
 const directory=path.join(root,'states',bankId),names=await fs.readdir(directory);assert.equal(names.length,1);assert.ok(names[0].endsWith('.json'));
 const file=path.join(directory,names[0]),packed=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(packed.format,'qbank-cloud-file-1');assert.equal(packed.encoding,'gzip+base64');
 assert.deepEqual(JSON.parse(unpackText(packed)),await store.readState(bankId));
 await fs.writeFile(file,JSON.stringify(base));
 await assert.rejects(()=>store.readState(bankId),/Invalid cloud file/);
});

test('latest-state reads and version history continue past 256 merges',async(t)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'qbank-history-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=createFileStore({root});
 for(let revision=1;revision<=257;revision++)assert.equal(await store.createState({format:'qbank-state-1',bank_id:bankId,revision,formal:[]}),true);
 assert.equal((await store.readState(bankId)).revision,257);assert.equal((await store.listStates(bankId)).length,257);
 assert.equal((await store.readStateAt(bankId,1)).revision,1);
});

test('packaged self-host merges an upload, reopens compressed disk state, replays its receipt and rolls back',async(t)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'qbank-merge-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const fixture=await fs.readFile(new URL('fixtures/intake/mobile-delta.json',import.meta.url),'utf8');
 const {delta,questions}=parseDelta(fixture),key='d'.repeat(64),id=delta.bank_id;
 const env={QBANK_STORAGE_ROOT:root,QBANK_SYNC_ENABLED:'true',QBANK_UPLOAD_ENABLED:'true',QBANK_SESSION_SECRET:'a'.repeat(64),
  QBANK_BANKS:JSON.stringify([{bank_id:id,name:delta.name}]),
  QBANK_CLOUD_CREATORS:JSON.stringify(['maintainer-tests']),QBANK_MAINTAINERS:JSON.stringify([{id:'maintainer-tests',key_sha256:sha256(key),grants:{[id]:['upload','merge']}}])};
 let {server}=createLocalServer({env});
 const login=await localRequest(server,'POST','/v1/auth/desktop',{key});assert.equal(login.status,200);
 const token=login.data.access_token;
 const base={...questions[0],question_id:randomUUID(),stem:'自托管首版题目',status:'verified'};
 assert.equal((await localRequest(server,'POST',`/v1/banks/${id}/seed`,{base_revision:0,questions:[base]},token)).status,200);
 const merged=await localRequest(server,'POST','/v1/uploads',encodeUpload(fixture),token);assert.equal(merged.status,201,JSON.stringify(merged.data));
 assert.equal(merged.data.receipt.status,'merged');assert.equal(merged.data.receipt.revision,2);
 for(const name of await fs.readdir(path.join(root,'states',id))){const packed=JSON.parse(await fs.readFile(path.join(root,'states',id,name),'utf8'));assert.equal(packed.encoding,'gzip+base64');assert.ok(JSON.parse(unpackText(packed)).formal.length);}
 const inbox=JSON.parse(await fs.readFile(path.join(root,'inbox',id,`${delta.batch_id}.json`),'utf8'));assert.equal(inbox.encoding,'gzip+base64');
 server=createLocalServer({env}).server;
 const retry=await localRequest(server,'POST','/v1/uploads',encodeUpload(fixture),token);assert.equal(retry.data.receipt.status,'duplicate');assert.equal(retry.data.receipt.merged_at,merged.data.receipt.merged_at);
 const manifest=readManifest((await localRequest(server,'GET',`/v1/banks/${id}/manifest`)).data);
 const snapshot=readSnapshot((await localRequest(server,'GET',`/v1/banks/${id}/snapshot-file`)).data,manifest);assert.equal(snapshot.formal.length,2);assert.equal(snapshot.pending.length,0);
 const rollback=await localRequest(server,'POST',`/v1/banks/${id}/rollback`,{base_revision:2,target_revision:1,operation_id:randomUUID()},token);assert.equal(rollback.status,200);assert.equal(rollback.data.revision,3);
 assert.equal((await localRequest(server,'GET',`/v1/banks/${id}/history`,undefined,token)).data.versions.length,1);
 assert.equal((await createFileStore({root}).readState(id)).formal.length,1);
});
