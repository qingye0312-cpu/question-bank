import type {CloudOperationsFile} from '../../shared/sync';

export function selectRevisionQuestions(
  operations: CloudOperationsFile,
  revisions: number[],
  latestQuestions: Array<{question_id:string}>,
) {
  const selected = new Set(revisions), touched = new Set<string>();
  for (const operation of operations.revisions) {
    if (!selected.has(operation.revision)) continue;
    for (const question of operation.questions) touched.add(question.question_id);
  }
  const questions = latestQuestions.filter(question => touched.has(question.question_id));
  return {questions, skipped: touched.size - questions.length};
}
