type SearchableQuestion = {
  stem: string;
  options: {key: string; content: string}[];
  explanation: string;
  tags: string[];
  chapter: string;
  external_id: string;
  question_id: string;
};

// Keep normalization and quoted terms consistent with the Rust search engine.
export const normalize = (text: string) => Array.from(text.normalize('NFKC'), c => c.toLowerCase()).join('');

export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  let word = '', quoted = false;
  for (const c of normalize(query)) {
    if (c === '"') quoted = !quoted;
    else if (/\s/u.test(c) && !quoted) {
      if (word) terms.push(word);
      word = '';
    } else word += c;
  }
  if (word) terms.push(word);
  return terms;
}

const segmenter = new Intl.Segmenter('zh', {granularity: 'grapheme'});

function normalizedText(text: string) {
  const value = normalize(text);
  let starts: number[] | undefined, ends: number[] | undefined;
  const direct = text.normalize('NFKC') === text && value.length === text.length
    && !/[\p{M}\u200d\p{Extended_Pictographic}]/u.test(text);
  function rawRange(start: number, end: number): [number, number] {
    if (direct) return [start, end];
    if (!starts || !ends) {
      starts = []; ends = [];
      for (const {segment, index} of segmenter.segment(text)) {
        for (let n = 0; n < normalize(segment).length; n++) {
          starts.push(index); ends.push(index + segment.length);
        }
      }
    }
    return [starts[start], ends[end - 1]];
  }
  return {value, rawRange};
}

export function matchRange(text: string, terms: string[]): [number, number] | null {
  if (!terms.length) return null;
  const normalized = normalizedText(text);
  let start = Infinity, length = 0;
  for (const term of terms) {
    const at = normalized.value.indexOf(term);
    if (term && at >= 0 && (at < start || (at === start && term.length > length))) {
      start = at;
      length = term.length;
    }
  }
  if (!Number.isFinite(start)) return null;
  return normalized.rawRange(start, start + length);
}

export type SearchMatch = {start: number; end: number; termIndex: number; term: string};

export function matchRanges(text: string, terms: string[]): SearchMatch[] {
  if (!terms.length) return [];
  const normalized = normalizedText(text), matches: SearchMatch[] = [];
  // Stable query-order colors, including when a term repeats in another field.
  [...new Set(terms.filter(Boolean))].forEach((term, termIndex) => {
    let at = normalized.value.indexOf(term);
    while (at >= 0) {
      const [start, end] = normalized.rawRange(at, at + term.length);
      matches.push({start, end, termIndex, term});
      at = normalized.value.indexOf(term, at + term.length);
    }
  });
  // For overlapping terms use the leftmost, longest occurrence; never split a
  // compatibility glyph or combining sequence into multiple colored pieces.
  matches.sort((a, b) => a.start - b.start || b.end - a.end || b.term.length - a.term.length || a.termIndex - b.termIndex);
  const visible: SearchMatch[] = [];
  for (const match of matches) {
    if (!visible.length || match.start >= visible[visible.length - 1].end) visible.push(match);
  }
  return visible;
}

export type SnippetLine = {width: number; measure: (text: string) => number};

const fallbackLine: SnippetLine = {width: 80, measure: text => Array.from(text).length};

function fillLine(prefix: string, suffix: string, line?: SnippetLine): string {
  if (!line || line.width <= 0 || !prefix || line.measure(suffix) >= line.width) return suffix;
  if (line.measure(prefix + suffix) <= line.width) return prefix + suffix;
  if (line.measure('…' + suffix) > line.width) return suffix;
  // The tail is short: find as much preceding context as the actual font and
  // available pixel width allow. Only truncate at grapheme boundaries.
  const boundaries = [...segmenter.segment(prefix)].map(part => part.index).concat(prefix.length);
  let low = 0, high = boundaries.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (line.measure('…' + prefix.slice(boundaries[mid]) + suffix) <= line.width) high = mid;
    else low = mid + 1;
  }
  return boundaries[low] < prefix.length ? '…' + prefix.slice(boundaries[low]) + suffix : suffix;
}

export function searchSnippet(q: SearchableQuestion, query: string, line?: SnippetLine): string {
  // These are the same human-readable fields indexed by Question::search_text.
  const terms = [...new Set(queryTerms(query))];
  const fields = [
    {label: '', text: q.stem, display: true},
    ...q.options.map(o => ({label: `${o.key}. `, text: o.content, display: true})),
    {label: '标签：', text: q.tags.join(' '), display: false},
    {label: '章节：', text: q.chapter, display: false},
    {label: '编号：', text: q.external_id, display: false},
    {label: 'ID：', text: q.question_id, display: false},
  ].filter(f => f.text && (f.display || matchRange(f.text, terms)));
  const text = fields.map(f => f.label + f.text).join(' ').replace(/\s+/gu, ' ');
  const metrics = line && line.width > 0 ? line : fallbackLine;
  const range = matchRange(text, terms);
  if (!range) return text;
  if (terms.length === 1) {
    // Keep original question/option order. If the hit is at the end, backfill
    // preceding context and leave the highlighted word at the end of the row.
    return fillLine(text.slice(0, range[0]), text.slice(range[0]), metrics);
  }
  return joinedMatchContexts(text, terms, metrics);
}

function joinedMatchContexts(text: string, terms: string[], line: SnippetLine): string {
  if (line.measure(text) <= line.width) return text;
  const normalized = normalizedText(text);
  const boundaries = [...segmenter.segment(text)].map(part => part.index).concat(text.length);
  const boundaryIndexes = new Map(boundaries.map((position, index) => [position, index]));
  // Reserve one complete occurrence of every term before allocating context.
  // Merge overlapping occurrences, so terms inside another term stay intact.
  const hits = terms.flatMap(term => {
    const at = normalized.value.indexOf(term);
    if (at < 0) return [];
    const [start, end] = normalized.rawRange(at, at + term.length);
    return [{start: boundaryIndexes.get(start)!, end: boundaryIndexes.get(end)!}];
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  if (!hits.length) return text;
  const length = boundaries.length - 1;
  function render(context: number) {
    const windows: {start: number; end: number}[] = [];
    for (const hit of hits) {
      const start = Math.max(0, hit.start - context), end = Math.min(length, hit.end + context);
      const previous = windows[windows.length - 1];
      if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
      else windows.push({start, end});
    }
    return (windows[0].start ? '…' : '')
      + windows.map(w => text.slice(boundaries[w.start], boundaries[w.end])).join(' … ')
      + (windows[windows.length - 1].end < length ? '…' : '');
  }
  const minimum = render(0);
  // An unusually long set of keywords remains complete; the cell can scroll
  // horizontally instead of hiding the last keywords with CSS ellipsis.
  if (line.measure(minimum) > line.width) return minimum;
  let low = 0, high = 1;
  while (high < length && line.measure(render(high)) <= line.width) {
    low = high;
    high = Math.min(length, high * 2);
  }
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (line.measure(render(middle)) <= line.width) low = middle;
    else high = middle;
  }
  return render(low);
}
