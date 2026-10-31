import type {CloudOperationsFile} from '../../shared/sync';

export function operationQuestionIds(operation:CloudOperationsFile['revisions'][number]){
  if('questions' in operation)return operation.questions.map(question => question.question_id);
  return [...operation.added,...operation.revised,...operation.removed];
}

export function operationUploader(operation:CloudOperationsFile['revisions'][number]){
  return 'operator' in operation ? operation.operator : operation.uploader;
}

export function revisionQuestionIds(operations: CloudOperationsFile, revisions: number[]) {
  const selected = new Set(revisions), touched = new Set<string>();
  for (const operation of operations.revisions) {
    if (!selected.has(operation.revision)) continue;
    for (const questionId of operationQuestionIds(operation)) touched.add(questionId);
  }
  return [...touched];
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
