import fs from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Workbook,SpreadsheetFile} from '@oai/artifact-tool';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=root+'/templates';
await fs.mkdir(out,{recursive:true});
const headers=['外部编号','题型','题库','章节','题干',...'ABCDEFGH'.split('').map(k=>'选项'+k),'答案','解析','标签','难度','适用版本','来源说明','系统ID','基准修订号'];
const examples=JSON.parse(await fs.readFile(root+'/src-tauri/resources/examples.json','utf8'));
const rows=examples.map(q=>[q.external_id,({single:'单选',multiple:'多选',true_false:'判断',programming:'编程'})[q.type],q.bank,'数学基础',q.stem,...'ABCDEFGH'.split('').map(k=>q.options.find(o=>o.key===k)?.content||''),typeof q.answer==='boolean'?(q.answer?'正确':'错误'):Array.isArray(q.answer)?q.answer.join('|'):'',q.explanation,q.tags.join('|'),'简单','','示例题目','','']);
const wb=Workbook.create();
const guide=wb.worksheets.add('填写说明');
const questions=wb.worksheets.add('题目');
const dictionary=wb.worksheets.add('字段字典');
const demo=wb.worksheets.add('示例');
for(const s of [guide,questions,dictionary,demo]){s.showGridLines=false;s.getRange('A1:U35').format.font={name:'Arial',size:11,color:'#263A32'};s.getRange('A1:U35').format.verticalAlignment='center';}
guide.tabColor='#236752';questions.tabColor='#78986D';
guide.getRange('A2').values=[['题库导入模板']];guide.getRange('A2').format.font={size:17,bold:true};
guide.getRange('A4:B4').values=[['模板版本','1.0']];guide.getRange('B4').setNumberFormat('@');guide.getRange('A6:B13').values=[
 ['开始填写','切换到「题目」工作表，从第 2 行起一题一行。'],
 ['查看示例','「示例」仅作参考，不会被导入；可复制行到「题目」后修改。'],
 ['必填字段','题型、题干、答案；选择题填写 2 至 8 个连续选项。题库也可在导入时指定。'],
 ['答案规则','单选填 B；多选填 A|C；判断填“正确”或“错误”，选项留空。'],
 ['正文与代码','按文本填写，保留换行。不要用颜色、加粗、打勾表示答案。'],
 ['系统标识','新题的系统ID、基准修订号留空。更新题目请使用系统导出的完整行。'],
 ['文件限制','禁止公式、图片、宏和嵌入对象。复杂内容请保留原文件，等待后续支持。'],
 ['导入步骤','应用 → 导入 → 选择文件 → 检查预览 → 确认导入。']
];
guide.getRange('A4:A13').format.columnWidth=20;guide.getRange('B4:B13').format.columnWidth=85;guide.getRange('A6:B13').format.rowHeight=45;guide.getRange('A6:A13').format.fill='#EDF3E9';guide.getRange('B6:B13').format.wrapText=true;guide.getRange('A4:B4').format.fill='#EDF3E9';
const descriptions=['自定义文本编号，可选','单选 / 多选 / 判断','填写名称，或在应用导入时指定','可选，层级使用 / 分隔','必填；保留代码、符号和换行',...Array(8).fill('选择题从 A 连续填写；判断题留空'),'单选 B；多选 A|C；判断 正确 / 错误','可选；未提供时留空','多标签用 | 分隔','简单 / 中等 / 困难，或留空','适用知识或软件版本；未知留空','可选，文档、章节或网址','新题留空；系统导出后不得随意修改','新题留空；更新题目必须保留'];
dictionary.getRange('A1:C22').values=[['字段','要求','填写说明'],...headers.map((h,i)=>[h,['题型','题干','答案'].includes(h)?'必填':h.startsWith('选项')?'按题型填写':'可选',descriptions[i]])];
dictionary.getRange('A1:C1').format={fill:'#344F42',font:{bold:true,color:'#FFFFFF'},rowHeight:30};dictionary.getRange('A2:C22').format.rowHeight=29;dictionary.getRange('A1:A22').format.columnWidth=20;dictionary.getRange('B1:B22').format.columnWidth=20;dictionary.getRange('C1:C22').format.columnWidth=68;dictionary.freezePanes.freezeRows(1);
for(const s of [questions,demo]){
 s.getRange('A1:U1').values=[headers];s.getRange('A1:U1').format={fill:'#344F42',font:{bold:true,color:'#FFFFFF'},rowHeight:32};
 s.getRange('A2:U501').setNumberFormat('@');s.getRange('A2:U501').format.font={name:'Arial',size:11,color:'#263A32'};
 s.getRange('A2:U20').format.rowHeight=44;s.getRange('A1:U20').format.columnWidth=18;s.getRange('E1:E20').format.columnWidth=48;s.getRange('F1:M20').format.columnWidth=22;s.getRange('N1:N20').format.columnWidth=18;s.getRange('O1:O20').format.columnWidth=36;s.getRange('T1:T20').format.columnWidth=40;s.getRange('U1:U20').format.columnWidth=18;
 s.getRange('A2:U501').format.wrapText=true;s.getRange('B2:B501').dataValidation={rule:{type:'list',values:['单选','多选','判断','编程']}};s.getRange('Q2:Q501').dataValidation={rule:{type:'list',values:['简单','中等','困难']}};
 s.freezePanes.freezeRows(1);s.freezePanes.freezeColumns(2);
 for(const col of ['B','E','N'])s.getRange(`${col}2:${col}20`).format.fill='#FFFAE8';
}
demo.getRange('A2:U4').values=rows;
wb.recalculate();
console.log((await wb.inspect({kind:'table',range:'示例!A1:U4',include:'values',tableMaxRows:4,tableMaxCols:21,maxChars:4000})).ndjson);
console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?',options:{useRegex:true,maxResults:20}})).ndjson);
const qa=root+'/artifacts/template-previews';await fs.mkdir(qa,{recursive:true});
for(const [sheetName,range,key] of [['填写说明','A1:B14','guide'],['字段字典','A1:C22','dictionary'],['题目','A1:E6','questions'],['题目','N1:U6','questions-tail'],['示例','A1:H4','examples'],['示例','I1:U4','examples-tail']]){
 const blob=await wb.render({sheetName,range,scale:1.3,format:'png'});await fs.writeFile(`${qa}/${key}.png`,new Uint8Array(await blob.arrayBuffer()));
}
await (await SpreadsheetFile.exportXlsx(wb)).save(out+'/题库导入模板_v1.xlsx');
await fs.writeFile(out+'/题库导入示例_v1.jsonl',examples.map(q=>JSON.stringify(q)).join('\n')+'\n');
questions.getRange('A2:U4').values=rows;
await fs.mkdir(root+'/src-tauri/tests/fixtures',{recursive:true});
await (await SpreadsheetFile.exportXlsx(wb)).save(root+'/src-tauri/tests/fixtures/excel-filled-test.xlsx');
console.log('Template saved.');
