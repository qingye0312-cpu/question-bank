import {useMemo} from 'react';
import {answerPresentation} from '../shared/answer-presentation';
import type {Question} from './types';
import {FormulaText} from './formula';

export function QuestionExplanation({question, className = ''}: {question: Question; className?: string}) {
  const {body, sources, needsReview} = useMemo(() => answerPresentation(question), [question]);
  return <div className={`question-explanation ${className}`}>
    {(body || needsReview) && <div className="explanation-heading"><span>解析</span>{needsReview && <small className="answer-review-status">待核对</small>}</div>}
    {body && <p className="explanation-text"><FormulaText text={body}/></p>}
    <details key={`${question.question_id}:${question.base_revision}`} className="answer-sources">
      <summary>答案来源</summary>
      <div className="answer-source-content">{sources.length ? sources.map((source, index) => <pre key={index}>{source}</pre>) : <p>暂无来源记录</p>}</div>
    </details>
  </div>;
}
