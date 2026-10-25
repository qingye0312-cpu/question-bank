import {useEffect} from 'react';
import {CheckCircle2, ChevronRight, Search} from 'lucide-react';
import {SearchMark} from './speed-results';
import {useQuestionResults} from './use-question-results';
import {useMeasuredList} from './use-measured-list';
import type {Hit, Results} from './types';

const kinds: Record<string, string> = {single: '单选', multiple: '多选', true_false: '判断', programming: '编程'};
type Props = {
  bankId: string; query: string; kind: string; revision: number;
  fontScale: number; active: Hit | null; keyboardEnabled: boolean;
  onSelect: (hit: Hit) => void;
  onResults: (result: Results, initial: boolean) => void;
};

export function DetailResults({bankId, query, kind, revision, fontScale, active, keyboardEnabled, onSelect, onResults}: Props) {
  const {items, more, loading, error, loadMore} = useQuestionResults({text: query, bank_id: bankId, kind}, revision, onResults);
  const {viewport, start, end, offsets, totalHeight, scrollTop, height, onScroll, scrollToIndex, cancelTarget} = useMeasuredList(items, fontScale, JSON.stringify([bankId, query, kind, revision]));
  useEffect(() => {
    if (more && !loading && !error && scrollTop + height >= offsets[Math.max(0, items.length - 5)]) void loadMore();
  }, [more, loading, error, scrollTop, height, items.length, offsets, loadMore]);
  useEffect(() => {
    if (!keyboardEnabled) return;
    const navigate = (event: KeyboardEvent) => {
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || !items.length) return;
      event.preventDefault();
      const current = items.findIndex(hit => hit.rowid === active?.rowid);
      const index = Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
      onSelect(items[index]);
      scrollToIndex(index);
      if (index >= items.length - 5 && more && !loading && !error) void loadMore();
    };
    window.addEventListener('keydown', navigate);
    return () => window.removeEventListener('keydown', navigate);
  }, [keyboardEnabled, items, active, onSelect, scrollToIndex, more, loading, error, loadMore]);
  return <section className="results-pane">
    <div className="pane-heading"><b>{query ? '搜索结果' : '题目列表'}</b><span>{loading && !items.length ? '正在检索…' : more ? `已加载 ${items.length} 题` : `共 ${items.length} 题`}</span></div>
    <div className="results-list" ref={viewport} onScroll={onScroll} onWheel={cancelTarget} onPointerDown={cancelTarget} aria-label="题目列表，可连续向下滚动" aria-busy={loading} tabIndex={0}>
      <div className="detail-result-rows" role="list" style={{height: totalHeight}}>
        {items.slice(start, end).map((hit, index) => <div className="detail-result-row" key={hit.rowid} data-measured-row={hit.rowid} role="listitem" aria-posinset={start + index + 1} aria-setsize={more ? -1 : items.length} style={{top: offsets[start + index]}}>
          <button className={`result ${active?.rowid === hit.rowid ? 'active' : ''}`} aria-pressed={active?.rowid === hit.rowid} onClick={() => onSelect(hit)}>
            <div className="result-meta"><span className={`type-badge ${hit.question.type}`}>{kinds[hit.question.type]}</span><span>{hit.question.external_id || hit.question.question_id.slice(0, 8)}</span><ChevronRight size={13}/></div>
            <div className="result-stem"><SearchMark text={hit.question.stem} query={query}/></div>
            <div className="result-bottom"><span>{hit.bank_name}{hit.layer==='draft'?' · 本地新题':''}</span>{hit.question.status === 'verified' && <CheckCircle2 size={13}/>}</div>
          </button>
        </div>)}
      </div>
      {error ? <div className="results-message" role="alert">{error}<button onClick={() => void loadMore()}>重试</button></div>
        : loading ? <div className="results-message" role="status">{items.length ? '正在加载更多…' : '正在检索…'}</div>
        : !items.length ? <div className="empty"><Search size={35}/><b>没有找到题目</b><p>试试更短的关键词，或调整题型筛选。</p></div>
        : !more ? <div className="results-message">已显示全部 {items.length} 道题目</div> : null}
    </div>
  </section>;
}
