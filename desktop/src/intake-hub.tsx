import {Download, FileJson, FileText, Sparkles} from 'lucide-react';

export function IntakeHub({busy,bankId,showExport=true,onAI,onManual,onJSON,onExport,onClose}:{busy:boolean;bankId:string;showExport?:boolean;onAI:(bankId:string)=>void;onManual:(bankId:string)=>void;onJSON:()=>void;onExport:()=>void;onClose:()=>void}){
 return <div className="modal-backdrop intake-hub-backdrop"><section className="modal intake-hub" role="dialog" aria-modal="true" aria-labelledby="intake-hub-title">
  <button className="close-modal" aria-label="关闭录题与导入" onClick={onClose}>×</button>
  <div className="modal-icon"><Sparkles/></div><h2 id="intake-hub-title">录题与导入</h2><p>录入内容先保存在本机。选择云端题库时提交上传；选择本地题库时直接提交到本地题库。JSON 文件可以导入，也可以直接拖到窗口。</p>
  <div className="intake-hub-actions">
   <button className="template-card" disabled={busy} onClick={()=>onAI(bankId)}><Sparkles/><div><b>大模型录题</b><span>粘贴模型回复并校对，先存本机，再按题库类型提交。</span></div></button>
   <button className="template-card" disabled={busy} onClick={()=>onManual(bankId)}><FileText/><div><b>手动录题</b><span>直接填写题干、选项、答案和解析。</span></div></button>
   <button className="template-card" disabled={busy} onClick={onJSON}><FileJson/><div><b>导入 JSON</b><span>按题库身份合并增量题目，自动跳过重复内容。</span></div></button>
   {showExport&&<button className="template-card" disabled={busy} onClick={onExport}><Download/><div><b>导出题目</b><span>选择题库与录入时间范围，按推荐格式导出 DOCX。</span></div></button>}
  </div>
  <div className="callout intake-hub-drop"><b>JSON 拖放</b><span>将单个 .json 增量文件拖到应用窗口即可导入。</span></div>
  <button className="close-hub" onClick={onClose}>关闭</button>
 </section></div>;
}
