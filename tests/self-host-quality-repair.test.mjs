import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {validateStandardQuestion} from '../desktop/shared/intake.ts';

const require=createRequire(import.meta.url);
const {repairQuestionBank}=require('../cloud/qbank-auth/quality-repair.cjs');
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/intake/mobile-delta.json',import.meta.url),'utf8'));
const question=JSON.parse(fixture.payload);

test('quality repair removes exact duplicates and duplicate options without losing source IDs',()=>{
  const first={...structuredClone(question),question_id:'00000000-0000-4000-8000-000000000101',external_id:'S-101',options:[
    {key:'A',content:'PERSON_CLASS',option_id:'00000000-0000-4000-8000-000000000201'},
    {key:'B',content:'person_class',option_id:'00000000-0000-4000-8000-000000000202'},
    {key:'C',content:'PersonClass',option_id:'00000000-0000-4000-8000-000000000203'},
    {key:'D',content:'PersonClass',option_id:'00000000-0000-4000-8000-000000000204'},
  ],answer:['C'],status:'verified',issues:[],explanation:'短解析'};
  const second={...structuredClone(first),question_id:'00000000-0000-4000-8000-000000000102',external_id:'S-102',explanation:'更完整的解析'.repeat(40),tags:['来源复核']};
  const state={format:'qbank-state-1',bank_id:fixture.bank_id,name:fixture.name,revision:22,release_version:10,release_version_label:'v10',formal:[first,second],pending:[],resolved:[],batches:[],merge_history:[],updated_at:'2026-10-31T00:00:00Z'};
  const result=repairQuestionBank(state,{validateQuestion:validateStandardQuestion,clock:()=>Date.parse('2026-10-31T01:00:00Z')});
  assert.equal(result.changed,true);
  assert.equal(result.before,2);
  assert.equal(result.after,1);
  assert.equal(result.duplicates.length,1);
  assert.equal(result.optionRepairs.length,2);
  assert.equal(result.state.revision,23);
  assert.equal(result.state.release_version,11);
  assert.equal(result.state.release_version_label,'v11');
  assert.equal(result.state.formal[0].external_id,'S-101 / S-102');
  assert.deepEqual(result.state.formal[0].options.map(option=>option.key),['A','B','C']);
  assert.deepEqual(result.state.formal[0].answer,['C']);
  assert.ok(result.state.formal[0].tags.includes('重复题合并'));
  assert.ok(result.state.formal[0].tags.includes('选项去重'));
  assert.equal(state.formal.length,2);
});
