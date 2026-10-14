"""One-time, source-preserving migration of the six audited Word files. No network."""
from pathlib import Path
import json, re, hashlib, uuid, zipfile, collections
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
NS = uuid.UUID('ad50971f-66af-51c2-bb0e-dc798b03b369')

def paragraphs(path):
    with zipfile.ZipFile(path) as z:
        doc = ET.fromstring(z.read('word/document.xml'))
        nums = ET.fromstring(z.read('word/numbering.xml'))
    abstracts = {e.get(W+'abstractNumId'): e for e in nums.findall(W+'abstractNum')}
    levels = {}
    for n in nums.findall(W+'num'):
        a = abstracts[n.find(W+'abstractNumId').get(W+'val')]
        for l in a.findall(W+'lvl'):
            level = l.get(W+'ilvl')
            start = int(l.find(W+'start').get(W+'val', '1'))
            override = n.find(f"{W}lvlOverride[@{W}ilvl='{level}']/{W}startOverride")
            if override is not None: start = int(override.get(W+'val'))
            levels[n.get(W+'numId'), level] = (l.find(W+'numFmt').get(W+'val'), start)
    counters = {}; rows = []
    for idx,p in enumerate(doc.find(W+'body').findall(W+'p')):
        text = ''.join(e.text or '' if e.tag == W+'t' else '\n' if e.tag == W+'br' else '\t' for e in p.iter() if e.tag in (W+'t',W+'br',W+'tab'))
        num=''; fmt=''
        n=p.find(f'{W}pPr/{W}numPr')
        if n is not None and n.find(W+'numId') is not None:
            nid=n.find(W+'numId').get(W+'val'); lev=n.find(W+'ilvl'); lev=lev.get(W+'val') if lev is not None else '0'
            if (nid,lev) in levels:
                fmt,start=levels[nid,lev]; count=counters.get((nid,lev),start-1)+1; counters[nid,lev]=count
                num=(chr(64+count) if fmt=='upperLetter' and 0<count<27 else str(count))+'.'
        red=[]
        for r in p.findall(W+'r'):
            c=r.find(f'{W}rPr/{W}color')
            if c is not None and c.get(W+'val','').upper() in ['FF0000','C00000']:
                red.append(''.join(e.text or '' for e in r.iter(W+'t')))
        rows.append({'p':idx,'text':text,'num':num,'format':fmt,'red':red})
    return rows

all_questions=[]; files=[]
for path in sorted(ROOT.rglob('*.docx')):
    if 'node_modules' in path.parts or '.tooling' in path.parts or path.parent.name == 'templates': continue
    if not path.name.startswith(('9.23','9.20')): continue
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    filename=str(path.relative_to(ROOT)); files.append({'file':filename,'sha256':digest})
    if not path.name.startswith('9.23'): continue
    kind='true_false' if '判断' in path.name else 'multiple' if '多选' in path.name else 'single'
    segmented=[]; current=None
    for p in paragraphs(path):
        m=re.match(r'^\s*(\d+)[.．、)）]\s*',p['text'])
        if kind=='true_false' and p['text'].startswith('50在应用'): m=re.match(r'^(50)',p['text'])
        qno=int(p['num'][:-1]) if p['format']=='decimal' else int(m[1]) if m else None
        if qno is not None:
            current={'number':qno,'body':[]};segmented.append(current)
        if current is not None: current['body'].append(p)
    for raw in segmented:
        n=raw['number']; stem=[]; options=[]; reds=[]; answer=None; issues=[]; check=None
        answer_text=[]
        body=[dict(p) for p in raw['body']]
        # Audited, file-specific layout exceptions; original text remains in sources.
        if (kind=='single' and n in (143,159,267)):
            first=body[0]; split=re.search(r'A[.、]',first['text'])
            if split:
                option=dict(first,text=first['text'][split.start():],num='',format='')
                first['text']=first['text'][:split.start()].rstrip(); body.insert(1,option)
                issues.append('原文选项 A 与题干连写，迁移已拆分，请复核')
        if (kind=='multiple' and n==30) or (kind=='single' and n in (443,445,446)):
            body[1]['text']='A. '+body[1]['text'];issues.append('原文首个选项缺少 A 标号，按段落顺序保留为 A，请复核')
        for i,p in enumerate(body):
            text=p['text'].strip()
            if not text: continue
            if i==0:
                text=re.sub(r'^\d+[.．、)）]\s*','',text)
                if kind=='true_false' and n==50: text=re.sub(r'^50','',text)
            ans=re.match(r'^答案\s*[:：]\s*(.*)',text)
            if ans:
                answer_text.append(ans[1])
                if kind=='true_false': answer=True if ans[1] in ('对','正确') else False if ans[1] in ('错','错误') else None
                else: answer=re.findall('[A-H]',ans[1].upper())
                continue
            if kind=='true_false' and re.match(r'^[√✔✓]?\s*(正确|错误)',text):
                if re.match(r'^[√✔✓]',text): check='正确' in text
                continue
            label=re.match(r'^([A-H])(?:[.,，．、:：)）\s]+|(?=[\u4e00-\u9fff]))(.*)',text,re.S) if i else None
            if p['format']=='upperLetter': key=p['num'][0];content=text
            elif label: key,content=label.groups()
            else: key=None;content=text
            if key and kind!='true_false':
                options.append({'key':key,'content':content.strip(),'option_id':str(uuid.uuid5(NS,f'{filename}:{n}:{key}'))})
                if p['red']: reds.append(key)
            elif options:
                options[-1]['content']+='\n'+text
                if p['red']: reds.append(options[-1]['key'])
            else: stem.append(text)
        reds=sorted(set(reds))
        if (kind=='multiple' and n==91) or (kind=='single' and n==124):
            for j,o in enumerate(options): o['key']='ABCDEFGH'[j]; o['option_id']=str(uuid.uuid5(NS,f'{filename}:{n}:normalized:{j}'))
            issues.append('原文选项标号重复，已按显示顺序重新编号；须结合原文核对答案')
            if kind=='single': answer=[];reds=[]
        if kind=='true_false':
            if answer is None: answer=check if check is not None else False;issues.append('文字答案缺失，需核对原文')
            if check is not None and check!=answer: issues.append(f'答案冲突：文字答案为{"正确" if answer else "错误"}，勾选标记为{"正确" if check else "错误"}')
        else:
            if not answer: answer=reds; issues.append('无明确文字答案；当前答案仅依据红字提取，必须复核')
            if reds and answer!=reds: issues.append('红字候选 '+ '|'.join(reds)+' 与文字答案 '+ '|'.join(answer)+' 不一致')
            if not (2<=len(options)<=8) or [o['key'] for o in options]!=list('ABCDEFGH'[:len(options)]): issues.append('选项结构需复核，请查阅原文')
            if any(a not in [o['key'] for o in options] for a in answer): issues.append('答案引用了未能解析的选项')
        if kind=='single' and n==58: issues.append('缺少题图：原文提到如下图，但文档没有嵌入图片')
        if kind=='single' and n==109: issues.append('题干末尾疑似混入答案 B，保留原文待复核')
        all_questions.append({'schema_version':'1.0','question_id':str(uuid.uuid5(NS,f'{filename}:{n}')),'base_revision':1,'type':kind,'bank':'HarmonyOS 初级认证','external_id':{'single':'S','multiple':'M','true_false':'J'}[kind]+f'-{n:03}','stem':'\n'.join(stem),'options':options,'answer':answer,'explanation':'','chapter':'','tags':['旧版迁移'],'difficulty':'','status':'needs_review' if issues else 'unreviewed','issues':issues,'sources':[{'file':filename,'sha256':digest,'question_no':n,'answer_text':answer_text,'red_candidates':reds,'checkmark':check,'raw_text':'\n'.join(p['num']+p['text'] for p in raw['body'])}],'attachments':[]})

groups=collections.defaultdict(list)
for q in all_questions:
    key=(q['type'],re.sub(r'\s+','',q['stem']),tuple(re.sub(r'\s+','',o['content']) for o in q['options']))
    groups[key].append(q)
for group in groups.values():
    if len(group)<2: continue
    conflict=len({json.dumps(q['answer']) for q in group})>1
    for q in group:
        q['issues'].append(('同题答案冲突：' if conflict else '重复条目：')+'、'.join(x['external_id'] for x in group if x!=q));q['status']='needs_review'

assert collections.Counter(q['type'] for q in all_questions)=={'single':501,'multiple':170,'true_false':243}
resolutions=json.loads((ROOT/'scripts/answer_resolutions.json').read_text())
for q in all_questions:
    if q['external_id'] not in resolutions: continue
    decision=resolutions[q['external_id']]
    q['sources'].append({'reviewed_at':'2026-10-14','previous_answer':q['answer'],'decision':decision,'migration_issues':q['issues']})
    q['answer']=decision['answer'];q['issues']=[]
    q['status']='verified' if decision['answer'] is not None else 'needs_review'
    if decision['answer'] is None: q['issues']=['尚无足够依据确定答案，原始记录已保留']
out=ROOT/'src-tauri/resources';out.mkdir(parents=True,exist_ok=True)
(out/'seed.json').write_text(json.dumps(all_questions,ensure_ascii=False,indent=2))
report={'files':files,'counts':dict(collections.Counter(q['type'] for q in all_questions)),'total':len(all_questions),'needs_review':sum(q['status']=='needs_review' for q in all_questions),'issues':[{'id':q['external_id'],'issues':q['issues']} for q in all_questions if q['issues']]}
(ROOT/'artifacts').mkdir(exist_ok=True)
(ROOT/'artifacts/迁移核对报告.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in report.items() if k not in ('files','issues')},ensure_ascii=False))
print('Option structure warnings:',[(q['external_id'],[(o['key'],o['content'][:30]) for o in q['options']]) for q in all_questions if any('结构' in x or '引用' in x for x in q['issues'])])
