import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {DraftAutosave,migrationId,newDraft,pasteDraft,reviseDraft,startManual,hasDraftContent,type DraftRecord} from '../../shared/draft';
import {intakeMetadata} from '../../shared/intake';

async function readRecords(bankId:string){
 let records=await invoke<DraftRecord[]>('draft_records',{bankId});
 const old=await invoke<any>('client_state',{key:`draft:${bankId}`,value:null});
 if(old&&!old.migrated){
  for(const [slot,draft] of [old.draft||old.current,old.previous].entries()){
   if(!draft)continue;
   const id=migrationId(bankId,slot,draft);if(records.some(r=>r.id===id))continue;
   if(!draft.text&&!draft.reply||draft.editing&&records.some(r=>r.id===draft.editing))continue;
   let r=pasteDraft(newDraft(id,bankId),draft.text||JSON.stringify(draft.reply));
   if(draft.reply)r={...r,reply:draft.reply,original:draft.original||r.original,metadata:intakeMetadata(draft.metadata||{})};
   await invoke('draft_save',{record:r,expected:0});
  }
  await invoke('client_state',{key:`draft:${bankId}`,value:{...old,migrated:true}});
  records=await invoke<DraftRecord[]>('draft_records',{bankId});
 }
 return records;
}
export function useIntake(bankId:string,initial='',initialRecordId='',manual=false){
 const [records,setRecords]=useState<DraftRecord[]>([]),[current,setCurrent]=useState<DraftRecord>(()=>newDraft(crypto.randomUUID(),bankId));
 const [ready,setReady]=useState(false),[saving,setSaving]=useState('已存本机'),[error,setError]=useState('');
 const active=useRef(current),all=useRef(records),alive=useRef(true),initialUsed=useRef(false);
 const updateRecords=(next:DraftRecord[])=>{all.current=next;setRecords(next)};
 const setActive=(record:DraftRecord)=>{active.current=record;setCurrent(record)};
 const saver=useRef<DraftAutosave|null>(null);
 if(!saver.current)saver.current=new DraftAutosave((record,expected)=>invoke('draft_save',{record,expected}),saved=>{
  if(!alive.current)return;
  updateRecords(all.current.map(r=>r.id===saved.id&&r.revision===saved.revision?saved:r));
  if(active.current.id===saved.id&&active.current.revision===saved.revision){setActive(saved);setSaving('已存本机');}
 },e=>{if(alive.current){setSaving('保存失败 · 点击重试');setError(String(e));}});
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;saver.current!.dispose();void saver.current!.flush().catch(()=>{});}},[]);
 useEffect(()=>{let valid=true;setReady(false);void readRecords(bankId).then(items=>{
  if(!valid)return;saver.current!.seed(items);updateRecords(items);
  let next=manual?startManual(newDraft(crypto.randomUUID(),bankId)):items.find(r=>r.id===initialRecordId)||[...items].reverse().find(r=>!r.removed&&!r.submissionId)||newDraft(crypto.randomUUID(),bankId);
  if(manual){updateRecords([...items,next]);saver.current!.set(next);setSaving('保存中…');}
  if(initial&&!initialUsed.current){initialUsed.current=true;next=pasteDraft(newDraft(crypto.randomUUID(),bankId),initial);updateRecords([...items,next]);saver.current!.set(next);setSaving('保存中…');}
  setActive(next);setReady(true);
 }).catch(e=>{if(valid)setError(String(e))});return()=>{valid=false}},[bankId,manual]);
 function change(patch:Partial<DraftRecord>){const next=reviseDraft(active.current,patch);stage(next);}
 function stage(next:DraftRecord){setActive(next);updateRecords(all.current.some(r=>r.id===next.id)?all.current.map(r=>r.id===next.id?next:r):[...all.current,next]);setSaving('保存中…');setError('');saver.current!.set(next);}
 function paste(raw:string){stage(pasteDraft(active.current,raw));}
 async function flush(){try{await saver.current!.flush();setSaving('已存本机')}catch(e){setSaving('保存失败 · 点击重试');setError(String(e));throw e;}}
 async function select(record:DraftRecord){await flush();setActive(all.current.find(r=>r.id===record.id)||record);}
 async function next(){await flush();setActive({...newDraft(crypto.randomUUID(),bankId),metadata:{...active.current.metadata,external_id:''}});}
 async function remove(record:DraftRecord){await flush();const next=reviseDraft(record,{removed:true});saver.current!.set(next);updateRecords(all.current.map(r=>r.id===next.id?next:r));await flush();if(active.current.id===next.id)setActive(newDraft(crypto.randomUUID(),bankId));}
 async function reload(){await flush();const items=await readRecords(bankId);saver.current!.seed(items);updateRecords(items);const found=items.find(r=>r.id===active.current.id);if(found)setActive(found);return items;}
 return {records,current,ready,saving,error,setError,change,paste,flush,select,next,remove,reload,hasContent:hasDraftContent(current)};
}
