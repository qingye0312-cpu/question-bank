import React, {useState} from 'react';
import {Check, Copy} from 'lucide-react';
import {MODEL_PROMPT} from './generated/client-assets';
import {copyText} from './clipboard';
export function PromptTemplate(){
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  return <div className="prompt-template"><button className="template-card" disabled={busy} onClick={async()=>{
    setBusy(true);try{await copyText(MODEL_PROMPT);setMessage('提示词已复制，可以粘贴到大模型中并附上题目图片。')}
    catch{setMessage('复制失败，请重试。')}finally{setBusy(false)}
  }}>{message.startsWith('提示词已')?<Check/>:<Copy/>}<div><b>大模型输出规范模版</b><span>复制单题提示词 · 模型作答并记录版本</span></div><span>{busy?'复制中…':'复制提示词'}</span></button>{message&&<p className="intake-message" role="status">{message}</p>}</div>
}
