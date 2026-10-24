// Generated from shared/intake.ts.
// Platform-independent single-question intake and additive package protocol.
export type ModelReply = {
  format: 'qbank-photo-question-1'; type: 'single' | 'multiple' | 'true_false';
  stem: string; options: {key: string; content: string}[]; answer: string[] | boolean;
  answer_origin: 'inferred'; explanation: string;
  model: {name: string; version: string; version_source: 'platform' | 'user' | 'unknown'};
  warnings: string[];
};
export type IntakeQuestion = {
  schema_version: string; question_id: string; base_revision: number;
  recorded_at?: string | null; updated_at?: string | null; recorded_at_source?: 'local' | 'import' | 'source' | 'unknown';
  type: ModelReply['type'] | 'programming'; stem: string; options: {key: string; content: string; option_id: string}[];
  answer: string[] | boolean | null; bank: string; external_id: string; chapter: string;
  tags: string[]; explanation: string; status: string; difficulty: string;
  applicable_version: string; source_note: string; issues: string[];
  sources: Record<string, unknown>[]; attachments: unknown[];
};
export type IntakeMetadata = {chapter:string;tags:string[];difficulty:''|'easy'|'medium'|'hard';applicable_version:string;external_id:string};
export function intakeMetadata(value:Partial<IntakeMetadata>={}):IntakeMetadata {
 const metadata={chapter:'',tags:[],difficulty:'',applicable_version:'',external_id:'',...value};
 if(Object.keys(metadata).some(k=>!['chapter','tags','difficulty','applicable_version','external_id'].includes(k))
  ||!['chapter','applicable_version','external_id'].every(k=>typeof metadata[k as keyof IntakeMetadata]==='string'&&(metadata[k as keyof IntakeMetadata] as string).length<=1000)
  ||!['','easy','medium','hard'].includes(metadata.difficulty)||!Array.isArray(metadata.tags)||metadata.tags.length>50
  ||metadata.tags.some(t=>typeof t!=='string'||t.length>100))throw Error('章节、标签或难度等补充信息无效');
 return {...metadata,tags:[...new Set(metadata.tags.map(t=>t.trim()).filter(Boolean))]} as IntakeMetadata;
}
type Comparable = {type: string; stem: string; options: {key: string; content: string}[]; answer: string[] | boolean | null};
// Released historical questions may deliberately retain an unresolved answer.
// New submissions never use that exception. This matches the desktop importer.
export function validateStandardQuestion(value:unknown,bank:string,legacy=false):void {
 const q=value as Omit<IntakeQuestion,'answer'> & {answer:string[]|boolean|null;extensions?:unknown};
 const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
 if(!q||!['1.0','1.1'].includes(q.schema_version)||!uuid.test(q.question_id)||q.bank!==bank||!Number.isSafeInteger(q.base_revision)||q.base_revision<1
  ||Object.keys(q).some(k=>!['schema_version','question_id','base_revision','recorded_at','updated_at','recorded_at_source','type','stem','options','answer','bank','external_id','chapter','tags','explanation','status','difficulty','applicable_version','source_note','issues','sources','attachments','extensions'].includes(k))
  ||!['stem','external_id','chapter','explanation','difficulty','applicable_version','source_note'].every(k=>typeof q[k as keyof typeof q]==='string')
  ||!q.stem.trim()||!['single','multiple','true_false','programming'].includes(q.type)||!['unreviewed','needs_review','verified'].includes(q.status)
  ||!['','easy','medium','hard'].includes(q.difficulty)||!Array.isArray(q.options)||q.options.length>26
  ||q.options.some((o,i)=>!o||!uuid.test(o.option_id)||o.key!==String.fromCharCode(65+i)||typeof o.content!=='string'||!o.content.trim()||Object.keys(o).some(k=>!['key','content','option_id'].includes(k)))
  ||new Set(q.options.map(o=>o.option_id)).size!==q.options.length||!Array.isArray(q.tags)||q.tags.some(v=>typeof v!=='string')
  ||!Array.isArray(q.issues)||q.issues.some(v=>typeof v!=='string')||!Array.isArray(q.sources)||q.sources.some(v=>!object(v))
  ||!Array.isArray(q.attachments)||q.attachments.length||q.extensions!=null)throw Error('题目结构或身份无效');
 for(const at of [q.recorded_at,q.updated_at])if(at!=null&&!validTime(at))throw Error('题目时间无效');
 if(q.recorded_at_source!=null&&!['local','import','source','unknown'].includes(q.recorded_at_source))throw Error('录入时间来源无效');
 if(q.schema_version==='1.1'&&(!q.recorded_at_source||(!q.recorded_at&&q.recorded_at_source!=='unknown')))throw Error('缺少录入时间条目');
 if(q.type==='programming'){
  if(q.options.length||q.answer!==null)throw Error('编程题不应包含选择项或标准答案');
  return;
 }
 if(legacy&&q.status==='needs_review'){
  if(q.type==='true_false'){if(q.options.length||!(typeof q.answer==='boolean'||q.answer===null&&q.sources.length))throw Error('历史判断题无效');}
  else if(!(q.answer===null&&q.sources.length)){
   if(!Array.isArray(q.answer)||new Set(q.answer).size!==q.answer.length||q.answer.some(k=>!q.options.some(o=>o.key===k)))throw Error('历史选择题答案无效');
  }
  return;
 }
 parseModelReply(JSON.stringify({format:'qbank-photo-question-1',type:q.type,stem:q.stem,options:q.options.map(o=>({key:o.key,content:o.content})),answer:q.answer,
  answer_origin:'inferred',explanation:q.explanation,model:{name:'未知',version:'未知',version_source:'unknown'},warnings:[]}),{historical:legacy});
}
const clean = (text: string) => text.replace(/\r\n?/g, '\n').trim();
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, names: string[], label: string) {
  if (Object.keys(value).length !== names.length || names.some(key => !(key in value)))
    throw new Error(`${label}字段不完整或含多余字段，请重新复制规范回复`);
}
export function parseModelReply(input: string, compatibility:{historical?:boolean}={}): ModelReply {
  if (input.length > 250_000) throw new Error('回复过长，请每次粘贴一道文字题');
  let text = input.trim().replace(/^\uFEFF/, '');
  if (text.startsWith('```')) {
    const match = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
    if (!match) throw new Error('请复制单个完整 JSON 代码块，或代码块中的 JSON');
    text = match[1];
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('JSON 格式无效，请检查引号、逗号和换行，或让模型重新输出'); }
  if (!object(value)) throw new Error('每次只能粘贴一道题的 JSON 对象');
  fields(value, ['format','type','stem','options','answer','answer_origin','explanation','model','warnings'], '回复');
  if (value.format !== 'qbank-photo-question-1') throw new Error('不是单题输出格式，请使用「大模型输出规范模版」');
  if (!['single','multiple','true_false'].includes(String(value.type))) throw new Error('题型未确定，仅支持单选、多选、判断');
  if (typeof value.stem !== 'string' || !value.stem.trim() || typeof value.explanation !== 'string') throw new Error('题干不能为空，解析必须是文字');
  if (!Array.isArray(value.options) || value.options.some((o, i) => !object(o)
    || Object.keys(o).length !== 2 || o.key !== String.fromCharCode(65+i) || typeof o.content !== 'string' || !o.content.trim()))
    throw new Error('选项须从 A 连续编号，每项只能包含 key 和非空 content');
  if (!compatibility.historical && value.type !== 'true_false' && new Set(value.options.map(o=>clean(o.content))).size !== value.options.length) throw new Error('选项内容重复，请核对后修改');
  if (value.type === 'true_false') {
    if (value.options.length || typeof value.answer !== 'boolean') throw new Error('判断题选项必须为 []，答案必须为 true 或 false');
  } else {
    const answers = value.answer, options = value.options;
    if (value.options.length < 2 || value.options.length > 8) throw new Error('选择题需要 2 至 8 个完整选项');
    if (!Array.isArray(answers) || answers.some(a => typeof a !== 'string' || !options.some((o: {key: string}) => o.key === a))
      || new Set(answers).size !== answers.length || (value.type === 'single' ? answers.length !== 1 : answers.length < 2))
      throw new Error('答案未确定或选项引用错误，请核对后再录入');
  }
  if (value.answer_origin !== 'inferred') throw new Error('模型尚未给出答案，请补全作答结果后再录入');
  if (!object(value.model)) throw new Error('缺少模型名称和版本记录');
  fields(value.model, ['name','version','version_source'], '模型');
  if (typeof value.model.name !== 'string' || !value.model.name.trim() || typeof value.model.version !== 'string' || !value.model.version.trim()
    || !['platform','user','unknown'].includes(String(value.model.version_source))) throw new Error('模型记录无效，无法确认的名称或版本请填“未知”');
  if (!Array.isArray(value.warnings) || value.warnings.some(w => typeof w !== 'string')) throw new Error('warnings 必须是文字数组');
  if ([value.stem, ...value.options.map(o => o.content)].some(s => s.includes('【看不清】'))) throw new Error('题目仍有看不清的内容，请补全后再录入');
  return value as ModelReply;
}
// Drafts are deliberately more permissive than saved questions. Never use this
// function to authorize a save or upload; parseModelReply remains the gate.
export function emptyReply():ModelReply {
 return {format:'qbank-photo-question-1',type:'single',stem:'',options:[{key:'A',content:''},{key:'B',content:''}],answer:[],answer_origin:'inferred',explanation:'',model:{name:'未知',version:'未知',version_source:'unknown'},warnings:[]};
}
export function parseDraft(input:string):ModelReply {
 if(input.length>250000)throw Error('回复过长，请每次粘贴一道题；原文已保留');
 const text=input.trim().replace(/^\uFEFF/,'').replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i,'$1');
 let v:Record<string,unknown>;try{v=JSON.parse(text)}catch{throw Error('JSON 尚不完整，原文已保存；可继续修改或手工录题');}
 if(!object(v))throw Error('每次粘贴一道题的 JSON 对象');
 const r=emptyReply(),str=(v:unknown)=>typeof v==='string'?v:'';
 r.type=(typeof v.type==='string'?v.type:'') as ModelReply['type'];
 r.stem=str(v.stem);r.explanation=str(v.explanation);
 r.options=Array.isArray(v.options)?v.options.map((o,i)=>({key:String.fromCharCode(65+i),content:object(o)?str(o.content):str(o)})):r.type==='true_false'?[]:r.options;
 r.answer=r.type==='true_false'?(typeof v.answer==='boolean'?v.answer:[]):Array.isArray(v.answer)?v.answer.filter((a):a is string=>typeof a==='string'):[];
 // Repair option labels only when their original identity is unambiguous.
 if(r.type!=='true_false'&&Array.isArray(v.options)&&Array.isArray(r.answer)){
  const original=v.options.map((o,i)=>object(o)&&typeof o.key==='string'?o.key:String.fromCharCode(65+i));
  if(new Set(original).size!==original.length)r.answer=[];
  else r.answer=r.answer.map(k=>{const i=original.indexOf(k);return i<0?k:String.fromCharCode(65+i)});
 }
 if(object(v.model))r.model={name:str(v.model.name)||'未知',version:str(v.model.version)||'未知',version_source:['platform','user','unknown'].includes(String(v.model.version_source))?v.model.version_source as ModelReply['model']['version_source']:'unknown'};
 r.warnings=Array.isArray(v.warnings)?v.warnings.filter((w):w is string=>typeof w==='string'):[];
 return r;
}
export function toggleAnswer(reply:ModelReply,key:string|boolean):ModelReply {
 if(reply.type==='true_false')return {...reply,answer:reply.answer===key?[]:typeof key==='boolean'?key:[]};
 if(typeof key!=='string'||!reply.options.some(o=>o.key===key))return reply;
 const selected=Array.isArray(reply.answer)?reply.answer:[];
 return {...reply,answer:selected.includes(key)?selected.filter(k=>k!==key):reply.type==='single'?[key]:[...selected,key]};
}
export function replyFromQuestion(q:IntakeQuestion):ModelReply {
 const source=q.sources.find(s=>s.kind==='model_reply');
 return parseDraft(JSON.stringify({...q,format:'qbank-photo-question-1',answer_origin:'inferred',model:source?.model,warnings:q.issues}));
}
export function validTime(value:unknown):value is string {
 return typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value));
}
export function recordedTime(q:{recorded_at?:string|null;sources?:Record<string,unknown>[]}):string|null {
 if(validTime(q.recorded_at))return q.recorded_at;
 const source=q.sources?.find(s=>validTime(s.recorded_at));return source?.recorded_at as string||null;
}
export function withRecordedTime(q:IntakeQuestion,importedAt?:string):IntakeQuestion {
 const at=recordedTime(q),importTime=q.recorded_at_source==='unknown'?undefined:importedAt;
 return {...q,schema_version:'1.1',recorded_at:at||importTime||null,recorded_at_source:q.recorded_at_source||(at?'source':importTime?'import':'unknown')};
}
export function displayTime(at:unknown):string {return validTime(at)?new Date(at).toLocaleString('zh-CN',{hour12:false}):'历史时间未知';}
// Names use a fixed zone, independent of the device locale and wall clock.
export function resultName(at:string|null|undefined,name:string,stage:string,version:string,bankId:string,digest:string):string {
 const stamp=validTime(at)?new Date(Date.parse(at)+8*3600000).toISOString().replace(/[-:TZ.]/g,'').slice(0,17).replace(/^(\d{8})(.*)$/,'$1-$2')+'+0800':'历史迁移';
 const safe=(s:string,n:number)=>Array.from(s.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/[. ]+$/,'')).slice(0,n).join('');
 return `${stamp}_${safe(name,36)}_${safe(stage,10)}_${safe(version,18)}_${bankId.slice(0,8)}-${digest.slice(0,8)}`;
}
// Keep answer identity when options move; deleting an answer leaves it unset so
// the ordinary validator requires the user to make an explicit new choice.
export function reorderOptions(reply: ModelReply, order: number[]): ModelReply {
  const selected = new Set(Array.isArray(reply.answer) ? reply.answer : []);
  const options = order.map((old, i) => ({key:String.fromCharCode(65+i), content:reply.options[old].content}));
  const answer = order.flatMap((old, i) => selected.has(reply.options[old].key) ? [String.fromCharCode(65+i)] : []);
  return {...reply, options, answer};
}
export function changeQuestionType(reply: ModelReply, type: ModelReply['type']): ModelReply {
  if(type === reply.type)return reply;
  return {...reply,type,options:type==='true_false'?[]:reply.options.length?reply.options:[{key:'A',content:''},{key:'B',content:''}],
    answer:[]};
}
export const MANUAL_REVIEW_NOTE = '录入者已人工修改，请复核答案；模型信息仅记录原始作答来源。';
export function editedReplyText(reply: ModelReply, original: string): string {
  let before:ModelReply;try{before=parseDraft(original)}catch{before=emptyReply()}
  const warnings = reply.warnings.filter(w=>w!==MANUAL_REVIEW_NOTE);
  const cleanReply = {...reply,warnings};
  if(JSON.stringify(cleanReply)!==JSON.stringify(before))warnings.push(MANUAL_REVIEW_NOTE);
  return JSON.stringify({...reply,warnings},null,2);
}
export function identityKey(q: Comparable): string {
  const options = q.options.map(o => clean(o.content));
  // Repeated option text cannot be remapped unambiguously: retain its order.
  if (new Set(options).size === options.length) options.sort();
  return JSON.stringify([q.type, clean(q.stem), options]);
}
export function sameAnswer(a: Comparable, b: Comparable): boolean {
  const signature = (q: Comparable) => {
    if (!Array.isArray(q.answer)) return JSON.stringify(q.answer);
    const repeated = new Set(q.options.map(o => clean(o.content))).size !== q.options.length;
    return JSON.stringify(q.answer.map(key => repeated ? key : clean(q.options.find(o => o.key === key)?.content || '')).sort());
  };
  return signature(a) === signature(b);
}
export function toQuestion(reply: ModelReply, bank: string, id: () => string, at: string): IntakeQuestion {
  return {schema_version:'1.1', question_id:id(), base_revision:1, recorded_at:at, recorded_at_source:'local',updated_at:at,type:reply.type, stem:reply.stem,
    options:reply.options.map(o => ({...o, option_id:id()})), answer:reply.answer, bank, external_id:'',
    chapter:'', tags:[], explanation:reply.explanation, status:'unreviewed', difficulty:'', applicable_version:'',
    source_note:`${reply.warnings.includes(MANUAL_REVIEW_NOTE)?'人工修改，原始模型':'大模型作答'} · ${reply.model.name} / ${reply.model.version}`, issues:reply.warnings,
    sources:[{kind:'model_reply', model:reply.model, answer_origin:reply.answer_origin, warnings:reply.warnings, recorded_at:at}], attachments:[]};
}
export function uuidFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('无法生成题目 ID');
  const b = bytes.slice(); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const hex = Array.from(b, v => v.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
// SHA-256 over UTF-8. No browser crypto dependency in the WeChat runtime.
export function sha256(text: string): string {
  const bytes: number[] = [];
  for (const ch of text) {
    let c = ch.codePointAt(0)!;
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 128) bytes.push(c);
    else if (c < 2048) bytes.push(192 | (c >> 6), 128 | (c & 63));
    else if (c < 65536) bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    else bytes.push(240 | (c >> 18), 128 | ((c >> 12) & 63), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  const bits = bytes.length * 8;
  bytes.push(128); while (bytes.length % 64 !== 56) bytes.push(0);
  for (const n of [Math.floor(bits / 0x100000000), bits >>> 0]) for (let s = 24; s >= 0; s -= 8) bytes.push((n >>> s) & 255);
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rot = (n: number, s: number) => (n >>> s) | (n << (32-s));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = new Int32Array(64);
    for (let i = 0; i < 16; i++) { const j = offset + i*4; w[i] = (bytes[j]<<24)|(bytes[j+1]<<16)|(bytes[j+2]<<8)|bytes[j+3]; }
    for (let i=16;i<64;i++) {const a=w[i-15],b=w[i-2]; w[i]=(w[i-16]+(rot(a,7)^rot(a,18)^(a>>>3))+w[i-7]+(rot(b,17)^rot(b,19)^(b>>>10)))|0;}
    let [a,b,c,d,e,f,g,j]=h;
    for(let i=0;i<64;i++){const t1=(j+(rot(e,6)^rot(e,11)^rot(e,25))+((e&f)^(~e&g))+k[i]+w[i])|0;
      const t2=((rot(a,2)^rot(a,13)^rot(a,22))+((a&b)^(a&c)^(b&c)))|0;
      j=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;}
    [a,b,c,d,e,f,g,j].forEach((v,i)=>{h[i]=(h[i]+v)|0;});
  }
  return h.map(n=>(n>>>0).toString(16).padStart(8,'0')).join('');
}
export function deltaPackage(bankId: string, name: string, batchId: string, questions: IntakeQuestion[], at: string): string {
  if (!questions.length) throw new Error('本批次还没有新题');
  const payload = questions.map(q => JSON.stringify(q)).join('\n')+'\n';
  return JSON.stringify({format:'qbank-delta-1', bank_id:bankId, name, batch_id:batchId,
    created_at:at, question_count:questions.length, payload, sha256:sha256(payload)}, null, 2);
}
export type Delta = {format:string;bank_id:string;name:string;batch_id:string;created_at:string;question_count:number;payload:string;sha256:string};
export function parseDelta(text: string): {delta: Delta; questions: IntakeQuestion[]} {
  if (text.length > 32*1024*1024) throw new Error('增量包过大，请拆分后导入');
  const d: unknown = JSON.parse(text);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!object(d)) throw new Error('增量包格式无效');
  fields(d,['format','bank_id','name','batch_id','created_at','question_count','payload','sha256'],'增量包');
  if (d.format !== 'qbank-delta-1' || typeof d.bank_id !== 'string' || !uuid.test(d.bank_id)
    || typeof d.batch_id !== 'string' || !uuid.test(d.batch_id) || typeof d.name !== 'string' || !d.name.trim() || Array.from(d.name).length>100
    || typeof d.created_at !== 'string' || typeof d.payload !== 'string' || typeof d.sha256 !== 'string'
    || !Number.isInteger(d.question_count) || Number(d.question_count)<1) throw new Error('增量包身份或字段无效');
  if (sha256(d.payload)!==d.sha256) throw new Error('增量包校验失败，文件可能不完整');
  const ids=new Set<string>();
  const questions=d.payload.split('\n').filter(line=>line.trim()).map(line=>{
    if(line.length>250_000)throw new Error('单题过大');
    const q=JSON.parse(line) as IntakeQuestion;
    if(!['1.0','1.1'].includes(q.schema_version)||typeof q.question_id!=='string'||!uuid.test(q.question_id)||ids.has(q.question_id)
      ||!Number.isSafeInteger(q.base_revision)||q.base_revision<1)throw new Error('题目 ID 或修订号无效');
    ids.add(q.question_id);
    if(q.type!=='programming')parseModelReply(JSON.stringify({format:'qbank-photo-question-1',type:q.type,stem:q.stem,
      options:q.options?.map(o=>({key:o.key,content:o.content})),answer:q.answer,answer_origin:'inferred',
      explanation:q.explanation,model:{name:'未知',version:'未知',version_source:'unknown'},warnings:[]}));
    if(!Array.isArray(q.sources)||!Array.isArray(q.tags)||q.tags.some(t=>typeof t!=='string')
      ||!Array.isArray(q.issues)||q.issues.some(t=>typeof t!=='string')||!Array.isArray(q.attachments)||q.attachments.length
      ||q.options.some(o=>typeof o.option_id!=='string'||!uuid.test(o.option_id))
      ||['bank','external_id','chapter','source_note','status','difficulty','applicable_version'].some(k=>typeof (q as unknown as Record<string,unknown>)[k]!=='string'))throw new Error('题目元数据不完整');
    validateStandardQuestion(q,String(d.name));return q;
  });
  if(questions.length!==d.question_count)throw new Error('增量包题目数量不一致');
  return {delta:d as Delta,questions};
}
