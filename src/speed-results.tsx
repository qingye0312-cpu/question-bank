import {memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {PointerEvent} from 'react';
import {Check} from 'lucide-react';
import {QuestionPreview} from './question-preview';
import type {PreviewAnchor} from './question-preview';
import {useQuestionResults} from './use-question-results';
import {matchRanges, queryTerms, searchSnippet} from './search-presentation';
import type {SnippetLine} from './search-presentation';
import type {Hit, Results} from './types';

export function SearchMark({text, query}: {text: string; query: string}) {
  const ranges = useMemo(() => matchRanges(text, queryTerms(query)), [text, query]);
  return <>{ranges.map((range, i) => <span key={`${range.start}:${range.end}`}>{text.slice(i ? ranges[i - 1].end : 0, range.start)}<mark data-term={range.termIndex % 12} title={`搜索词：${range.term}`}>{text.slice(range.start, range.end)}</mark></span>)}{text.slice(ranges.length ? ranges[ranges.length - 1].end : 0)}</>;
}

const SpeedQuestion = memo(function SpeedQuestion({question, query, line, previewEnabled}: {question: Hit['question']; query: string; line: SnippetLine; previewEnabled: boolean}) {
  const snippet = useMemo(() => searchSnippet(question, query, line), [question, query, line]);
  const scrollable = queryTerms(query).length > 1 && line.width > 0 && line.measure(snippet) > line.width;
  return <span className="speed-question" data-scrollable={scrollable || undefined} tabIndex={scrollable ? 0 : undefined} role="cell" title={previewEnabled ? undefined : snippet}><SearchMark text={snippet} query={query}/></span>;
});

export function answerText(q: Hit['question']) {
  if (q.type === 'programming') return '暂无标准答案';
  return q.answer === null ? '待核对' : typeof q.answer === 'boolean' ? (q.answer ? '正确' : '错误') : q.answer.join(' · ') || '待核对';
}

type Props = {
  bankId: string;
  query: string;
  revision: number;
  fontScale: number;
  previewEnabled: boolean;
  onResults: (results: Results) => void;
};

export function SpeedResults({bankId, query, revision, fontScale, previewEnabled, onResults}: Props) {
  const {items, more, loading, error, loadMore} = useQuestionResults({text: query, bank_id: bankId, kind: ''}, revision, onResults);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [lineMetrics, setLineMetrics] = useState({width: 0, font: ''});
  const viewport = useRef<HTMLDivElement>(null);
  const pointer = useRef<{x: number; y: number} | null>(null);
  const [preview, setPreview] = useState<{hit: Hit; anchor: PreviewAnchor} | null>(null);
  const previewId = useId();
  const rowHeight = Math.ceil(42 * fontScale);

  const openPreview = useCallback((hit: Hit, row: HTMLElement, point: {x: number; y: number}) => {
    if (!previewEnabled) return;
    const {top, bottom} = row.getBoundingClientRect();
    setPreview(previous => previous?.hit === hit && previous.anchor.top === top && previous.anchor.bottom === bottom
      ? previous : {hit, anchor: {...point, top, bottom}});
  }, [previewEnabled]);
  const previewAt = useCallback((target: Element | null, point: {x: number; y: number}) => {
    const row = target?.closest<HTMLElement>('.speed-row');
    const hit = row && viewport.current?.contains(row) ? items[Number(row.dataset.resultIndex)] : undefined;
    if (row && hit) openPreview(hit, row, point);
    else setPreview(null);
  }, [items, openPreview]);
  const trackPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!previewEnabled || event.pointerType === 'touch') return;
    const point = {x: event.clientX, y: event.clientY};
    pointer.current = point;
    previewAt(event.target instanceof Element ? event.target : null, point);
  };

  useLayoutEffect(() => {
    setPreview(null);
    pointer.current = null;
  }, [previewEnabled, bankId, query, revision]);
  useLayoutEffect(() => {
    const point = pointer.current;
    // Wheel scrolling can put a new row under a stationary pointer. Resolve it
    // after the virtual rows move, rather than leaving the old question open.
    if (previewEnabled && point) previewAt(document.elementFromPoint(point.x, point.y), point);
  }, [scrollTop, previewAt, previewEnabled, fontScale]);
  useEffect(() => {
    const close = () => { setPreview(null); pointer.current = null; };
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const visibility = () => { if (document.hidden) close(); };
    window.addEventListener('blur', close);
    window.addEventListener('keydown', keydown);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', keydown);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  const measureViewport = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    setViewportHeight(element.clientHeight);
    const cell = element.querySelector<HTMLElement>('.speed-question');
    if (cell) {
      const style = getComputedStyle(cell);
      const width = Math.max(0, cell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2);
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      setLineMetrics(previous => previous.width === width && previous.font === font ? previous : {width, font});
    }
  }, []);
  const line = useMemo<SnippetLine>(() => {
    const context = document.createElement('canvas').getContext('2d');
    if (!context || !lineMetrics.font) return {width: 0, measure: () => 0};
    context.font = lineMetrics.font;
    return {width: lineMetrics.width, measure: text => context.measureText(text).width};
  }, [lineMetrics]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(measureViewport);
    observer.observe(element);
    measureViewport();
    return () => observer.disconnect();
  }, [measureViewport]);
  useLayoutEffect(() => {
    measureViewport();
    // Appearance is applied to :root by the parent effect. Re-read after it so
    // changing font size without changing viewport dimensions refits the line.
    const frame = requestAnimationFrame(measureViewport);
    return () => cancelAnimationFrame(frame);
  }, [measureViewport, fontScale, items.length]);

  useLayoutEffect(() => {
    setScrollTop(0);
    viewport.current?.scrollTo(0, 0);
  }, [bankId, query, revision]);

  useEffect(() => {
    if (more && !loading && !error && scrollTop + viewportHeight >= (items.length - 10) * rowHeight) void loadMore();
  }, [more, loading, error, items.length, scrollTop, viewportHeight, rowHeight, loadMore]);

  // A bounded DOM keeps long sessions fast; rows are fetched only as needed.
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 6);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + 6);
  const question = preview?.hit.question;
  return <><div className="speed-viewport" ref={viewport} onScroll={event => setScrollTop(event.currentTarget.scrollTop)} onPointerOver={trackPointer} onPointerMove={trackPointer} onPointerLeave={() => { pointer.current = null; setPreview(null); }} aria-label="极速搜索结果，可连续向下滚动" aria-busy={loading} tabIndex={0}>
    <div className="speed-rows" role="table" aria-label="题目与答案" aria-rowcount={more ? -1 : items.length} style={{height: items.length * rowHeight}}>
      {items.slice(start, end).map((hit, index) => {
        const isPreview = previewEnabled && preview?.hit.rowid === hit.rowid;
        return <div className="speed-row" role="row" aria-rowindex={start + index + 1} key={hit.rowid} data-result-index={start + index} data-preview={isPreview || undefined} aria-describedby={isPreview ? previewId : undefined} tabIndex={previewEnabled ? 0 : undefined} onFocus={event => { const row = event.currentTarget, rect = row.getBoundingClientRect(); openPreview(hit, row, {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2}); }} onBlur={() => setPreview(null)} style={{top: (start + index) * rowHeight, height: rowHeight}}>
          <SpeedQuestion question={hit.question} query={query} line={line} previewEnabled={previewEnabled}/>
          <span className="speed-answer" role="cell">{answerText(hit.question)}{hit.layer==='draft'&&<small className="pending-label">本地新题</small>}</span>
        </div>;
      })}
    </div>
    {error ? <div className="speed-message" role="alert">{error}<button onClick={() => void loadMore()}>重试</button></div>
      : loading ? <div className="speed-message" role="status">正在检索…</div>
      : !items.length ? <div className="speed-message">没有找到题目</div> : null}
  </div>
    {previewEnabled && preview && question && <QuestionPreview id={previewId} anchor={preview.anchor} fontScale={fontScale}>
      <div className="question-preview-heading"><span>题目预览</span><span className={`type-badge ${question.type}`}>{({single: '单选', multiple: '多选', true_false: '判断', programming: '编程'} as Record<string, string>)[question.type]}</span>{question.external_id && <span>{question.external_id}</span>}</div>
      <h2 className="question-preview-stem"><SearchMark text={question.stem} query={query}/></h2>
      {question.options.length > 0 && <div className="question-preview-options">{question.options.map(option => {
        const correct = Array.isArray(question.answer) && question.answer.includes(option.key);
        return <div key={option.key} className={`question-preview-option ${correct ? 'correct' : ''}`}><span className="question-preview-key">{option.key}</span><p><SearchMark text={option.content} query={query}/></p>{correct && <Check size={16} aria-label="正确选项"/>}</div>;
      })}</div>}
      <div className="question-preview-answer"><span>参考答案</span><strong>{answerText(question)}</strong></div>
      {question.explanation && <div className="question-preview-explanation"><span>解析</span><p>{question.explanation}</p></div>}
    </QuestionPreview>}
  </>;
}
