import {useEffect, useRef, useState} from 'react';
import type {KeyboardEvent} from 'react';
import {ArrowRight, ChevronDown, Download, FileText, X} from 'lucide-react';
import {DateTimePicker} from './date-time-picker';
import {calendarDate, localDateTime, moveCalendarDate} from './date-time';
import {loadCloudOperations} from './cloud-client';
import type {Bank} from './types';
import './question-export.css';

type ExportScope = 'all' | 'range' | 'revision';
type Revision={revision:number;formal_revision?:string;release_version:number;release_version_label?:string|null;updated_at:string;added_count?:number;changed_count?:number;question_count?:number;batch_id?:string|null;has_incremental_json?:boolean;has_revision_questions?:boolean;uploader_real_name?:string|null;uploader_nickname?:string|null};
const displayUploader=(...values:Array<string|null|undefined>)=>values.map(value=>value?.trim()).find(value=>value&&value!=='未记录')||'star';

export function QuestionExport({banks, defaultBankId, busy, onClose, onExport}: {
  banks: Bank[];
  defaultBankId: string;
  busy: boolean;
  onClose: () => void;
  onExport: (bankId: string, startAt: string | null, endBefore: string | null, revisions: number[]) => void;
}) {
  const [bankId, setBankId] = useState(defaultBankId);
  const [scope, setScope] = useState<ExportScope>('all');
  const [start, setStart] = useState(() => ({date: calendarDate(new Date()), time: '00:00'}));
  const [end, setEnd] = useState(() => ({date: calendarDate(new Date()), time: '23:59'}));
  const [confirming, setConfirming] = useState(false);
  const [validation, setValidation] = useState('');
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [selectedRevisions, setSelectedRevisions] = useState<number[]>([]);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const cancelConfirmation = useRef<HTMLButtonElement>(null);
  const selected = banks.find(bank => bank.id === bankId);
  const selectedRevisionRows = revisions.filter(row => selectedRevisions.includes(row.revision));
  const selectedRevisionCount = selectedRevisionRows.reduce((total, row) => total + (row.changed_count ?? row.added_count ?? 0), 0);

  useEffect(() => {
    if (!banks.some(bank => bank.id === bankId)) {
      setBankId(banks[0]?.id || '');
      setScope('all');
      setValidation('');
    }
  }, [banks, bankId]);

  useEffect(() => {
    if (scope !== 'revision' || !selected?.read_only) {
      setRevisions([]);
      setSelectedRevisions([]);
      setRevisionLoading(false);
      return;
    }
    let active = true;
    setRevisionLoading(true);
    setValidation('');
    void loadCloudOperations(bankId).then(result => {
      if (!active) return;
      const rows = (Array.isArray(result.revisions) ? result.revisions.map(row => ({...row,added_count:row.added_count,changed_count:row.changed_count,has_revision_questions:row.changed_count>0,has_incremental_json:!!row.batch_id,uploader_real_name:row.uploader.real_name||null,uploader_nickname:row.uploader.nickname||null})) : []).sort((left, right) => right.revision - left.revision);
      setRevisions(rows);
      setSelectedRevisions([]);
    }).catch(error => {
      if (active) setValidation(String(error));
    }).finally(() => {if (active) setRevisionLoading(false);});
    return () => {active = false;};
  }, [scope, bankId, selected?.read_only]);

  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector('select')?.focus({preventScroll: true});
    return () => {if (previous instanceof HTMLElement && previous.isConnected) previous.focus({preventScroll: true});};
  }, []);
  useEffect(() => {if (confirming) cancelConfirmation.current?.focus({preventScroll: true});}, [confirming]);

  function reviewExport() {
    setValidation('');
    if (!selected) {setValidation('请先选择题库。'); return;}
    if (scope === 'revision') {
      if (!selected.read_only) {setValidation('按修订版本导出仅支持云端题库。'); return;}
      if (!selectedRevisions.length) {setValidation('请至少选择一个修订版本。'); return;}
    } else if (scope === 'range') {
      const from = localDateTime(start.date, start.time), through = localDateTime(end.date, end.time);
      if (!from || !through) {setValidation('请完整选择有效的开始和结束时间。'); return;}
      if (from > through) {setValidation('开始时间不能晚于结束时间。'); return;}
    }
    setConfirming(true);
  }
  function confirmExport() {
    if (!selected) return;
    setConfirming(false);
    if (scope === 'revision') {onExport(bankId, null, null, selectedRevisions); return;}
    if (scope === 'all') {onExport(bankId, null, null, []); return;}
    const from = localDateTime(start.date, start.time), through = localDateTime(end.date, end.time);
    if (!from || !through || from > through) return;
    // Include the entire selected end minute; the backend uses a half-open interval.
    onExport(bankId, from.toISOString(), new Date(through.getTime() + 60_000).toISOString(), []);
  }
  function cancelReview() {
    setConfirming(false);
    requestAnimationFrame(() => continueButton.current?.focus({preventScroll: true}));
  }
  function setRecentRange(days: number) {
    const today = calendarDate(new Date());
    setStart({date: moveCalendarDate(today, 1 - days), time: '00:00'});
    setEnd({date: today, time: '23:59'});
    setValidation('');
  }
  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!busy) confirming ? cancelReview() : onClose();
    }
    if (event.key === 'Tab') {
      const root = panel.current?.querySelector(confirming ? '.question-export-confirm' : '.question-export-content');
      const items = [...(root?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)') || [])];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
      if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
    }
  }

  return <div className="modal-backdrop question-export-backdrop" onMouseDown={event => {if (event.target === event.currentTarget && !busy && !confirming) onClose();}}>
    <section ref={panel} className="modal question-export-panel" role="dialog" aria-modal="true" aria-labelledby="question-export-title" onKeyDown={handleKeys}>
      <div className="question-export-content" inert={confirming}>
        <header className="question-export-heading">
          <div className="modal-icon"><FileText aria-hidden="true"/></div>
          <div className="question-export-heading-copy">
            <h2 id="question-export-title">导出题目</h2>
            <p>仅导出题目、选项、答案与解析。</p>
          </div>
          <button className="question-export-close" aria-label="关闭题目导出" disabled={busy} onClick={onClose}><X/></button>
        </header>
        <div className="question-export-body">
          <div className="question-export-selection-row">
            <label className="question-export-bank-label">选择题库
              <span className="question-export-select-wrap">
                <select value={bankId} onChange={event => {const next=event.target.value;setBankId(next);if (!banks.find(bank => bank.id === next)?.read_only && scope === 'revision') setScope('all');setValidation('');}} disabled={busy}>
                  <option value="" disabled>请选择题库</option>
                  {banks.map(bank => <option key={bank.id} value={bank.id}>{bank.name} · {bank.count.toLocaleString()} 题</option>)}
                </select>
                <ChevronDown aria-hidden="true"/>
              </span>
            </label>
            <div className="question-export-scope">
              <span id="question-export-scope-label">导出范围</span>
              <div className="question-export-segments" role="radiogroup" aria-labelledby="question-export-scope-label">
                {(['all', 'range', 'revision'] as const).map(value => <label key={value} className={`${scope === value ? 'selected' : ''}${value === 'revision' && !selected?.read_only ? ' disabled' : ''}`}>
                  <input type="radio" name="question-export-scope" value={value} checked={scope === value} disabled={busy || (value === 'revision' && !selected?.read_only)}
                    onChange={() => {setScope(value); setValidation('');}}/>
                  <span>{value === 'all' ? '全部导出' : value === 'range' ? '按时间范围' : '按修订版本'}</span>
                </label>)}
              </div>
            </div>
          </div>
          <div className="question-export-range-content">
            {scope === 'all' ? <div className="question-export-all">
              <strong>{(selected?.count || 0).toLocaleString()}<span>题</span></strong>
              <p>导出所选题库的全部题目</p>
            </div> : scope === 'revision' ? <div className="question-export-revisions">
              {revisionLoading ? <p className="question-export-range-note">正在读取修订记录…</p> : !revisions.length ? <p className="question-export-range-note">当前题库暂无可用修订记录。</p> : <>
                <div className="question-export-revision-table-wrap"><table className="question-export-revision-table"><thead><tr><th scope="col">选择</th><th scope="col">正式版</th><th scope="col">提交者</th><th scope="col">题目数量</th><th scope="col">提交时间</th></tr></thead><tbody>{revisions.map(row => {
                  const added = row.added_count || 0, changed = row.changed_count ?? added, canSelect = !!(row.has_revision_questions ?? row.has_incremental_json) && changed > 0, checked = selectedRevisions.includes(row.revision);
                  const displayRevision = String(row.revision);
                  return <tr key={row.revision} className={!canSelect ? 'unavailable' : ''}><td><input type="checkbox" checked={checked} disabled={busy || !canSelect} aria-label={`选择修订 ${displayRevision}`} onChange={() => setSelectedRevisions(current => checked ? current.filter(value => value !== row.revision) : [...current, row.revision])}/></td><td>修订 {displayRevision} · {row.release_version_label || `v${row.release_version}`}</td><td>{displayUploader(row.uploader_real_name,row.uploader_nickname)}</td><td>{changed.toLocaleString()} 题</td><td>{new Date(row.updated_at).toLocaleString()}</td></tr>;
                })}</tbody></table></div>
                <p className="question-export-range-note">可多选有题目变更的修订；导出时从最新正式题库读取对应题目，已删除题目会自动跳过，回退也会生成独立修订记录。</p>
              </>}
            </div> : <div className="question-export-range">
              <div className="question-export-range-toolbar">
                <span>按录入时间筛选</span>
                <div aria-label="快捷时间范围">{[[1, '今天'], [7, '近 7 天'], [30, '近 30 天']].map(([days, label]) =>
                  <button type="button" key={days} disabled={busy} onClick={() => setRecentRange(Number(days))}>{label}</button>)}</div>
              </div>
              <div className="question-export-date-fields">
                <DateTimePicker label="开始时间" value={start} disabled={busy} onChange={value => {setStart(value); setValidation('');}}/>
                <ArrowRight className="question-export-range-arrow" aria-hidden="true"/>
                <DateTimePicker label="结束时间" value={end} disabled={busy} onChange={value => {setEnd(value); setValidation('');}}/>
              </div>
              <p className="question-export-range-note">包含起止分钟；没有录入时间的题目不计入此范围。</p>
            </div>}
          </div>
          {validation && <p className="question-export-error" role="alert">{validation}</p>}
        </div>
        <footer className="question-export-footer">
          <span><FileText aria-hidden="true"/>Word 文档 <b>.docx</b></span>
          <div><button disabled={busy} onClick={onClose}>取消</button>
            <button ref={continueButton} className="primary" disabled={busy || !banks.length} onClick={reviewExport}><Download aria-hidden="true"/>{busy ? '正在导出…' : '继续'}</button></div>
        </footer>
      </div>
      {confirming && <div className="question-export-confirm-layer">
        <section className="question-export-confirm" role="alertdialog" aria-modal="true" aria-labelledby="question-export-confirm-title" aria-describedby="question-export-confirm-copy">
          <h3 id="question-export-confirm-title">是否导出此题库？</h3>
          <p id="question-export-confirm-copy">当前题库：<b>{selected?.name}</b><br/>{scope === 'all'
            ? `全部导出，共 ${selected?.count.toLocaleString()} 题。`
            : scope === 'revision'
              ? `已选择 ${selectedRevisions.length} 个修订，共 ${selectedRevisionCount.toLocaleString()} 题。`
              : `录入时间：${start.date} ${start.time} 至 ${end.date} ${end.time}。`}<br/>仅包含题目、选项、答案与解析。</p>
          <div className="question-export-confirm-actions"><button ref={cancelConfirmation} disabled={busy} onClick={cancelReview}>取消</button><button className="primary" disabled={busy} onClick={confirmExport}>确认导出</button></div>
        </section>
      </div>}
    </section>
  </div>;
}
