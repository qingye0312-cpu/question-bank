const recordedTime=(q:Question):string|null=>q.recorded_at||q.sources?.find(s=>typeof s.recorded_at==='string'&&Number.isFinite(Date.parse(s.recorded_at)))?.recorded_at as string||null;
import type {Question} from './search';

// Mobile read-only projection. Editorial provenance and option UUIDs stay in desktop source.
export type CompactBank = {v: 1|2; release: string; dict: string[]; rows: unknown[][]};
export type CompactBundle = {
  v: 3;
  dict: string[];
  banks: Record<string, {release: string; rows: unknown[][]}>;
};
const types = ['single', 'multiple', 'true_false', 'programming'] as const;
const repeatedDictionary = (banks: Question[][]): string[] => {
  const counts = new Map<string, number>();
  const strings = (q: Question): string[] => [q.chapter, ...q.tags, q.explanation, ...q.options.map(o => o.content)];
  for (const questions of banks) for (const q of questions) for (const s of strings(q)) counts.set(s, (counts.get(s) || 0) + 1);
  return [...counts].filter(([s, n]) => n > 1 && s.length > 3).map(([s]) => s).sort();
};
const encodeRows = (questions: Question[], dict: string[]): unknown[][] => {
  const lookup = new Map(dict.map((s, i) => [s, i]));
  const ref = (s: string): string | number => lookup.has(s) ? lookup.get(s)! : s;
  return questions.map(q => [q.question_id, q.external_id,
    types.indexOf(q.type), q.stem, q.options.map(o => [o.key, ref(o.content)]), q.answer,
    ref(q.chapter), q.tags.map(ref), ref(q.explanation), recordedTime(q), q.recorded_at_source||(recordedTime(q)?'source':'unknown'),q.updated_at||null]);
};
export function encodeCompact(questions: Question[], release: string): CompactBank {
  const dict = repeatedDictionary([questions]);
  return {v: 2, release, dict, rows: encodeRows(questions, dict)};
}
export function encodeCompactBundle(entries: {bankId: string; release: string; questions: Question[]}[]): CompactBundle {
  if (!entries.length || new Set(entries.map(entry => entry.bankId)).size !== entries.length) {
    throw new Error('压缩题库包必须包含至少一个且不重复的题库');
  }
  const dict = repeatedDictionary(entries.map(entry => entry.questions));
  return {v: 3, dict, banks: Object.fromEntries(entries.map(entry => [entry.bankId,
    {release: entry.release, rows: encodeRows(entry.questions, dict)}]))};
}

export function decodeCompact(value: CompactBank, release: string, count: number): string[] {
  if (!value || ![1,2].includes(value.v) || value.release !== release || !Array.isArray(value.dict)
      || !value.dict.every(s => typeof s === 'string') || !Array.isArray(value.rows)
      || value.rows.length !== count) throw new Error('压缩题库资源格式无效或版本不一致');
  const str = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < value.dict.length) return value.dict[v];
    throw new Error('压缩题库字典引用无效');
  };
  return value.rows.map(row => {
    if (!Array.isArray(row) || row.length !== (value.v===2?12:9)) throw new Error('压缩题库记录无效');
    const [id, number, kind, stem, options, answer, chapter, tags, explanation,recorded_at,recorded_at_source,updated_at] = row;
    if (typeof id !== 'string' || typeof number !== 'string' || typeof stem !== 'string'
        || typeof kind !== 'number' || !Number.isInteger(kind) || !types[kind]
        || !Array.isArray(options) || !Array.isArray(tags)) throw new Error('压缩题库字段无效');
    const restored = options.map(o => {
      if (!Array.isArray(o) || o.length !== 2 || typeof o[0] !== 'string') throw new Error('压缩题库选项无效');
      return {key: o[0], content: str(o[1]), option_id: `${id}:${o[0]}`};
    });
    if (answer !== null && (kind === 2 ? typeof answer !== 'boolean'
      : !Array.isArray(answer) || !answer.every(k => restored.some(o => o.key === k)))) throw new Error('压缩题库答案无效');
    if(value.v===2&&((recorded_at!=null&&(typeof recorded_at!=='string'||!Number.isFinite(Date.parse(recorded_at))))||!['local','import','source','unknown'].includes(String(recorded_at_source))||(updated_at!=null&&(typeof updated_at!=='string'||!Number.isFinite(Date.parse(updated_at))))))throw Error('录入时间无效');
    return JSON.stringify({...value.v===2?{recorded_at,recorded_at_source,updated_at}:{},schema_version: value.v===2?'1.1':'1.0', question_id: id, base_revision: 1, type: types[kind],
      stem, options: restored, answer, external_id: number, bank: '', chapter: str(chapter),
      tags: tags.map(str), explanation: str(explanation), status: answer === null ? 'needs_review' : 'unreviewed'});
  });
}

export function decodeCompactBundle(value: CompactBundle, manifests: {bank_id: string; release_id: string; question_count: number}[]): Map<string, string[]> {
  if (!value || value.v !== 3 || !Array.isArray(value.dict) || !value.dict.every(s => typeof s === 'string')
      || !value.banks || typeof value.banks !== 'object') throw new Error('压缩题库包格式无效或版本不一致');
  const decoded = new Map<string, string[]>();
  for (const manifest of manifests) {
    const bank = value.banks[manifest.bank_id];
    if (!bank || bank.release !== manifest.release_id) throw new Error('压缩题库包缺少题库或版本不一致');
    const lines = decodeCompact({v: 2, release: bank.release, dict: value.dict, rows: bank.rows},
      manifest.release_id, manifest.question_count);
    decoded.set(manifest.bank_id, lines);
  }
  if (Object.keys(value.banks).length !== manifests.length) throw new Error('压缩题库包包含未知题库');
  return decoded;
}

export function decodeUtf8(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer), chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    let part = '';
    for (const b of bytes.subarray(offset, offset + 4096)) part += '%' + b.toString(16).padStart(2, '0');
    chunks.push(part);
  }
  return decodeURIComponent(chunks.join(''));
}
