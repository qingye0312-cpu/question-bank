import {themePageData,showPageTheme,hidePageTheme} from '../../services/appearance';
import {LocalBank, VirtualList, Segment, queryTerms, snippet, answerText, typeNames} from '../../core/search';
import {loadBank,listBanks,activeBankId,selectBank,invalidateBank,type BankSummary} from '../../services/bank';
import {refreshCatalog,syncBank} from '../../services/sync';
import {foregroundGeneration} from '../../services/foreground';
import {copyPrompt} from '../../services/prompt';
import {APP_VERSION} from '../../generated/client-assets';

const HEADER_COLLAPSED_KEY = 'qbank-search-header-collapsed-v1';
// Allow the 220 ms layout transition to finish before the final measurement.
const HEADER_LAYOUT_DELAY = 260;

type Row = {id: number; questionId: string; number: string; kind: string; layer:string; answer: string; segments: Segment[]};
Page({
  data: {
    ...themePageData(),
    query: '', bankName: '正在打开题库', version: 1, total: 0, count: 0,
    syncNotice:'',syncing:false,ready: false, loading: true, error: '', rows: [] as Row[],
    before: 0, after: 0, scrollTop: 0, headerCollapsed: false, advancedOpen: false,
    appVersion:APP_VERSION,bankId:'',banks:[] as BankSummary[],bankIndex:0,bankLabel:'内置题库',
  },
  bank: undefined as LocalBank | undefined,
  ids: [] as number[], terms: [] as string[], layout: null as VirtualList | null,
  loadEpoch:0, request: 0, renderEpoch: 0, start: -1, end: -1, scrollPosition: 0,
  viewport: 700, scrollTimer: undefined as number | undefined, alive: true,
  headerTimer: undefined as number | undefined,
  foregroundSeen:-1,
  // Page() deep-clones free data; construct class instances after that clone.
  onLoad(): Promise<void> {
    this.layout = new VirtualList(0);
    this.foregroundSeen=foregroundGeneration();
    try { this.setData({headerCollapsed: wx.getStorageSync(HEADER_COLLAPSED_KEY) === true}); }
    catch { /* A failed preference read must not prevent local search. */ }
    return this.initialize().then(()=>{void this.syncCloud();});
  },
  onShow(){
    showPageTheme(this);
    const generation=foregroundGeneration();
    if(this.foregroundSeen<0){this.foregroundSeen=generation;return;}
    // Page onShow also fires when returning from detail; only app foreground entries sync.
    if(generation!==this.foregroundSeen){
      this.foregroundSeen=generation;
      if(this.data.ready&&!this.data.loading)void this.syncCloud();
    }
  },
  onReady() { this.measureViewport(); },
  onResize() { this.measureViewport(); this.layout = new VirtualList(this.ids.length); this.renderRows(true); },
  onHide(){hidePageTheme(this);},
  onUnload() {
    hidePageTheme(this);
    this.alive = false; this.request++; this.renderEpoch++; this.bank?.cancel();
    if (this.scrollTimer !== undefined) clearTimeout(this.scrollTimer);
    if (this.headerTimer !== undefined) clearTimeout(this.headerTimer);
  },
  async initialize(): Promise<void> {
    const epoch=++this.loadEpoch;this.bank?.cancel();
    this.setData({loading: true, error: ''});
    try {
      const banks=await listBanks();
      const id=banks.some(b=>b.id===activeBankId())?activeBankId():banks[0].id;
      const {bank, manifest} = await loadBank(id);
      if (!this.alive||epoch!==this.loadEpoch) return;
      selectBank(id);
      this.setData({banks,bankId:id,bankIndex:banks.findIndex(b=>b.id===id),bankLabel:manifest.release_id==='local'?'本地题库':'正式题库 + 待合并题 + 本地新题'});
      this.bank = bank;
      this.setData({ready: true, bankName: banks.find(b=>b.id===id)?.name||manifest.name, version: manifest.release_version, total: manifest.question_count}, () => this.measureViewport());
      await this.runSearch(this.data.query);
    } catch (error) {
      if (this.alive&&epoch===this.loadEpoch) this.setData({loading: false, error: error instanceof Error ? error.message : '题库加载失败，请重试'});
    }
  },
  async syncCloud(){
    if(this.data.syncing||!this.alive)return;this.setData({syncing:true});const id=this.data.bankId;
    try{await refreshCatalog();const changed=await syncBank(id);if(!this.alive)return;
      const banks=await listBanks();this.setData({banks,bankIndex:banks.findIndex(b=>b.id===this.data.bankId),bankName:banks.find(b=>b.id===this.data.bankId)?.name||this.data.bankName,syncNotice:'云端版本已核对'},()=>this.measureViewport());
      if(changed){invalidateBank(id);if(this.data.bankId===id)await this.initialize();}
    }catch(e){if(this.alive)this.setData({syncNotice:e instanceof Error?e.message:'同步暂未完成，本地题库仍可使用'});}
    finally{if(this.alive){this.setData({syncing:false});if(this.data.bankId!==id)void this.syncCloud();}}
  },
  onSync(){void this.syncCloud();},
  measureViewport() {
    if (!this.alive) return;
    wx.createSelectorQuery().in(this).select('.results').boundingClientRect(rect => {
      if (this.alive && rect && !Array.isArray(rect) && rect.height) { this.viewport = rect.height; this.renderRows(true); }
    }).exec();
  },
  onToggleHeader() {
    const headerCollapsed = !this.data.headerCollapsed;
    if (this.headerTimer !== undefined) clearTimeout(this.headerTimer);
    this.setData({headerCollapsed}, () => {
      if (!this.alive) return;
      // Keep the query, measured row heights and scroll position when folding.
      this.measureViewport();
      if (this.headerTimer !== undefined) clearTimeout(this.headerTimer);
      this.headerTimer = setTimeout(() => {
        this.headerTimer = undefined;
        this.measureViewport();
      }, HEADER_LAYOUT_DELAY);
    });
    try { wx.setStorageSync(HEADER_COLLAPSED_KEY, headerCollapsed); }
    catch { /* The in-memory preference remains usable if storage is full. */ }
  },
  onToggleAdvanced() {
    this.setData({advancedOpen: !this.data.advancedOpen}, () => this.measureViewport());
  },
  onAppearance(){wx.navigateTo({url:"/pages/settings/settings"});},
  onCopyPrompt(){copyPrompt()},
  onIntake(){wx.navigateTo({url:`/pages/intake/intake?bank=${this.data.bankId||activeBankId()}`})},
  onBankChange(event:WechatMiniprogram.PickerChange){const b=this.data.banks[Number(event.detail.value)];if(!b)return;selectBank(b.id);void this.initialize().then(()=>this.syncCloud())},
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
      return {id, questionId: q.question_id, number: q.external_id, kind: typeNames[q.type],layer:q.cloud_layer==='pending'?(q.status==='verified'?'待合并':'历史未确认'):q.cloud_layer==='draft'?'本地新题':'',
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
    wx.navigateTo({url: `/pages/detail/detail?row=${id}&id=${q.question_id}&bank=${this.data.bankId}`,
      success: result => result.eventChannel.emit('searchContext', {query})});
  },
});
