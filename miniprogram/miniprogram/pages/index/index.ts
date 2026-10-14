import {LocalBank, VirtualList, Segment, queryTerms, snippet, answerText, typeNames} from '../../core/search';
import {loadBank} from '../../services/bank';

type Row = {id: number; questionId: string; number: string; kind: string; answer: string; segments: Segment[]};
Page({
  data: {
    query: '', bankName: '正在打开题库', version: 1, total: 0, count: 0,
    ready: false, loading: true, error: '', rows: [] as Row[],
    before: 0, after: 0, scrollTop: 0,
  },
  bank: undefined as LocalBank | undefined,
  ids: [] as number[], terms: [] as string[], layout: null as VirtualList | null,
  request: 0, renderEpoch: 0, start: -1, end: -1, scrollPosition: 0,
  viewport: 700, scrollTimer: undefined as number | undefined, alive: true,
  // Page() deep-clones free data; construct class instances after that clone.
  onLoad(): Promise<void> { this.layout = new VirtualList(0); return this.initialize(); },
  onReady() { this.measureViewport(); },
  onResize() { this.measureViewport(); this.layout = new VirtualList(this.ids.length); this.renderRows(true); },
  onUnload() {
    this.alive = false; this.request++; this.renderEpoch++; this.bank?.cancel();
    if (this.scrollTimer !== undefined) clearTimeout(this.scrollTimer);
  },
  async initialize(): Promise<void> {
    this.setData({loading: true, error: ''});
    try {
      const {bank, manifest} = await loadBank();
      if (!this.alive) return;
      this.bank = bank;
      this.setData({ready: true, bankName: manifest.name, version: manifest.release_version, total: manifest.question_count});
      await this.runSearch(this.data.query);
    } catch (error) {
      if (this.alive) this.setData({loading: false, error: error instanceof Error ? error.message : '题库加载失败，请重试'});
    }
  },
  measureViewport() {
    wx.createSelectorQuery().in(this).select('.results').boundingClientRect(rect => {
      if (rect && !Array.isArray(rect) && rect.height) { this.viewport = rect.height; this.renderRows(true); }
    }).exec();
  },
  onInput(event: WechatMiniprogram.Input) {
    this.setData({query: event.detail.value});
    void this.runSearch(event.detail.value);
  },
  onClear() { this.setData({query: ''}); void this.runSearch(''); },
  async runSearch(query: string): Promise<void> {
    if (!this.bank) return;
    const request = ++this.request;
    this.renderEpoch++; this.ids = []; this.start = -1; this.end = -1;
    // Sync the controlled scroll position before resetting, including when its
    // previous bound value is still zero after native user scrolling.
    this.setData({loading: true, error: '', rows: [], count: 0, before: 0, after: 0, scrollTop: this.scrollPosition}, () => {
      if (this.alive && request === this.request) this.setData({scrollTop: 0});
    });
    this.scrollPosition = 0;
    try {
      this.terms = queryTerms(query);
      const ids = await this.bank.search(query);
      if (!this.alive || request !== this.request || ids === null) return;
      this.ids = ids; this.layout = new VirtualList(ids.length);
      this.setData({loading: false, count: ids.length, scrollTop: 0});
      this.renderRows(true);
    } catch (error) {
      this.bank.cancel();
      if (this.alive && request === this.request) this.setData({loading: false, error: error instanceof Error ? error.message : '搜索失败，请重试'});
    }
  },
  onScroll(event: WechatMiniprogram.ScrollViewScroll) {
    this.scrollPosition = Math.max(0, event.detail.scrollTop);
    if (this.scrollTimer !== undefined) return;
    this.scrollTimer = setTimeout(() => { this.scrollTimer = undefined; this.renderRows(); }, 16);
  },
  renderRows(force = false) {
    if (!this.bank || !this.alive || this.data.loading || this.data.error) return;
    const layout = this.layout;
    if (!layout) return;
    const range = layout.window(this.scrollPosition, this.viewport);
    if (!force && range.start === this.start && range.end === this.end) return;
    const epoch = ++this.renderEpoch;
    this.start = range.start; this.end = range.end;
    const rows = this.ids.slice(range.start, range.end).map(id => {
      const q = this.bank!.question(id);
      return {id, questionId: q.question_id, number: q.external_id, kind: typeNames[q.type],
        answer: answerText(q), segments: snippet(q, this.terms)};
    });
    this.setData({rows, before: range.before, after: range.after}, () => {
      if (!this.alive || epoch !== this.renderEpoch || !rows.length) return;
      wx.createSelectorQuery().in(this).selectAll('.result-row').boundingClientRect(rects => {
        if (!this.alive || epoch !== this.renderEpoch || !Array.isArray(rects) || rects.length !== rows.length) return;
        const anchor = layout.at(this.scrollPosition), oldOffset = layout.offset(anchor);
        layout.measure(range.start, rects.map(rect => rect.height));
        const correction = layout.offset(anchor) - oldOffset;
        this.scrollPosition = Math.max(0, this.scrollPosition + correction);
        const spacing = {before: layout.offset(range.start),
          after: layout.offset(this.ids.length) - layout.offset(range.end)};
        this.setData(Math.abs(correction) > 0.5 ? {...spacing, scrollTop: this.scrollPosition} : spacing);
        this.renderRows();
      }).exec();
    });
  },
  onOpen(event: WechatMiniprogram.TouchEvent) {
    const id = Number(event.currentTarget.dataset.id);
    if (!this.ids.includes(id) || !this.bank) return;
    const q = this.bank.question(id);
    const query = this.data.query;
    wx.navigateTo({url: `/pages/detail/detail?row=${id}&id=${q.question_id}`,
      success: result => result.eventChannel.emit('searchContext', {query})});
  },
});
