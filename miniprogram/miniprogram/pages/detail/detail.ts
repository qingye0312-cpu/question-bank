import {themePageData,showPageTheme,hidePageTheme} from '../../services/appearance';
import {recordedTime,displayTime} from '../../core/intake';
import {loadBank} from '../../services/bank';
import {Question, Segment, queryTerms, highlight, answerText, typeNames} from '../../core/search';

Page({
  data: {
    ...themePageData(),
    layer:'',loading: true, error: '', number: '', kind: '', answer: '', explanation: '',
    stem: [] as Segment[], options: [] as {key: string; correct: boolean; segments: Segment[]}[],
    metadata: [] as {label: string; segments: Segment[]}[],
  },
  alive: true,
  query: '',
  question: undefined as Question | undefined,
  async onLoad(params: Record<string, string | undefined>) {
    this.getOpenerEventChannel().on('searchContext', (context: {query: string}) => {
      this.query = context.query;
      if (this.question) this.showQuestion();
    });
    try {
      const {bank} = await loadBank(params.bank);
      const q = bank.question(Number(params.row));
      if (q.question_id !== params.id) throw new Error('题目身份不一致，请返回列表重新打开');
      this.question = q;
      this.showQuestion();
    } catch (error) {
      if (this.alive) this.setData({loading: false, error: error instanceof Error ? error.message : '题目加载失败'});
    }
  },
  showQuestion() {
    const q = this.question;
    if (!q || !this.alive) return;
    const terms = queryTerms(this.query);
    const metadata = [['录入时间', displayTime(recordedTime(q))+(q.recorded_at_source==='import'?'（首次导入）':'')],['章节', q.chapter], ['标签', q.tags.join(' ')], ['编号', q.external_id], ['ID', q.question_id]]
      .filter(([, value]) => !!value).map(([label, value]) => ({label, segments: highlight(value, terms)}));
    this.setData({layer:q.cloud_layer==='pending'?(q.status==='verified'?'历史候选':'历史未确认 · 答案未经维护者核对'):q.cloud_layer==='draft'?'本地新题 · 尚未正式发布':'',loading: false, number: q.external_id, kind: typeNames[q.type], answer: answerText(q),
      stem: highlight(q.stem, terms), explanation: q.explanation,
      options: q.options.map(o => ({key: o.key, correct: Array.isArray(q.answer) && q.answer.includes(o.key), segments: highlight(o.content, terms)})), metadata});
  },
  onShow(){showPageTheme(this);},
  onHide(){hidePageTheme(this);},
  onUnload() { hidePageTheme(this); this.alive = false; },
});
