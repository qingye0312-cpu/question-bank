export type Choice = {key: string; content: string; option_id?: string};
export type QuestionTime = {recorded_at?:string|null;updated_at?:string|null;recorded_at_source?:string};
export type Question = QuestionTime & {schema_version: string; question_id: string; base_revision: number; type: string; stem: string; options: Choice[]; answer: string[] | boolean | null; external_id: string; bank: string; chapter: string; explanation: string; tags: string[]; difficulty: string; applicable_version: string; source_note: string; status: string; issues: string[]; sources: Record<string, unknown>[]; attachments: unknown[]};
export type Bank = {release_name?:string|null;merged_at?:string|null;release_id?:string|null;id: string; name: string; read_only: boolean; version: number; count: number; review_count: number; updated_at: string; provenance: string};
export type Hit = {layer?:string;rowid: number; bank_id: string; bank_name: string; question: Question};
export type Results = {items: Hit[]; has_more: boolean; elapsed_ms: number};
