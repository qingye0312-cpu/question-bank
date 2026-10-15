// Keep field names aligned with 飞书题库收集与发布接入方案_待审核.md.
const text = field_name => ({field_name, type: 1, ui_type: 'Text'});
const number = field_name => ({field_name, type: 2, ui_type: 'Number'});
const date = field_name => ({field_name, type: 5, ui_type: 'DateTime'});
const select = (field_name, options) => ({field_name, type: 3, ui_type: 'SingleSelect',
  property: {options: options.map(name => ({name}))}});

export const tables = [
  {
    key: 'candidates', env: 'FEISHU_CANDIDATES_TABLE_ID', name: '候选题',
    fields: [
      text('提交编号'), text('题库 ID'), select('目标题库', ['HarmonyOS 初级认证', 'HarmonyOS 高级认证']),
      select('题型', ['单选', '多选', '判断', '待确认']), text('题干'),
      ...'ABCDEFGH'.split('').map(key => text(`选项 ${key}`)),
      text('模型答案'), text('核定答案'), text('模型解析'), text('核定解析'),
      text('模型名称'), text('模型版本'), select('版本来源声明', ['platform', 'user', 'unknown']),
      select('版本核验来源', ['粘贴文本', '用户补填', '接口元数据', '未知']), text('待核对内容'),
      select('比对结果', ['新题', '一致', '有差异', '相似待判定']),
      text('关联原题 ID'), number('原题修订号'),
      select('审核状态', ['待核对', '待补充', '待发布', '不收录']),
      select('发布状态', ['未发布', '已冻结', '发布中', '已发布', '发布失败']), text('发布批次'),
      text('提交者代号'), select('来源端', ['Mac', 'Windows', '微信小程序']),
      date('提交时间'), text('文字原稿'),
    ],
  },
  {
    key: 'banks', env: 'FEISHU_BANKS_TABLE_ID', name: '题库目录',
    fields: [text('题库 ID'), text('题库名称'), number('显示顺序'),
      select('是否允许投稿', ['允许', '暂停']), text('维护者'), number('当前正式发布版本'), text('当前内容哈希')],
  },
  {
    key: 'releases', env: 'FEISHU_RELEASES_TABLE_ID', name: '发布记录',
    fields: [text('发布批次'), text('题库 ID'), number('版本号'), number('新增题数'), number('修订题数'),
      number('总题数'), text('标准内容哈希'), text('包文件哈希'), text('发布者'), date('发布时间'),
      select('结果', ['准备中', '已发布', '失败']), text('失败原因')],
  },
];
