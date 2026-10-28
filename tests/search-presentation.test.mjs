import test from 'node:test';
import assert from 'node:assert/strict';
import {matchRange, matchRanges, queryTerms, searchSnippet} from '../desktop/src/search-presentation.ts';

const question = {
  stem: '关于页面导航，下列描述正确的是？',
  options: [{key: 'A', content: '使用 Navigation 组件'}, {key: 'B', content: '只有 Stack 模式'}],
  explanation: '支持多种显示模式', tags: ['布局'], chapter: '开发基础',
  external_id: 'S134', question_id: 'sample-id',
};

test('a stem hit starts at the actual match and retains following choices', () => {
  const result = searchSnippet(question, '页面', {width: 20, measure: s => s.length});
  assert.ok(result.startsWith('页面导航，下列描述正确的是？'));
  assert.ok(result.includes('A. 使用 Navigation 组件'));
  assert.ok(!result.startsWith('关于'));
});

test('option, tag, chapter and ID hits never cycle back to the stem', () => {
  for (const [query, start] of [['navigation', 'Navigation 组件'], ['布局', '布局'], ['开发', '开发基础'], ['S134', 'S134'], ['sample', 'sample-id']]) {
    const result = searchSnippet(question, query, {width: 1, measure: s => s.length});
    assert.ok(result.startsWith(start), query);
    assert.ok(!result.includes(question.stem), query);
  }
});

test('explanations never contribute to search snippets or their highlighted matches', () => {
  for (const query of ['', '显示', '页面', 'Navigation 显示']) {
    const result = searchSnippet(question, query);
    assert.ok(!result.includes(question.explanation));
    assert.ok(!result.includes('显示'));
    assert.ok(!result.includes('解析：'));
  }
});

test('Unicode compatibility expansion and combining marks map to original glyphs', () => {
  for (const [text, query, expected] of [['设置ＡＰＩ参数', 'api', 'ＡＰＩ'], ['处理ﬃ字符', 'ffi', 'ﬃ'], ['编号⑴题', '(1)', '⑴'], ['Cafe\u0301 模式', 'café', 'Cafe\u0301']]) {
    const range = matchRange(text, queryTerms(query));
    assert.ok(range);
    assert.equal(text.slice(...range), expected);
  }
});

test('quoted phrases and earliest matching term use search-engine semantics', () => {
  assert.deepEqual(queryTerms('中文 "Navigation 组件"　ＡＰＩ'), ['中文', 'navigation 组件', 'api']);
  const value = '组件 alpha 后接 beta';
  assert.deepEqual(matchRange(value, queryTerms('beta alpha')), [3, 8]);
  assert.equal(matchRange(value, queryTerms('"alpha beta"')), null);
});

test('blank search keeps the full question and never introduces multiline rows', () => {
  const value = searchSnippet({...question, stem: '第一行\n第二行'}, '');
  assert.ok(value.startsWith('第一行 第二行'));
  assert.ok(!/[\r\n\t]/.test(value));
  assert.ok(!value.includes('sample-id'));
  assert.ok(!value.includes('标签：'));
});

test('a short tail restores the full question instead of showing only its last character', () => {
  const q = {...question, stem: 'ArkTS中使用const声明常量。', options: [], explanation: ''};
  assert.equal(searchSnippet(q, '量', {width: 100, measure: s => s.length}), q.stem);
});

test('long tails still start at the hit; short tails backfill to the measured line width', () => {
  const q = {...question, stem: '0123456789命中。', options: [], explanation: ''};
  const line = {width: 8, measure: s => s.length};
  assert.equal(searchSnippet(q, '命中', line), '…6789命中。');
  assert.equal(searchSnippet(q, '345', line), '3456789命中。');
  assert.equal(searchSnippet(q, '命中', {...line, width: 5}), '…9命中。');
  assert.equal(searchSnippet(q, '命中', {...line, width: 8, measure: s => s.length * 2}), '命中。');
});

test('backfilling never cuts inside a combining sequence or an emoji', () => {
  const q = {...question, stem: 'abcdefCafe\u0301👨‍👩‍👧量。', options: [], explanation: ''};
  const measure = s => [...new Intl.Segmenter('zh', {granularity: 'grapheme'}).segment(s)].length;
  assert.equal(searchSnippet(q, '量', {width: 5, measure}), '…e\u0301👨‍👩‍👧量。');
});

test('all occurrences have stable, distinct query-term colors across fields', () => {
  const terms = queryTerms('const 量 CONST');
  const ranges = matchRanges('const声明常量，CONST仍是常量', terms);
  assert.deepEqual(ranges.map(r => r.termIndex), [0, 1, 0, 1]);
  assert.deepEqual(ranges.map(r => r.term), ['const', '量', 'const', '量']);
  assert.equal(matchRanges('变量', terms)[0].termIndex, 1);
});

test('multi-term highlights preserve Unicode and prefer longer overlapping terms', () => {
  const value = 'ＡＰＩ Cafe\u0301 Navigation API';
  const ranges = matchRanges(value, queryTerms('api café Nav Navigation'));
  assert.deepEqual(ranges.map(r => [value.slice(r.start, r.end), r.termIndex]), [
    ['ＡＰＩ', 0], ['Cafe\u0301', 1], ['Navigation', 3], ['API', 0],
  ]);
  const phrase = 'Navigation 组件与普通组件';
  assert.deepEqual(matchRanges(phrase, queryTerms('"Navigation 组件" 组件')).map(r => [phrase.slice(r.start, r.end), r.termIndex]), [['Navigation 组件', 0], ['组件', 1]]);
});
