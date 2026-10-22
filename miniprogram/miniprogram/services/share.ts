import {loadBank,invalidateBank,selectBank} from './bank';
import {readLocal,updateLocal,createIds} from './intake-store';
import {resultName,sha256,validTime,validateStandardQuestion,type IntakeQuestion} from '../core/intake';

const FORMAT='qbank-bank-json-1';
const MAX_BYTES=32*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUESTION_FIELDS=['schema_version','question_id','base_revision','recorded_at','updated_at','recorded_at_source','type','stem','options','answer','bank','external_id','chapter','tags','explanation','status','difficulty','applicable_version','source_note','issues','sources','attachments','extensions'];
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
function utf8Bytes(value:string):number{let size=0;for(const character of value){const code=character.codePointAt(0)!;size+=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4}return size}
function plainQuestion(value:unknown,bankName:string):IntakeQuestion{
 if(!object(value))throw new Error('题库 JSON 中包含无效题目');
 const question:Record<string,unknown>={};for(const key of QUESTION_FIELDS)if(key in value)question[key]=value[key];
 question.bank=bankName;
 validateStandardQuestion(question,bankName,true);
 return question as unknown as IntakeQuestion;
}
function displayCopyName(source:string,names:string[]):string{
 const suffix='（分享副本）',base=Array.from(source).slice(0,100-Array.from(suffix).length).join('')+suffix;
 if(!names.includes(base))return base;
 for(let n=2;n<10000;n++){const extra=`（分享副本 ${n}）`,candidate=Array.from(source).slice(0,100-Array.from(extra).length).join('')+extra;if(!names.includes(candidate))return candidate}
 throw new Error('无法为导入副本生成唯一名称');
}

export async function exportBankJson(bankId:string):Promise<{filePath:string;fileName:string;questionCount:number;bankName:string}>{
 const {bank,manifest}=await loadBank(bankId);
 if(!bank.count)throw new Error('空题库没有可分享的内容');
 if(bank.count>100000)throw new Error('题目数量过多，请在桌面端导出');
 const questions=Array.from({length:bank.count},(_,index)=>plainQuestion(bank.question(index),manifest.name));
 const questionsText=JSON.stringify(questions),exportedAt=new Date().toISOString();
 const payload={format:FORMAT,source_bank:{bank_id:manifest.bank_id,name:manifest.name},exported_at:exportedAt,question_count:questions.length,questions,sha256:sha256(questionsText)};
 const text=JSON.stringify(payload,null,2);if(utf8Bytes(text)>MAX_BYTES)throw new Error('题库 JSON 超过 32 MiB，请在桌面端导出或拆分题库');
 const digest=sha256(questionsText),fileName=`${resultName(exportedAt,manifest.name,'分享','json',manifest.bank_id,digest)}.json`,filePath=`${wx.env.USER_DATA_PATH}/${fileName}`;
 const fs=wx.getFileSystemManager();
 await new Promise<void>((resolve,reject)=>fs.writeFile({filePath:filePath+'.tmp',data:text,encoding:'utf8',success:()=>resolve(),fail:reject}));
 await new Promise<void>((resolve,reject)=>fs.rename({oldPath:filePath+'.tmp',newPath:filePath,success:()=>resolve(),fail:reject}));
 return {filePath,fileName,questionCount:questions.length,bankName:manifest.name};
}

export async function importSharedBankJson(text:string):Promise<{bankId:string;name:string;added:number}>{
 if(utf8Bytes(text)>MAX_BYTES)throw new Error('JSON 文件超过 32 MiB');
 let value:unknown;try{value=JSON.parse(text)}catch{throw new Error('JSON 格式无效')}
 if(!object(value)||Object.keys(value).length!==6||!['format','source_bank','exported_at','question_count','questions','sha256'].every(key=>key in value)
  ||value.format!==FORMAT||!object(value.source_bank)||Object.keys(value.source_bank).length!==2
  ||typeof value.source_bank.bank_id!=='string'||!UUID.test(value.source_bank.bank_id)
  ||typeof value.source_bank.name!=='string'||!value.source_bank.name.trim()||Array.from(value.source_bank.name).length>100
  ||!validTime(value.exported_at)||!Number.isSafeInteger(value.question_count)||Number(value.question_count)<1||Number(value.question_count)>100000
  ||!Array.isArray(value.questions)||value.questions.length!==value.question_count||typeof value.sha256!=='string')throw new Error('不是受支持的题库 JSON 文件');
 const sourceName=value.source_bank.name,questions=value.questions.map(question=>plainQuestion(question,sourceName));
 const ids=new Set<string>();for(const question of questions){if(ids.has(question.question_id))throw new Error('题库 JSON 中题目 ID 重复');ids.add(question.question_id)}
 const digest=sha256(JSON.stringify(questions));if(digest!==value.sha256)throw new Error('题库 JSON 校验失败，文件可能不完整或已被修改');
 const at=new Date().toISOString(),idsFactory=await createIds(2),bankId=idsFactory(),batchId=idsFactory();
 const local=await readLocal(),name=displayCopyName(sourceName,local.banks.map(bank=>bank.name));
 const copied=questions.map(question=>plainQuestion({...question,bank:name},name));
 const payload=JSON.stringify(copied);
 await updateLocal(data=>{
  data.banks.push({id:bankId,name,createdAt:at,release_name:resultName(at,name,'分享导入','v1',bankId,sha256(payload))});
  data.batches.push({id:batchId,bankId,createdAt:at});
  for(const question of copied)data.entries.push({bankId,batchId,question,createdAt:at,uploadStatus:'uploaded_manual',exportedAt:'',sharedAt:''});
 });
 invalidateBank(bankId);selectBank(bankId);
 return {bankId,name,added:copied.length};
}
