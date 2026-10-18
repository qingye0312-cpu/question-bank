'use strict';
const {gunzipSync,gzipSync}=require('node:zlib');
const {VERSION,LIMITS,UUID,HASH,OPENID,sha256,object,HttpError,fail,exact}=require('./common.cjs');
function strictBase64(text, maxBytes) {
  if (typeof text !== 'string' || !text.length || text.length > Math.ceil(maxBytes / 3) * 4
    || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))
    fail(422, 'PACKAGE_INVALID', 'Base64 内容无效或超过大小限制');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== text) fail(422, 'PACKAGE_INVALID', 'Base64 内容无效');
  return bytes;
}
function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail(422, 'PACKAGE_INVALID', '题库必须使用 UTF-8 编码'); }
}
function jsonBody(event, maxBytes) {
  if (typeof event.body !== 'string') fail(400, 'JSON_REQUIRED', '请求必须包含 JSON 文本');
  if (Buffer.byteLength(event.body) > maxBytes * (event.isBase64Encoded === true ? 1.34 : 1))
    fail(413, 'REQUEST_TOO_LARGE', '请求过大，已保留本地记录，不会自动拆包');
  const text = event.isBase64Encoded === true ? utf8(strictBase64(event.body, maxBytes)) : event.body;
  if (Buffer.byteLength(text) > maxBytes) fail(413, 'REQUEST_TOO_LARGE', '请求过大，已保留本地记录，不会自动拆包');
  try { return JSON.parse(text); } catch { fail(400, 'JSON_INVALID', '请求不是有效 JSON'); }
}
function validDate(value) { return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)); }

function decodeUpload(envelope, parseDelta, parseModelReply) {
  if (!exact(envelope, ['format', 'encoding', 'uncompressed_size', 'sha256', 'data'])
    || envelope.format !== 'qbank-upload-1' || envelope.encoding !== 'gzip+base64'
    || !HASH.test(envelope.sha256) || !Number.isSafeInteger(envelope.uncompressed_size)
    || envelope.uncompressed_size < 1 || envelope.uncompressed_size > LIMITS.expandedBytes)
    fail(422, 'PACKAGE_INVALID', '请使用 gzip + Base64 增量包格式');
  const compressed = strictBase64(envelope.data, LIMITS.compressedBytes);
  let raw;
  try { raw = gunzipSync(compressed, { maxOutputLength: Math.min(envelope.uncompressed_size, LIMITS.expandedBytes) }); }
  catch { fail(422, 'PACKAGE_INVALID', '压缩包损坏或解压后超过大小限制'); }
  if (raw.length !== envelope.uncompressed_size || sha256(raw) !== envelope.sha256)
    fail(422, 'PACKAGE_INVALID', '增量包大小或摘要校验失败');
  let parsed;
  try { parsed = parseDelta(utf8(raw)); }
  catch (error) { if (error instanceof HttpError) throw error; fail(422, 'PACKAGE_INVALID', '标准增量包内容校验失败'); }
  const { delta, questions } = parsed;
  if (!UUID.test(delta.bank_id) || !UUID.test(delta.batch_id) || questions.length > LIMITS.questions
    || !validDate(delta.created_at)) fail(422, 'PACKAGE_INVALID', '题库身份、批次日期或题数无效');
  const fields = ['schema_version', 'question_id', 'base_revision', 'type', 'stem', 'options', 'answer', 'bank',
    'external_id', 'chapter', 'tags', 'explanation', 'status', 'difficulty', 'applicable_version', 'source_note', 'issues', 'sources', 'attachments'];
  for (const q of questions) {
    if (!fields.every(k=>Object.hasOwn(q,k)) || Object.keys(q).some(k=>![...fields,'recorded_at','recorded_at_source','updated_at'].includes(k)) || q.status !== 'unreviewed' || !Number.isSafeInteger(q.base_revision) || q.base_revision < 1 || q.bank !== delta.name
      || q.options.some(o => !exact(o, ['key', 'content', 'option_id']))
      || new Set(q.options.map(o => o.option_id)).size !== q.options.length
      || q.sources.length !== 1) fail(422, 'QUESTION_INVALID', '只接受保留模型来源的新题，不接受额外附件或已审核状态');
    const source = q.sources[0];
    if (!exact(source, ['kind', 'model', 'answer_origin', 'warnings', 'recorded_at'])
      || source.kind !== 'model_reply' || !validDate(source.recorded_at))
      fail(422, 'QUESTION_INVALID', '模型名称、版本和录入时间记录不完整');
    try { parseModelReply(JSON.stringify({ format: 'qbank-photo-question-1', type: q.type, stem: q.stem,
      options: q.options.map(({ key, content }) => ({ key, content })), answer: q.answer, explanation: q.explanation,
      model: source.model, answer_origin: source.answer_origin, warnings: source.warnings })); }
    catch { fail(422, 'QUESTION_INVALID', '题目或模型来源记录校验失败'); }
  }
  // Normalize compression server-side: the stored package never contains extra gzip members/trailing data.
  const canonical = { ...envelope, data: gzipSync(raw).toString('base64') };
  return { delta, envelope: canonical };
}
function receipt(record) {
  return { submission_id: record.submission_id, bank_id: record.bank_id, batch_id: record.batch_id,
    sha256: record.sha256, payload_sha256: record.payload_sha256, question_count: record.question_count,
    status: record.status, accepted_at: record.accepted_at };
}


module.exports={decodeUpload,jsonBody,receipt};
