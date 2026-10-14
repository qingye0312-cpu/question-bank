import {memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {matchRanges, queryTerms, searchSnippet} from './search-presentation';
import type {SnippetLine} from './search-presentation';
import type {Hit, Results} from './types';

export function SearchMark({text, query}: {text: string; query: string}) {
  const ranges = useMemo(() => matchRanges(text, queryTerms(query)), [text, query]);
  return <>{ranges.map((range, i) => <span key={`${range.start}:${range.end}`}>{text.slice(i ? ranges[i - 1].end : 0, range.start)}<mark data-term={range.termIndex % 12} title={`搜索词：${range.term}`}>{text.slice(range.start, range.end)}</mark></span>)}{text.slice(ranges.length ? ranges[ranges.length - 1].end : 0)}</>;
}

const SpeedQuestion = memo(function SpeedQuestion({question, query, line}: {question: Hit['question']; query: string; line: SnippetLine}) {
  const snippet = useMemo(() => searchSnippet(question, query, line), [question, query, line]);
  const scrollable = queryTerms(query).length > 1 && line.width > 0 && line.measure(snippet) > line.width;
  return <span className="speed-question" data-scrollable={scrollable || undefined} tabIndex={scrollable ? 0 : undefined} role="cell" title={snippet}><SearchMark text={snippet} query={query}/></span>;
});

export function answerText(q: Hit['question']) {
  return q.answer === null ? '待核对' : typeof q.answer === 'boolean' ? (q.answer ? '正确' : '错误') : q.answer.join(' · ') || '待核对';
}

type Props = {
  bankId: string;
  query: string;
  revision: number;
  fontScale: number;
  onResults: (results: Results) => void;
};

export function SpeedResults({bankId, query, revision, fontScale, onResults}: Props) {
  const [items, setItems] = useState<Hit[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [lineMetrics, setLineMetrics] = useState({width: 0, font: ''});
  const viewport = useRef<HTMLDivElement>(null);
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const onResultsRef = useRef(onResults);
  onResultsRef.current = onResults;
  const rowHeight = Math.ceil(42 * fontScale);

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

  const fetchPage = useCallback(async (offset: number, requestEpoch: number) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError('');
    try {
      const result = await invoke<Results>('search', {query: {text: query, bank_id: bankId, kind: '', trash: false, offset}});
      if (requestEpoch !== epoch.current) return;
      setItems(previous => offset === 0 ? result.items : previous.concat(result.items));
      setMore(result.has_more);
      onResultsRef.current(result);
    } catch (e) {
      if (requestEpoch === epoch.current) {
        setError(String(e));
        setMore(false);
      }
    } finally {
      if (requestEpoch === epoch.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [bankId, query]);

  useEffect(() => {
    const current = ++epoch.current;
    inFlight.current = false;
    setItems([]);
    setMore(false);
    setScrollTop(0);
    viewport.current?.scrollTo(0, 0);
    void fetchPage(0, current);
    return () => { epoch.current++; };
  }, [fetchPage, revision]);

  useEffect(() => {
    if (more && !loading && !error && scrollTop + viewportHeight >= (items.length - 10) * rowHeight) {
      void fetchPage(items.length, epoch.current);
    }
  }, [more, loading, error, items.length, scrollTop, viewportHeight, rowHeight, fetchPage]);

  // A bounded DOM keeps long sessions fast; rows are fetched only as needed.
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 6);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + 6);
  return <div className="speed-viewport" ref={viewport} onScroll={event => setScrollTop(event.currentTarget.scrollTop)} aria-label="极速搜索结果，可连续向下滚动" aria-busy={loading} tabIndex={0}>
    <div className="speed-rows" role="table" aria-label="题目与答案" aria-rowcount={more ? -1 : items.length} style={{height: items.length * rowHeight}}>
      {items.slice(start, end).map((hit, index) => {
        return <div className="speed-row" role="row" aria-rowindex={start + index + 1} key={hit.rowid} style={{top: (start + index) * rowHeight, height: rowHeight}}>
          <SpeedQuestion question={hit.question} query={query} line={line}/>
          <span className="speed-answer" role="cell">{answerText(hit.question)}</span>
        </div>;
      })}
    </div>
    {error ? <div className="speed-message" role="alert">{error}<button onClick={() => void fetchPage(items.length, epoch.current)}>重试</button></div>
      : loading ? <div className="speed-message" role="status">正在检索…</div>
      : !items.length ? <div className="speed-message">没有找到题目</div> : null}
  </div>;
}
