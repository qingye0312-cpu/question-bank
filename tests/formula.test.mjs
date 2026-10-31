import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseFormula, splitFormulaText} from '../desktop/src/formula.ts';
import {FormulaText} from '../desktop/src/formula.ts';

test('formula delimiters keep ordinary text and currency intact', () => {
  assert.deepEqual(splitFormulaText('普通题干与 $x^2$，价格 $5$'), [
    {kind: 'text', text: '普通题干与 '},
    {kind: 'formula', source: 'x^2', display: false},
    {kind: 'text', text: '，价格 $5$'},
  ]);
  assert.deepEqual(splitFormulaText(String.raw`向量 \(\alpha_i\) 与 $$\frac{a}{b}$$`), [
    {kind: 'text', text: '向量 '},
    {kind: 'formula', source: String.raw`\alpha_i`, display: false},
    {kind: 'text', text: ' 与 '},
    {kind: 'formula', source: String.raw`\frac{a}{b}`, display: true},
  ]);
});

test('common TeX structures become MathML nodes', () => {
  const tree = parseFormula(String.raw`\frac{a^2+b_1}{\sqrt{x}}+\alpha\leq\beta`);
  const json = JSON.stringify(tree);
  assert.match(json, /"tag":"mfrac"/);
  assert.match(json, /"tag":"msup"/);
  assert.match(json, /"tag":"msub"/);
  assert.match(json, /"tag":"msqrt"/);
  assert.match(json, /α/);
  assert.match(json, /≤/);
});

test('matrix environments and unsupported commands remain visible', () => {
  const matrix = parseFormula(String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`);
  assert.match(JSON.stringify(matrix), /"tag":"mtable"/);
  const unsupported = parseFormula(String.raw`\unknown{x}`);
  assert.match(JSON.stringify(unsupported), /\\unknown/);
});

test('the React display layer emits local MathML for an actual question string', () => {
  const html = renderToStaticMarkup(createElement(FormulaText, {text: String.raw`计算 $x^2+\frac{a}{b}$ 与 $$\sqrt{x_1}$$`}));
  assert.ok(html.includes('data-formula="x^2+\\frac{a}{b}"'));
  assert.match(html, /<msup>/);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<msqrt>/);
});

