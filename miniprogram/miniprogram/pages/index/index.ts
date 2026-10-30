import {themePageData,showPageTheme,hidePageTheme} from '../../services/appearance';
import {LocalBank, VirtualList, Segment, queryTerms, snippet, answerText, typeNames} from '../../core/search';
import {loadBank,listBanks,activeBankId,selectBank,invalidateBank,bankCacheGeneration,type BankSummary} from '../../services/bank';
import {cloudCatalog,refreshCatalog,syncBank} from '../../services/sync';
import {foregroundGeneration} from '../../services/foreground';
import {APP_VERSION} from '../../generated/client-assets';

const HEADER_COLLAPSED_KEY = 'qbank-search-header-collapsed-v1';
// Allow the 220 ms layout transition to finish before the final measurement.
const HEADER_LAYOUT_DELAY = 260;
const MAX_SHARED_QUERY_LENGTH = 300;

function shareTitle(bankName: string): string {
  const name = bankName && bankName !== '正在打开题库' ? `知屿题库 · ${bankName}` : '知屿题库';
  return Array.from(name).slice(0, 32).join('');
}

function trimShareQuery(value: string): string {
  let result='';
  for(const character of value.trim()){
    if(result.length+character.length>MAX_SHARED_QUERY_LENGTH)break;
    result+=character;
  }
  return result;
}

function shareContent(bankId: string, bankName: string, searchQuery: string) {
  const isShareable=cloudCatalog().some(bank=>bank.bank_id===bankId);
  const params:string[]=[];
  if(isShareable){
    params.push(`bank=${encodeURIComponent(bankId)}`);
    const query=trimShareQuery(searchQuery);
    if(query)params.push(`q=${encodeURIComponent(query)}`);
  }
  const query=params.join('&');
  return {title:isShareable?shareTitle(bankName):'知屿题库 · 离线题库',
    path:`/pages/index/index${query?`?${query}`:''}`,query};
}

type Row = {id: number; questionId: string; number: string; kind: string; layer:string; answer: string; segments: Segment[]};
Page({
  data: {
    ...themePageData(),
    query: '', bankName: '正在打开题库', version: 1, total: 0, count: 0,
    syncNotice:'',syncing:false,ready: false, loading: true, error: '', rows: [] as Row[],
    before: 0, after: 0, scrollTop: 0, headerCollapsed: false,
    appVersion:APP_VERSION,bankId:'',banks:[] as BankSummary[],bankIndex:0,bankLabel:'云端题库',
  },
  bank: undefined as LocalBank | undefined,
  ids: [] as number[], terms: [] as string[], layout: null as VirtualList | null,
  loadEpoch:0, request: 0, renderEpoch: 0, start: -1, end: -1, scrollPosition: 0,
  viewport: 700, scrollTimer: undefined as number | undefined, alive: true,
  headerTimer: undefined as number | undefined,
  foregroundSeen:-1,
  cacheGenerationSeen:0,
  // Page() deep-clones free data; construct class instances after that clone.
  async onLoad(options: Record<string, string | undefined> = {}): Promise<void> {
    this.layout = new VirtualList(0);
    this.foregroundSeen=foregroundGeneration();
    try { this.setData({headerCollapsed: wx.getStorageSync(HEADER_COLLAPSED_KEY) === true}); }
    catch { /* A failed preference read must not prevent local search. */ }
    const requestedBankId=options.bank||'';
    const sharedQuery=trimShareQuery(options.q||'');
    if(sharedQuery)this.setData({query:sharedQuery});
    let catalogRefreshAttempted=false;
    if(requestedBankId){
      let known=false;
      try{known=(await listBanks()).some(bank=>bank.id===requestedBankId)}catch{/* Continue with the saved/default bank. */}
      if(!known){catalogRefreshAttempted=true;try{await refreshCatalog();}catch{/* An offline share still opens the locally available bank. */}}
    }
    await this.initialize(requestedBankId);
    void this.syncCloud(catalogRefreshAttempted);
  },
  onShow(){
    showPageTheme(this);
    const generation=foregroundGeneration();
    if(this.foregroundSeen<0){this.foregroundSeen=generation;return;}
    if(this.data.ready&&this.cacheGenerationSeen!==bankCacheGeneration()){
      this.cacheGenerationSeen=bankCacheGeneration();
      void this.initialize().then(()=>{if(this.alive&&this.data.ready)void this.syncCloud(false,true);}).catch(()=>{});
      return;
    }
    // Page onShow also fires when returning from detail; only app foreground entries sync.
    if(generation!==this.foregroundSeen){
      this.foregroundSeen=generation;
      if(!this.data.loading)void this.syncCloud();
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
  async initialize(preferredBankId=''): Promise<void> {
    const epoch=++this.loadEpoch;this.bank?.cancel();
    this.setData({loading: true, error: ''});
    try {
      const banks=await listBanks();
      if(!banks.length){
        if(!this.alive||epoch!==this.loadEpoch)return;
        this.bank=undefined;this.ids=[];this.start=-1;this.end=-1;
        this.setData({loading:false,ready:false,banks:[],bankId:'',bankName:'等待云端题库',bankLabel:'',total:0,count:0,rows:[],before:0,after:0});
        return;
      }
      const id=banks.some(b=>b.id===preferredBankId)?preferredBankId:banks.some(b=>b.id===activeBankId())?activeBankId():banks[0].id;
      if(!this.alive||epoch!==this.loadEpoch)return;
      this.bank=undefined;this.ids=[];this.start=-1;this.end=-1;
      selectBank(id);
      this.setData({banks,bankId:id,bankIndex:banks.findIndex(b=>b.id===id),bankName:banks.find(b=>b.id===id)!.name,ready:false,rows:[],total:0,count:0,before:0,after:0});
      const {bank, manifest} = await loadBank(id);
      if (!this.alive||epoch!==this.loadEpoch) return;
      selectBank(id);
      const cloudCount=manifest.cloud_question_count||0,localCount=manifest.local_question_count||0;
      this.setData({banks,bankId:id,bankIndex:banks.findIndex(b=>b.id===id),bankLabel:manifest.release_id==='local'?'本地题库':localCount?`云端正式 ${cloudCount} + 本地新题 ${localCount}`:'云端正式题库'});
      this.bank = bank;
      this.cacheGenerationSeen=bankCacheGeneration();
      this.setData({ready: true, bankName: banks.find(b=>b.id===id)?.name||manifest.name, version: manifest.release_version, total: manifest.question_count}, () => this.measureViewport());
      await this.runSearch(this.data.query);
    } catch (error) {
      if (this.alive&&epoch===this.loadEpoch) this.setData({loading: false, error: error instanceof Error ? error.message : '题库加载失败，请重试'});
    }
  },
  async syncCloud(catalogRefreshAttempted=false,force=false){
    if(this.data.syncing||!this.alive)return;this.setData({syncing:true});let id=this.data.bankId;
    try{
      if(!catalogRefreshAttempted)await refreshCatalog(force);
      if(!this.alive)return;
      // Publish the directory independently of the selected bank's download.
      const banks=await listBanks(),preferred=id||activeBankId();
      id=banks.some(bank=>bank.id===preferred)?preferred:banks[0]?.id||'';
      if(id&&id!==this.data.bankId)selectBank(id);
      this.setData({banks,bankId:id,bankIndex:banks.findIndex(b=>b.id===id),bankName:banks.find(b=>b.id===id)?.name||this.data.bankName},()=>this.measureViewport());
      // Download every discovered bank, current bank first. A failed download
      // must not prevent a different bank (including a new one) being cached.
      const manifests=[...cloudCatalog()].sort((a,b)=>Number(b.bank_id===id)-Number(a.bank_id===id));
      const failures:string[]=[];
      for(const manifest of manifests){
        if(!this.alive)return;
        this.setData({syncNotice:`正在同步 ${manifest.name} · 共 ${manifests.length} 个云端题库`});
        try{
          const changed=await syncBank(manifest.bank_id,manifest);
          if(changed)invalidateBank(manifest.bank_id);
          if(!this.alive)return;
          if(this.data.bankId===manifest.bank_id&&(changed||!this.data.ready))await this.initialize(manifest.bank_id);
        }catch(e){failures.push(e instanceof Error?e.message:'题库下载暂未完成');}
      }
      if(!this.alive)return;
      this.setData({syncNotice:failures.length?`${failures.length} 个题库同步未完成 · ${failures[0]}`
        :`云端 ${manifests.length} 个题库 · 版本已核对，已缓存可离线使用`});
    }catch(e){if(this.alive)this.setData({syncNotice:e instanceof Error?e.message:'同步暂未完成，已有缓存仍可使用'});}
    finally{if(this.alive){this.setData({syncing:false});if(this.data.bankId!==id)void this.syncCloud();}}
  },
  onSync(){void this.syncCloud(false,true);},
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
  onAppearance(){wx.navigateTo({url:"/pages/settings/settings"});},
  onSharePage(){const bank=this.data.bankId||activeBankId();wx.navigateTo({url:`/pages/share/share?bank=${encodeURIComponent(bank)}`});},
  onIntake(){wx.navigateTo({url:`/pages/intake/intake?bank=${this.data.bankId||activeBankId()}`})},
  onShareAppMessage(){const {title,path}=shareContent(this.data.bankId||activeBankId(),this.data.bankName,this.data.query);return {title,path};},
  onShareTimeline(){const {title,query}=shareContent(this.data.bankId||activeBankId(),this.data.bankName,this.data.query);return {title,query};},
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
      return {id, questionId: q.question_id, number: q.external_id, kind: typeNames[q.type],layer:q.cloud_layer==='draft'?'本地新题':'',
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
