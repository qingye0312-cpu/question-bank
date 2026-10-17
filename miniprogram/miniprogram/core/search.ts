// Pure logic shared by the build tool, tests and the WeChat runtime.
export type Question = {
  schema_version: string; question_id: string; base_revision: number;
  type: 'single' | 'multiple' | 'true_false'; stem: string;
  options: { key: string; content: string; option_id: string }[];
  answer: string[] | boolean | null; bank: string; external_id: string;
  chapter: string; tags: string[]; explanation: string;
  status: string; [key: string]: unknown;
};
export type SearchIndex = {
  schema_version: 'qbank-index-1'; release_id: string; question_count: number;
  postings: Record<string, string>;
};
export type Segment = { text: string; color: number };
export const normalize = (text: string): string => Array.from(text.normalize('NFKC'), c => c.toLowerCase()).join('');

export function queryTerms(query: string): string[] {
  if (Array.from(query).length > 300) throw new Error('搜索内容不能超过 300 字');
  const terms: string[] = [];
  let word = '', quoted = false;
  for (const c of normalize(query)) {
    if (c === '"') quoted = !quoted;
    else if (/\s/.test(c) && !quoted) {
      if (word) terms.push(word);
      word = '';
    } else word += c;
  }
  if (word) terms.push(word);
  if (terms.length > 12) throw new Error('最多同时搜索 12 个词，请减少关键词');
  return [...new Set(terms)];
}

export function searchText(q: Question): string {
  return normalize([q.stem, q.options.map(o => o.content).join('\n'), q.tags.join(' '),
    q.external_id, q.question_id, q.chapter].join('\n'));
}

export function tokens(text: string): string[] {
  const chars = Array.from(text), result = new Set(chars);
  for (let i = 1; i < chars.length; i++) result.add(chars[i - 1] + chars[i]);
  return [...result];
}

export function encodePosting(ids: number[]): string {
  let previous = -1;
  return ids.map(id => { const delta = id - previous; previous = id; return delta.toString(36); }).join('.');
}

export function decodePosting(value: string): number[] {
  let previous = -1;
  return value.split('.').map(part => { previous += parseInt(part, 36); return previous; });
}

export function buildPostings(questions: Question[]): Record<string, string> {
  const postings: Record<string, number[]> = Object.create(null);
  questions.forEach((q, id) => {
    for (const token of tokens(searchText(q))) {
      if (!postings[token]) postings[token] = [];
      postings[token].push(id);
    }
  });
  const encoded: Record<string, string> = Object.create(null);
  for (const token of Object.keys(postings).sort()) encoded[token] = encodePosting(postings[token]);
  return encoded;
}

// Yield between batches so the loading screen remains responsive on phones.
export async function buildPostingsFromLines(lines: string[]): Promise<Record<string, string>> {
  const postings: Record<string, number[]> = Object.create(null);
  for (let start = 0; start < lines.length; start += 32) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    for (let id = start; id < Math.min(start + 32, lines.length); id++) {
      for (const token of tokens(searchText(JSON.parse(lines[id]) as Question))) {
        if (!postings[token]) postings[token] = [];
        postings[token].push(id);
      }
    }
  }
  const encoded: Record<string, string> = Object.create(null);
  const keys = Object.keys(postings).sort();
  for (let start = 0; start < keys.length; start += 512) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    for (const token of keys.slice(start, start + 512)) encoded[token] = encodePosting(postings[token]);
  }
  return encoded;
}

function intersect(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(a[i]); i++; j++; }
    else if (a[i] < b[j]) i++;
    else j++;
  }
  return out;
}

export class LocalBank {
  private cache = new Map<number, Question>();
  private generation = 0;
  private lines: string[];
  private index: SearchIndex;
  constructor(lines: string[], index: SearchIndex) {
    this.lines = lines; this.index = index;
    if (lines.length !== index.question_count) throw new Error('题库数量与索引不一致，请重新编译题库');
  }
  question(id: number): Question {
    if (!Number.isInteger(id) || id < 0 || id >= this.lines.length) throw new Error('题目不存在');
    let q = this.cache.get(id);
    if (!q) {
      q = JSON.parse(this.lines[id]) as Question;
      if (this.cache.size >= 80) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(id, q);
    }
    return q;
  }
  fork(): LocalBank {return new LocalBank(this.lines.slice(),{...this.index,postings:{...this.index.postings}});}
  cancel(): void { this.generation++; }
  get count(): number { return this.lines.length; }
  append(questions: Question[]): void {
    this.cancel();
    for (const q of questions) {
      const id=this.lines.length;
      this.lines.push(JSON.stringify(q));
      for(const token of tokens(searchText(q))) {
        const previous=this.index.postings[token];
        const ids=previous?decodePosting(previous):[];ids.push(id);
        this.index.postings[token]=encodePosting(ids);
      }
    }
    this.index.question_count=this.lines.length;
  }
  async search(query: string): Promise<number[] | null> {
    const generation = ++this.generation, terms = queryTerms(query);
    if (!terms.length) return this.lines.map((_, id) => id);
    // Select the rarest postings before checking complete substrings.
    const lists: number[][] = [];
    for (const token of new Set(terms.flatMap(tokens))) {
      if (!Object.prototype.hasOwnProperty.call(this.index.postings, token)) return [];
      lists.push(decodePosting(this.index.postings[token]));
    }
    lists.sort((a, b) => a.length - b.length);
    let candidates = lists[0];
    for (const list of lists.slice(1)) {
      candidates = intersect(candidates, list);
      if (!candidates.length) return [];
    }
    const matches: number[] = [];
    for (let offset = 0; offset < candidates.length; offset += 48) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (generation !== this.generation) return null;
      for (const id of candidates.slice(offset, offset + 48)) {
        const text = searchText(this.question(id));
        if (terms.every(term => text.includes(term))) matches.push(id);
      }
    }
    return generation === this.generation ? matches : null;
  }
}

// Keep original Unicode spans without requiring Intl.Segmenter on phones.
function clusters(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let offset = 0;
  for (const c of text) {
    const last = out[out.length - 1];
    const attach = last && (/\p{M}|[\u200d\ufe00-\ufe0f]|[\u{1f3fb}-\u{1f3ff}]/u.test(c)
      || last.text.endsWith('\u200d')
      || (last.text + c).normalize('NFC') !== last.text.normalize('NFC') + c.normalize('NFC'));
    if (attach) { last.text += c; last.end += c.length; }
    else out.push({ text: c, start: offset, end: offset + c.length });
    offset += c.length;
  }
  return out;
}

function ranges(text: string, terms: string[]): { start: number; end: number; color: number }[] {
  const starts: number[] = [], ends: number[] = [];
  let normalized = '';
  for (const part of clusters(text)) {
    const value = normalize(part.text);
    normalized += value;
    for (let i = 0; i < value.length; i++) { starts.push(part.start); ends.push(part.end); }
  }
  const matches: { start: number; end: number; color: number }[] = [];
  terms.forEach((term, color) => {
    if (!term) return;
    let at = normalized.indexOf(term);
    while (at >= 0) {
      matches.push({ start: starts[at], end: ends[at + term.length - 1], color });
      at = normalized.indexOf(term, at + term.length);
    }
  });
  return matches.sort((a, b) => a.start - b.start || b.end - a.end || a.color - b.color);
}

export function highlight(text: string, terms: string[]): Segment[] {
  const segments: Segment[] = [];
  let position = 0;
  for (const match of ranges(text, terms)) {
    if (match.start < position) continue;
    if (match.start > position) segments.push({ text: text.slice(position, match.start), color: -1 });
    segments.push({ text: text.slice(match.start, match.end), color: match.color });
    position = match.end;
  }
  if (position < text.length) segments.push({ text: text.slice(position), color: -1 });
  return segments;
}

export function snippet(q: Question, terms: string[]): Segment[] {
  const fields = [q.stem, ...q.options.map(o => `${o.key}. ${o.content}`)];
  for (const [label, value] of [['标签', q.tags.join(' ')], ['章节', q.chapter],
    ['编号', q.external_id], ['ID', q.question_id]]) {
    if (terms.some(t => normalize(value).includes(t))) fields.push(`${label}：${value}`);
  }
  // Preserve spaces inside quoted phrases so highlights use the same text as
  // the search engine. WXML handles presentation whitespace separately.
  const text = fields.join('  ');
  if (!terms.length) {
    const chars = Array.from(q.stem);
    return [{ text: chars.slice(0, 100).join('') + (chars.length > 100 ? '…' : ''), color: -1 }];
  }
  const hits = ranges(text, terms), used = new Set<number>();
  const bounds = clusters(text);
  const windows: { start: number; end: number }[] = [];
  for (const hit of hits) {
    if (used.has(hit.color)) continue;
    used.add(hit.color);
    const left = bounds.findIndex(c => c.end > hit.start);
    let right = left;
    while (right < bounds.length && bounds[right].end < hit.end) right++;
    const start = bounds[Math.max(0, left - 16)].start;
    const end = bounds[Math.min(bounds.length - 1, right + 24)].end;
    const prev = windows[windows.length - 1];
    if (prev && start <= prev.end) prev.end = Math.max(prev.end, end);
    else windows.push({ start, end });
  }
  if (!windows.length) return highlight(text, terms);
  const excerpt = (windows[0].start ? '…' : '')
    + windows.map(w => text.slice(w.start, w.end)).join(' … ')
    + (windows[windows.length - 1].end < text.length ? '…' : '');
  return highlight(excerpt, terms);
}

export function answerText(q: Question): string {
  if (q.answer === null) return '待核对';
  if (typeof q.answer === 'boolean') return q.answer ? '正确' : '错误';
  return q.answer.join('、');
}
export const typeNames = { single: '单选', multiple: '多选', true_false: '判断' };

// Only the viewport and a small buffer are sent to setData.
export class VirtualList {
  private heights: number[];
  private offsets: number[] = [];
  constructor(count: number) { this.heights = Array(count).fill(160); this.rebuild(); }
  private rebuild(): void {
    this.offsets = [0];
    for (const height of this.heights) this.offsets.push(this.offsets[this.offsets.length - 1] + height);
  }
  measure(start: number, heights: number[]): void {
    heights.forEach((height, n) => {
      if (height > 0 && start + n < this.heights.length) this.heights[start + n] = height;
    });
    this.rebuild();
  }
  offset(index: number): number { return this.offsets[index] || 0; }
  at(top: number): number {
    let lo = 0, hi = this.heights.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.offsets[mid + 1] <= top) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, Math.max(0, this.heights.length - 1));
  }
  window(top: number, height: number): { start: number; end: number; before: number; after: number } {
    const start = Math.max(0, this.at(top) - 6);
    const end = Math.min(this.heights.length, this.at(top + height) + 8);
    return { start, end, before: this.offset(start), after: this.offset(this.heights.length) - this.offset(end) };
  }
}
