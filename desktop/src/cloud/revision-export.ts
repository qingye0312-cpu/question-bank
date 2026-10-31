import type {CloudOperationsFile} from '../../shared/sync';

export function operationQuestionIds(operation:CloudOperationsFile['revisions'][number]){
  return [...operation.added,...operation.revised,...operation.removed];
}

export function operationUploader(operation:CloudOperationsFile['revisions'][number]){
  return operation.operator;
}

export function revisionQuestionIds(operations: CloudOperationsFile, revisions: number[]) {
  const selected = new Set(revisions), touched = new Set<string>();
  for (const operation of operations.revisions) {
    if (!selected.has(operation.revision)) continue;
    for (const questionId of operationQuestionIds(operation)) touched.add(questionId);
  }
  return [...touched];
}

export function revisionQuestionSummary(
  operations: CloudOperationsFile,
  revisions: number[],
) {
  const touched = new Set(revisionQuestionIds(operations,revisions));
  const current = new Set(Object.keys(operations.question_index));
  let exportableCount = 0;
  for (const questionId of touched) if (current.has(questionId)) exportableCount += 1;
  return {
    touchedCount: touched.size,
    exportableCount,
    skippedCount: touched.size - exportableCount,
  };
}

export function selectRevisionQuestions(
  operations: CloudOperationsFile,
  revisions: number[],
  latestQuestions: Array<{question_id:string}>,
) {
  const touched = new Set(revisionQuestionIds(operations,revisions));
  const questions = latestQuestions.filter(question => touched.has(question.question_id));
  return {questions, skipped: touched.size - questions.length};
}
