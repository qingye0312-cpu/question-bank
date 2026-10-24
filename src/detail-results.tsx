import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {CheckCircle2, ChevronRight, Search} from 'lucide-react';
import {SearchMark} from './speed-results';
import {useQuestionResults} from './use-question-results';
import type {Hit, Results} from './types';

const kinds: Record<string, string> = {single: '单选', multiple: '多选', true_false: '判断', programming: '编程'};
type Props = {
  bankId: string; query: string; kind: string; trash: boolean; revision: number;
  fontScale: number; active: Hit | null; keyboardEnabled: boolean;
  onSelect: (hit: Hit) => void;
  onResults: (result: Results, initial: boolean) => void;
};

export function DetailResults({bankId, query, kind, trash, revision, fontScale, active, keyboardEnabled, onSelect, onResults}: Props) {
  const {items, more, loading, error, loadMore} = useQuestionResults({text: query, bank_id: bankId, kind, trash}, revision, onResults);
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  // Reserve space for a three-line preview at every supported font size.
  const rowHeight = Math.ceil(151 * fontScale);

  useLayoutEffect(() => {
    setScrollTop(0);
    viewport.current?.scrollTo(0, 0);
  }, [bankId, query, kind, trash, revision]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => setHeight(element.clientHeight);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (more && !loading && !error && scrollTop + height >= Math.max(0, (items.length - 5) * rowHeight)) void loadMore();
  }, [more, loading, error, scrollTop, height, items.length, rowHeight, loadMore]);
  useEffect(() => {
    if (!keyboardEnabled) return;
    const navigate = (event: KeyboardEvent) => {
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || !items.length) return;
      event.preventDefault();
      const current = items.findIndex(hit => hit.rowid === active?.rowid);
      const index = Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
      onSelect(items[index]);
      const element = viewport.current;
      if (element) {
        const top = index * rowHeight, bottom = top + rowHeight;
        if (top < element.scrollTop) element.scrollTop = top;
        else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
      }
      if (index >= items.length - 5 && more && !loading && !error) void loadMore();
    };
    window.addEventListener('keydown', navigate);
    return () => window.removeEventListener('keydown', navigate);
  }, [keyboardEnabled, items, active, onSelect, rowHeight, more, loading, error, loadMore]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 4);
  const end = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + 4);
  return <section className="results-pane">
    <div className="pane-heading"><b>{query ? '搜索结果' : '题目列表'}</b><span>{loading && !items.length ? '正在检索…' : more ? `已加载 ${items.length} 题` : `共 ${items.length} 题`}</span></div>
    <div className="results-list" ref={viewport} onScroll={event => setScrollTop(event.currentTarget.scrollTop)} aria-label="题目列表，可连续向下滚动" aria-busy={loading} tabIndex={0}>
      <div className="detail-result-rows" role="list" style={{height: items.length * rowHeight}}>
        {items.slice(start, end).map((hit, index) => <div className="detail-result-row" key={hit.rowid} role="listitem" aria-posinset={start + index + 1} aria-setsize={more ? -1 : items.length} style={{top: (start + index) * rowHeight, height: rowHeight}}>
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
