import {createElement, Fragment, type ReactNode} from 'react';
import {matchRanges, queryTerms} from './search-presentation';

/**
 * The question bank stores text, so formulas use the portable TeX delimiters
 * understood by most editors: $...$, $$...$$, \(...\), and \[...\].
 * Rendering is local MathML rather than a remote stylesheet or script so the
 * desktop app keeps working offline.
 */
export type FormulaSegment =
  | {kind: 'text'; text: string}
  | {kind: 'formula'; source: string; display: boolean};

type MathChild = MathNode | string;
export type MathNode = {tag: string; attrs?: Record<string, string>; children: MathChild[]};

const commandMap: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
  upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', emptyset: '∅', varnothing: '∅',
  cdot: '⋅', times: '×', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥',
  neq: '≠', ne: '≠', approx: '≈', sim: '∼', equiv: '≡', propto: '∝', to: '→', rightarrow: '→',
  leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
  mapsto: '↦', in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖', land: '∧', lor: '∨', neg: '¬', ast: '∗', star: '⋆',
  parallel: '∥', perp: '⊥', angle: '∠', degree: '°', deg: '°', prime: '′', dots: '…', ldots: '…',
  cdots: '⋯', vdots: '⋮', ddots: '⋱', langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉',
  lfloor: '⌊', rfloor: '⌋',
};

const operatorCommands = new Set(['lim', 'max', 'min', 'sup', 'inf', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'exp', 'det', 'gcd', 'ker']);
const largeOperators = new Set(['sum', 'prod', 'coprod', 'int', 'iint', 'iiint', 'oint']);
const largeOperatorMap: Record<string, string> = {sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮'};
const escapedSymbols: Record<string, string> = {'{': '{', '}': '}', '[': '[', ']': ']', '(': '(', ')': ')', '%': '%', '$': '$', '#': '#', '&': '&', '_': '_', '^': '^', '|': '|'};
const environmentBrackets: Record<string, [string, string]> = {pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], cases: ['{', '']};

const node = (tag: string, children: MathChild[] = [], attrs?: Record<string, string>): MathNode => ({tag, children, attrs});
const row = (children: MathChild[]): MathNode => children.length === 1 && typeof children[0] !== 'string' ? children[0] as MathNode : node('mrow', children);
const textNode = (tag: string, text: string, attrs?: Record<string, string>): MathNode => node(tag, [text], attrs);

function isEscaped(text: string, index: number) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function findClosing(text: string, start: number, close: string) {
  for (let index = start; index < text.length; index++) {
    if (text.startsWith(close, index) && !isEscaped(text, index)) return index;
  }
  return -1;
}

function looksLikeFormula(source: string) {
  const value = source.trim();
  if (!value || /^\d+(?:[.,]\d+)?$/.test(value)) return false;
  return /\\[A-Za-z]+|[A-Za-z]|[\\^_{}=+*/<>]|[×÷±≤≥≠≈→←∑∫√]/.test(value);
}

/** Split ordinary question text from the supported TeX formula delimiters. */
export function splitFormulaText(text: string): FormulaSegment[] {
  const segments: FormulaSegment[] = [];
  let textStart = 0;
  const pushText = (end: number) => {
    if (end > textStart) segments.push({kind: 'text', text: text.slice(textStart, end)});
  };
  let index = 0;
  while (index < text.length) {
    if (text[index] === '\\' && (text[index + 1] === '(' || text[index + 1] === '[') && !isEscaped(text, index)) {
      const close = text[index + 1] === '(' ? '\\)' : '\\]';
      const end = findClosing(text, index + 2, close);
      const source = end >= 0 ? text.slice(index + 2, end) : '';
      if (end >= 0 && looksLikeFormula(source)) {
        pushText(index);
        segments.push({kind: 'formula', source: source.trim(), display: close === '\\]'});
        index = end + close.length;
        textStart = index;
        continue;
      }
    }
    if (text[index] === '$' && !isEscaped(text, index)) {
      const display = text[index + 1] === '$';
      const openLength = display ? 2 : 1;
      const close = display ? '$$' : '$';
      const end = findClosing(text, index + openLength, close);
      const source = end >= 0 ? text.slice(index + openLength, end) : '';
      if (end >= 0 && looksLikeFormula(source)) {
        pushText(index);
        segments.push({kind: 'formula', source: source.trim(), display});
        index = end + close.length;
        textStart = index;
        continue;
      }
    }
    index++;
  }
  pushText(text.length);
  return segments.length ? segments : [{kind: 'text', text}];
}

class TexParser {
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse() {
    return this.parseExpression();
  }

  private peek(offset = 0) {
    return this.source[this.index + offset] || '';
  }

  private skipWhitespace() {
    while (/\s/.test(this.peek())) this.index++;
  }

  private parseExpression(stop = ''): MathNode {
    const children: MathChild[] = [];
    while (this.index < this.source.length && (!stop || this.peek() !== stop)) {
      if (/\s/.test(this.peek())) {
        this.index++;
        continue;
      }
      const value = this.parseAtomWithScripts();
      if (value) children.push(value);
      else this.index++;
    }
    if (stop && this.peek() === stop) this.index++;
    return row(children);
  }

  private parseAtomWithScripts(): MathNode | null {
    const base = this.parsePrimary();
    if (!base) return null;
    let sub: MathNode | undefined;
    let sup: MathNode | undefined;
    while (this.peek() === '_' || this.peek() === '^') {
      const kind = this.peek();
      this.index++;
      const argument = this.parseArgument();
      if (kind === '_') sub = argument;
      else sup = argument;
    }
    if (sub && sup) return node('msubsup', [base, sub, sup]);
    if (sub) return node('msub', [base, sub]);
    if (sup) return node('msup', [base, sup]);
    return base;
  }

  private parseArgument() {
    this.skipWhitespace();
    if (this.peek() === '{') return this.parseGroup('{', '}');
    if (this.peek() === '[') return this.parseGroup('[', ']');
    return this.parsePrimary() || textNode('mtext', '');
  }

  private parseGroup(open: string, close: string) {
    if (this.peek() === open) this.index++;
    return this.parseExpression(close);
  }

  private parsePrimary(): MathNode | null {
    const value = this.peek();
    if (!value || value === '}' || value === ']') return null;
    if (value === '{') return this.parseGroup('{', '}');
    if (value === '(' || value === '[') {
      this.index++;
      const close = value === '(' ? ')' : ']';
      return node('mrow', [textNode('mo', value), this.parseExpression(close), textNode('mo', close)]);
    }
    if (value === '\\') return this.parseCommand();
    if (value === '~') {
      this.index++;
      return node('mspace', [], {width: '0.33em'});
    }
    if (/[0-9]/.test(value)) {
      const start = this.index++;
      while (/[0-9.,]/.test(this.peek())) this.index++;
      return textNode('mn', this.source.slice(start, this.index));
    }
    if (/[A-Za-z]/.test(value)) {
      const start = this.index++;
      while (/[A-Za-z]/.test(this.peek())) this.index++;
      return textNode('mi', this.source.slice(start, this.index));
    }
    this.index++;
    if ('+-=<>/,:;!?|*'.includes(value)) return textNode('mo', value);
    if (value === '.') return textNode('mo', '·');
    return textNode('mtext', value);
  }

  private readCommand() {
    if (this.peek() !== '\\') return '';
    this.index++;
    const start = this.index;
    while (/[A-Za-z]/.test(this.peek())) this.index++;
    if (start === this.index && this.index < this.source.length) this.index++;
    return this.source.slice(start, this.index);
  }

  private readGroupText() {
    this.skipWhitespace();
    if (this.peek() !== '{') return '';
    this.index++;
    const start = this.index;
    let depth = 1;
    while (this.index < this.source.length && depth) {
      if (this.peek() === '{') depth++;
      else if (this.peek() === '}') depth--;
      if (depth) this.index++;
    }
    const value = this.source.slice(start, this.index);
    if (this.peek() === '}') this.index++;
    return value;
  }

  private readDelimiter() {
    this.skipWhitespace();
    if (this.peek() === '\\') {
      const command = this.readCommand();
      return commandMap[command] || ({lbrace: '{', rbrace: '}', langle: '⟨', rangle: '⟩'}[command] || command);
    }
    return this.index < this.source.length ? this.source[this.index++] : '';
  }

  private parseTextArgument() {
    const value = this.readGroupText();
    return textNode('mtext', value);
  }

  private parseEnvironment() {
    const environment = this.readGroupText();
    const endMarker = `\\end{${environment}}`;
    const end = this.source.indexOf(endMarker, this.index);
    if (end < 0) return textNode('mtext', `\\begin{${environment}}`);
    const content = this.source.slice(this.index, end);
    this.index = end + endMarker.length;
    const rowTexts = content.split(/\\\\/g);
    const rows = rowTexts.filter(value => value.trim()).map(value => node('mtr', value.split('&').map(cell => node('mtd', [new TexParser(cell.trim()).parse()]))));
    const table = node('mtable', rows, {columnalign: 'center'});
    const brackets = environmentBrackets[environment];
    return brackets ? node('mrow', [textNode('mo', brackets[0]), table, textNode('mo', brackets[1])]) : table;
  }

  private parseCommand(): MathNode {
    const command = this.readCommand();
    if (command === 'frac' || command === 'dfrac' || command === 'tfrac') {
      return node('mfrac', [this.parseArgument(), this.parseArgument()]);
    }
    if (command === 'sqrt') {
      this.skipWhitespace();
      const index = this.peek() === '[' ? this.parseGroup('[', ']') : null;
      const body = this.parseArgument();
      return index ? node('mroot', [body, index]) : node('msqrt', [body]);
    }
    if (command === 'begin') return this.parseEnvironment();
    if (command === 'text' || command === 'textrm' || command === 'textnormal') return this.parseTextArgument();
    if (command === 'mathrm' || command === 'mathbf' || command === 'mathit' || command === 'mathsf' || command === 'mathtt') {
      const variant = command.slice(2) === 'bf' ? 'bold' : command.slice(2);
      return node('mstyle', [this.parseArgument()], {mathvariant: variant || 'normal'});
    }
    if (command === 'operatorname') return node('mo', [this.parseTextArgument()], {movablelimits: 'true'});
    if (command === 'overline' || command === 'bar' || command === 'hat' || command === 'vec' || command === 'underline' || command === 'dot' || command === 'ddot') {
      const accent = command === 'underline' ? 'munder' : 'mover';
      const mark = command === 'overline' || command === 'bar' ? '¯' : command === 'hat' ? '^' : command === 'vec' ? '→' : command === 'dot' ? '˙' : command === 'ddot' ? '¨' : '_';
      return node(accent, [this.parseArgument(), textNode('mo', mark)]);
    }
    if (command === 'left' || command === 'right') return textNode('mo', this.readDelimiter());
    if (command === 'displaystyle' || command === 'textstyle' || command === 'scriptstyle' || command === 'scriptscriptstyle') return this.parsePrimary() || textNode('mtext', '');
    if (command === ',' || command === ':' || command === ';' || command === '!' || command === 'quad' || command === 'qquad' || command === ' ') {
      return node('mspace', [], {width: command === 'qquad' ? '1em' : command === 'quad' ? '0.75em' : command === '!' ? '0.1em' : '0.25em'});
    }
    if (command in escapedSymbols) return textNode('mo', escapedSymbols[command]);
    if (largeOperators.has(command)) return textNode('mo', largeOperatorMap[command] || command, {largeop: 'true', movablelimits: 'true'});
    if (operatorCommands.has(command)) return textNode('mi', command, {mathvariant: 'normal'});
    if (command in commandMap) return textNode('mo', commandMap[command]);
    return textNode('mtext', `\\${command}`);
  }
}

/** Convert one TeX formula body to a safe React MathML tree. */
export function parseFormula(source: string): MathNode {
  return new TexParser(source).parse();
}

function renderMathNode(value: MathNode | string, key: string): ReactNode {
  if (typeof value === 'string') return value;
  const children = value.children.map((child, index) => renderMathNode(child, `${key}-${index}`));
  return createElement(value.tag, {...value.attrs, key}, ...children);
}

function SearchText({text, query}: {text: string; query: string}) {
  const ranges = matchRanges(text, queryTerms(query));
  const children: ReactNode[] = [];
  ranges.forEach((range, index) => {
    children.push(createElement('span', {key: `${range.start}:${range.end}`},
      text.slice(index ? ranges[index - 1].end : 0, range.start),
      createElement('mark', {key: 'match', 'data-term': range.termIndex % 12, title: `搜索词：${range.term}`}, text.slice(range.start, range.end))));
  });
  children.push(text.slice(ranges.length ? ranges[ranges.length - 1].end : 0));
  return createElement(Fragment, null, ...children);
}

function FormulaMath({source, display}: {source: string; display: boolean}) {
  let tree: MathNode;
  try {
    tree = parseFormula(source);
  } catch {
    tree = textNode('mtext', source);
  }
  return createElement('math', {
    className: `formula-math${display ? ' formula-math-display' : ''}`,
    xmlns: 'http://www.w3.org/1998/Math/MathML',
    display: display ? 'block' : undefined,
    'aria-label': source,
    'data-formula': source,
  }, renderMathNode(tree, 'formula'));
}

/** Render text and formulas while retaining search highlighting outside math. */
export function FormulaText({text, query = '', className = ''}: {text: string; query?: string; className?: string}) {
  const segments = splitFormulaText(text);
  const children = segments.map((segment, index) => segment.kind === 'formula'
    ? createElement(FormulaMath, {key: `formula-${index}`, source: segment.source, display: segment.display})
    : createElement('span', {className: 'formula-plain', key: `text-${index}`}, createElement(SearchText, {text: segment.text, query})));
  return createElement('span', {className: `formula-text${className ? ` ${className}` : ''}`}, ...children);
}

