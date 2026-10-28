// Presentation only: the stored explanation, exports and revision history stay intact.
const sourceHeading = /^(?:(?:OpenHarmony|HarmonyOS)\s+)?(?:答案来源|来源(?:说明|记录)?|出处|参考(?:资料|文献|链接)|官方(?:资料(?:状态|固定版本)?|核对依据)|核对(?:状态|记录)|运行接口依据)(?:\s*[（(][^）)]*[）)])?\s*[:：]/i;
const bodyHeading = /^(?:解析|解题思路|参考代码|时间复杂度|空间复杂度|额外空间复杂度|待核对|参考答案|待核对候选)(?:\s*[（(][^）)]*[）)])?\s*[:：]/;
const headingText = (line: string) => line.trim().replace(/^#{1,6}\s+/, '').replace(/\*\*|__/g, '');

export function splitExplanation(explanation: string) {
  const blocks: string[] = [];
  let lines: string[] = [];
  let fence = '';
  const flush = () => {
    const block = lines.join('\n').trim();
    if (block) blocks.push(block);
    lines = [];
  };
  for (const line of explanation.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      lines.push(line);
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && line.trim() === marker[1]) fence = '';
    } else if (marker) {
      fence = marker[1];
      lines.push(line);
    } else if (!line.trim()) {
      flush();
    } else {
      // Labels may follow the preceding paragraph without an empty line.
      const heading = headingText(line);
      if (sourceHeading.test(heading) || bodyHeading.test(heading)) flush();
      lines.push(line);
    }
  }
  flush();

  const body: string[] = [], sources: string[] = [];
  let previousSource = false;
  for (const block of blocks) {
    const heading = headingText(block.split('\n')[0]);
    const isSource: boolean = sourceHeading.test(heading)
      || previousSource && /^(?:[-*]\s+|\d+[.)]\s+)?(?:https?:\/\/|\[[^\]]+\]\(https?:\/\/)/i.test(heading);
    (isSource ? sources : body).push(block);
    previousSource = isSource;
  }
  return {body: body.join('\n\n'), sources};
}

type AnswerContent = {
  explanation: string;
  source_note?: unknown;
  sources?: Record<string, unknown>[];
  status?: string;
};

export function answerPresentation(question: AnswerContent) {
  const {body, sources} = splitExplanation(question.explanation);
  if (typeof question.source_note === 'string' && question.source_note.trim()) sources.push(question.source_note.trim());
  for (const source of question.sources || []) {
    sources.push(typeof source.raw_text === 'string'
      ? [source.file, source.raw_text].filter(Boolean).join('\n\n')
      : JSON.stringify(source, null, 2));
  }
  return {
    body,
    sources: Array.from(new Set(sources.filter(Boolean))),
    needsReview: question.status === 'needs_review' || /^(?:待核对候选|待核对)\s*[:：]/m.test(body),
  };
}
