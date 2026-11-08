// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Decision-model adapter. The host calls the decision model; this module checks the typed answer against
// policy before the agent acts on it, and builds a receipt. No model calls, no vendor keys: the vendor's
// probabilities are inference, and everything here is arithmetic and comparison on what the host received.
// Field names follow vendor docs as far as this export could confirm them; see ../FIELDS.md.
import { createHash } from 'node:crypto';

export const CHECKER = 'curbi-check/decisions 0.1.0';
const SUM_TOLERANCE = 0.01;
// A fractional score is the probability-weighted mean level index; allow this much rounding before calling it inconsistent.
const POSITION_TOLERANCE = 0.05;
const DAY = 86_400_000;

class Malformed extends Error { constructor(msg) { super('malformed: ' + msg); this.code = 'malformed'; } }
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isProb = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
// Every caller input is copied to plain data once, before validation, and only the copy is read: a getter or proxy
// can't return one value to a check and another to the code that uses it. Inputs that aren't plain data are refused.
const snapshot = (v, fail) => { try { return structuredClone(v); } catch { throw fail(); } };

export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  if (v === undefined) return 'null';
  return JSON.stringify(v);
}
export const digest = v => 'sha256:' + createHash('sha256').update(v instanceof Uint8Array ? v : canonical(v)).digest('hex');
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
// systemone probabilities are an object {option: p}.
const probs = o => isObj(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [String(k), v])) : null;
// OpenAI probabilities are an array of {value, probability}, validated at the provider boundary with no label fallback.
// Choice: value is a declared string or boolean choice. Score: value is an integer level index, unique and in range; a
// label, when present, must name that declared level.
function openaiProbs(o, options, type, raw) {
  if (o === undefined) return null;
  if (!Array.isArray(o)) throw new Malformed('probabilities: an array of {value, probability}');
  const out = {};
  for (const e of o) {
    if (!isObj(e)) throw new Malformed('probabilities: entries are objects');
    let k;
    if (type === 'score') {
      if (!Number.isInteger(e.value) || e.value < 0 || e.value >= options.length) throw new Malformed('probabilities: level index out of range');
      if (e.label !== options[e.value]) throw new Malformed('probabilities: each level needs the label of its declared level');
      k = options[e.value];
    } else {
      // Exact membership by raw type: "true" is not the declared boolean true.
      const at = raw.findIndex(c => c === e.value);
      if ((typeof e.value !== 'string' && typeof e.value !== 'boolean') || at < 0) throw new Malformed('probabilities: value is not a declared choice');
      k = options[at];
    }
    if (Object.hasOwn(out, k)) throw new Malformed('probabilities: each entry needs a distinct value');
    out[k] = e.probability;
  }
  return out;
}
// systemone rubric levels only (legend check); OpenAI declarations use declaredOptions, with no fallback.
const label = o => isObj(o) ? o.label ?? o.name ?? o.value ?? o.key : o;
// OpenAI question declarations, per the pinned SDK (openai-node 47bade0 src/resources/decisions.ts): a Choice is
// {value: string | boolean, description?}, 2 to 255 of them, each unique; a Score level is {label: string, description?},
// 2 to 10 of them (guide). Each type reads only its own required field: a label or name on a Choice, or a value or name
// on a level, is an unknown field, so nothing else can stand in for the discriminant. Values whose string forms collide
// ("true" and true) are refused because the record keys options by string (CTO re-review 6717768775).
const DECLARED = { choice: { list: 'choices', key: 'value', min: 2, max: 255 }, score: { list: 'levels', key: 'label', min: 2, max: 10 } };
function declaredOptions(q, id) {
  if (q.type === 'predicate') return { raw: [true, false], options: ['true', 'false'] };
  const d = DECLARED[q.type], list = q[d.list], bad = m => { throw new Malformed(`question ${id}: ${m}`); };
  if (!Array.isArray(list) || list.length < d.min || list.length > d.max) bad(`${d.list}: an array of ${d.min} to ${d.max}`);
  const raw = list.map((o, i) => {
    if (!isObj(o) || !Object.hasOwn(o, d.key)) bad(`${d.list}[${i}] needs ${d.key}`);
    for (const k of Object.keys(o)) if (k !== d.key && k !== 'description') bad(`${d.list}[${i}]: unknown field ${k}`);
    if (Object.hasOwn(o, 'description') && typeof o.description !== 'string') bad(`${d.list}[${i}].description: string`);
    const v = o[d.key];
    if (q.type === 'choice' ? !(typeof v === 'string' || typeof v === 'boolean') : typeof v !== 'string') bad(`${d.list}[${i}].${d.key}: ${q.type === 'choice' ? 'string or boolean' : 'string'}`);
    return v;
  });
  const options = raw.map(String);
  if (new Set(options).size !== options.length) bad(`${d.list}: each ${d.key} must be distinct`);
  return { raw, options };
}
// Raw-byte binding. When the host passes the exact bytes it sent or received, they are authoritative: they are parsed
// here, strictly, and the record is built from that parse, so the digest and the decision cover the same bytes.
// Strict means valid UTF-8 with no BOM, JSON, no duplicate member names (JSON.parse keeps only the last one, which
// could hide a refusal or a probability), and well-formed Unicode in every string. If the host also passes the parsed
// object, it must match the bytes exactly (canonical JSON), or the input is malformed (CTO re-review 6718432732).
function dupScan(text, name) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (c === '[') stack.push(null);
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',') { const top = stack[stack.length - 1]; if (top) top.expectKey = true; }
    else if (c === '"') {
      let j = i + 1; while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1));
        if (top.keys.has(key)) throw new Malformed(`${name}Bytes: duplicate member ${JSON.stringify(key)}`);
        top.keys.add(key); top.expectKey = false;
      }
      i = j;
    }
  }
}
function wellFormed(v, name) {
  if (typeof v === 'string') { if (!v.isWellFormed()) throw new Malformed(`${name}Bytes: lone surrogate in a string`); }
  else if (Array.isArray(v)) v.forEach(x => wellFormed(x, name));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) { wellFormed(k, name); wellFormed(x, name); }
}
function strictParse(bytes, name) {
  if (!(bytes instanceof Uint8Array)) throw new Malformed(`${name}Bytes: a Uint8Array`);
  let text, value;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Malformed(`${name}Bytes: not valid UTF-8`); }
  try { value = JSON.parse(text); } catch { throw new Malformed(`${name}Bytes: not JSON`); }
  dupScan(text, name); wellFormed(value, name);
  return value;
}
function bind(obj, bytes, name) {
  if (bytes === undefined || bytes === null) return { value: snapshot(obj, () => new Malformed(`${name}: plain data only`)), bound: false };
  const parsed = strictParse(bytes, name);
  if (obj !== undefined) {
    const given = snapshot(obj, () => new Malformed(`${name}: plain data only`));
    if (canonical(given) !== canonical(parsed)) throw new Malformed(`${name}Bytes and ${name} disagree`);
  }
  return { value: parsed, bound: true };
}
const argmax = p => Object.keys(p).reduce((a, k) => (a === null || p[k] > p[a] ? k : a), null);

function record(base, fields) {
  return freeze({ object: 'curbi.decision.v1', ...base, ...fields });
}
function binary(p, confidence) {
  if (!isProb(p)) throw new Malformed('probability must be a number in [0,1]');
  return { options: ['true', 'false'], probabilities: { true: p, false: 1 - p }, selected: p >= 0.5 ? 'true' : 'false',
    confidence: isProb(confidence) ? confidence : Math.abs(2 * p - 1) };
}

// Shape 1: POST /v1/systemone (TypeSafe Jev, Fastino GLiDE). request = {model, state, questions:{id:{type, instructions, criteria}}};
// response.answers is an object keyed by the requested question IDs (confirmed from both vendors' pages, #43 6710842943).
// Each raw answer is validated against its vendor's documented schema (Fastino and TypeSafe OpenAPI, per CTO review
// 6710879991) before anything is normalized: required fields, types and domains. Unknown providers are refused.
const SYSTEMONE_REQUIRED = {
  fastino: { noul: ['type', 'noul', 'confidence'], choice: ['type', 'choice', 'confidence', 'probabilities'],
    score: ['type', 'score', 'expected_level', 'confidence', 'probabilities', 'legend'] },
  typesafe: { noul: ['type', 'noul'], choice: ['type', 'choice', 'confidence', 'probabilities'],
    score: ['type', 'score', 'confidence', 'legend', 'probabilities'] }
};
const SCORE_LEVELS = { fastino: 255, typesafe: 10 };
// Choice criteria are an object keyed by option for both vendors. Score criteria are an ordered array (both), or for
// GLiDE also a numeric-key object, which is sorted and reindexed; either way the levels are "0".."N-1".
function systemoneOptions(provider, id, q) {
  if (q.type === 'noul') return ['true', 'false'];
  const c = q.criteria;
  if (q.type === 'choice') {
    if (!isObj(c) || !Object.keys(c).length) throw new Malformed(`question ${id}: Choice criteria are an object keyed by option`);
    return Object.keys(c);
  }
  let n;
  if (Array.isArray(c)) n = c.length;
  else if (provider === 'fastino' && isObj(c) && Object.keys(c).every(k => /^(0|[1-9][0-9]*)$/.test(k))) n = Object.keys(c).length;
  else throw new Malformed(`question ${id}: Score criteria must be an ordered array${provider === 'fastino' ? ' or a numeric-key object' : ''}`);
  if (n < 1 || n > SCORE_LEVELS[provider]) throw new Malformed(`question ${id}: Score takes 1 to ${SCORE_LEVELS[provider]} levels`);
  return Array.from({ length: n }, (_, i) => String(i));
}
function checkSystemoneAnswer(provider, id, q, a, options) {
  for (const k of SYSTEMONE_REQUIRED[provider][q.type]) if (!Object.hasOwn(a, k)) throw new Malformed(`question ${id}: ${provider} ${q.type} answer needs ${k}`);
  if (a.type !== q.type) throw new Malformed(`question ${id} answered as ${a.type}`);
  if (Object.hasOwn(a, 'confidence') && !isProb(a.confidence)) throw new Malformed(`question ${id}: confidence must be a number in [0,1]`);
  if (q.type === 'noul' && !isProb(a.noul)) throw new Malformed(`question ${id}: noul must be a number in [0,1]`);
  if (q.type === 'choice' && typeof a.choice !== 'string') throw new Malformed(`question ${id}: choice must be a string`);
  if (q.type !== 'noul' && !isObj(a.probabilities)) throw new Malformed(`question ${id}: probabilities must be an object`);
  if (q.type === 'score') {
    const top = options.length - 1;
    if (provider === 'fastino' && !(Number.isInteger(a.score) && a.score >= 0 && a.score <= top)) throw new Malformed(`question ${id}: GLiDE score is an integer level index`);
    if (provider === 'typesafe' && !(typeof a.score === 'number' && Number.isFinite(a.score))) throw new Malformed(`question ${id}: TypeSafe score is a number`);
    if (provider === 'fastino' && !(typeof a.expected_level === 'number' && a.expected_level >= 0 && a.expected_level <= top)) throw new Malformed(`question ${id}: expected_level must be a number in 0..${top}`);
    // The legend is built by the vendor from your criteria: an object keyed "0".."N-1" whose values are the requested
    // rubric levels in order. Arrays, other keys, non-string values or a reordered rubric are malformed (per CTO review).
    const rubric = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria).sort((x, y) => x - y).map(k => q.criteria[k]);
    const keys = isObj(a.legend) ? Object.keys(a.legend) : null;
    if (!keys || keys.length !== options.length || !options.every(k => Object.hasOwn(a.legend, k)) ||
        !options.every((k, i) => typeof a.legend[k] === 'string' && a.legend[k] === (typeof rubric[i] === 'string' ? rubric[i] : label(rubric[i]))))
      throw new Malformed(`question ${id}: legend must map each level index to the requested rubric`);
  }
}
export function normalizeSystemone({ provider, request, response, receivedAt, requestBytes, responseBytes }) {
  const rq = bind(request, requestBytes, 'request'), rs = bind(response, responseBytes, 'response');
  request = rq.value; response = rs.value;
  if (!Object.hasOwn(SYSTEMONE_REQUIRED, provider)) throw new Malformed('systemone provider must be fastino or typesafe');
  if (!isObj(request) || typeof request.model !== 'string' || !isObj(request.questions)) throw new Malformed('request needs model and questions');
  if (!isObj(response) || !isObj(response.answers)) throw new Malformed('response needs answers');
  const base = { shape: 'systemone', provider, model: request.model, model_echo: typeof response.model === 'string' ? response.model : null,
    request_digest: digest(rq.bound ? requestBytes : request), response_digest: digest(rs.bound ? responseBytes : response), received_at: receivedAt ?? null,
    bytes_bound: { request: rq.bound, response: rs.bound } };
  const ids = Object.keys(request.questions).sort();
  if (Object.keys(response.answers).length !== ids.length || !Object.keys(response.answers).every(k => Object.hasOwn(request.questions, k)))
    throw new Malformed('answers must match the requested questions exactly');
  return ids.map(id => {
    const q = request.questions[id], a = response.answers[id];
    if (!isObj(q) || !isObj(a)) throw new Malformed(`question ${id} has no answer`);
    if (!['noul', 'choice', 'score'].includes(q.type)) throw new Malformed(`question ${id} type ${q.type}`);
    const options = systemoneOptions(provider, id, q);
    const common = { question_id: id, type: q.type, refused: false };
    if (a.type === 'refusal') return record(base, { ...common, options, probabilities: null, selected: null, confidence: null, refused: true });
    checkSystemoneAnswer(provider, id, q, a, options);
    if (q.type === 'noul') {
      // Jev reports no Noul confidence; the adapter derives abs(2p - 1) and says so.
      const b = binary(a.noul, a.confidence);
      return record(base, { ...common, ...b, confidence_source: Object.hasOwn(a, 'confidence') ? 'vendor' : 'derived' });
    }
    const probabilities = probs(a.probabilities);
    if (q.type === 'choice') return record(base, { ...common, options, probabilities, selected: a.choice, confidence: a.confidence });
    // GLiDE: score is the selected integer level; expected_level is the weighted mean and is checked like a position.
    // TypeSafe: score is the weighted-mean position; the level comes from the probabilities.
    if (provider === 'fastino') return record(base, { ...common, options, probabilities, selected: String(a.score), confidence: a.confidence,
      expected_level: a.expected_level, score_position: a.expected_level });
    return record(base, { ...common, options, probabilities, selected: argmax(probabilities), confidence: a.confidence, expected_level: null, score_position: a.score });
  });
}

// Shape 2: POST /v1/decisions (OpenAI, gpt-6-luna). request = {model, input, questions:[{type, name, instructions, choices|levels}]},
// response.answers = [{type, name, probability | choice, confidence[, probabilities] | ...}]; type "refusal" never acts.
export function normalizeDecisions({ provider, request, response, receivedAt, requestBytes, responseBytes }) {
  const rq = bind(request, requestBytes, 'request'), rs = bind(response, responseBytes, 'response');
  request = rq.value; response = rs.value;
  if (typeof provider !== 'string' || !isObj(request) || typeof request.model !== 'string' || !Array.isArray(request.questions)) throw new Malformed('request needs model and questions');
  // Fastino and TypeSafe answer in the systemone shape only. A decisions-shaped answer labeled as one of them would
  // satisfy a pin meant for that vendor (CAIO bypass corpus, 2026-11-08), so the label is refused here.
  if (Object.hasOwn(SYSTEMONE_REQUIRED, provider)) throw new Malformed(`${provider} answers in the systemone shape; use normalizeSystemone`);
  if (!isObj(response) || !Array.isArray(response.answers)) throw new Malformed('response needs answers');
  const base = { shape: 'decisions', provider, model: request.model, model_echo: typeof response.model === 'string' ? response.model : null,
    request_digest: digest(rq.bound ? requestBytes : request), response_digest: digest(rs.bound ? responseBytes : response), received_at: receivedAt ?? null,
    bytes_bound: { request: rq.bound, response: rs.bound } };
  // Answers correspond one to one, in order, with the requested questions: a duplicate, extra, missing or mismatched
  // answer is malformed, so a later answer can never erase a refusal or a conflicting decision.
  if (response.answers.length !== request.questions.length) throw new Malformed('answers must match the requested questions one to one');
  return request.questions.map((q, i) => {
    if (!isObj(q)) throw new Malformed('question ' + i);
    const a = response.answers[i];
    if (!isObj(a)) throw new Malformed('answer ' + i);
    const id = typeof q.name === 'string' ? q.name : String(i);
    if (typeof q.name === 'string' ? a.name !== q.name : !(a.name === undefined || a.name === null)) throw new Malformed(`answer ${i} does not match question ${id}`);
    if (!['predicate', 'choice', 'score'].includes(q.type)) throw new Malformed(`question ${id} type ${q.type}`);
    // Declarations are validated before any answer is read, refusals included.
    const { raw, options } = declaredOptions(q, id);
    const common = { question_id: id, type: q.type };
    if (a.type === 'refusal') return record(base, { ...common, options, probabilities: null, selected: null, confidence: null, refused: true });
    if (a.type !== q.type) throw new Malformed(`question ${id} answered as ${a.type}`);
    // Choice and Score answers carry a confidence in [0,1]; a predicate's is optional but must be valid when present.
    if (q.type !== 'predicate' ? !isProb(a.confidence) : (Object.hasOwn(a, 'confidence') && !isProb(a.confidence))) throw new Malformed(`question ${id}: confidence must be a number in [0,1]`);
    if (q.type === 'predicate') return record(base, { ...common, refused: false, ...binary(a.probability, a.confidence) });
    // Every OpenAI Score is a numeric mean position, whole numbers included (per CTO re-reviews); it never selects:
    // the level comes from the probabilities and the position is kept as score_position. Choices may be booleans.
    const probabilities = openaiProbs(a.probabilities, options, q.type, raw);
    let selected, extra = {};
    if (q.type === 'choice') {
      const at = raw.findIndex(c => c === a.choice);
      if ((typeof a.choice !== 'string' && typeof a.choice !== 'boolean') || at < 0) throw new Malformed(`question ${id} choice is not a declared choice`);
      selected = options[at];
    }
    else if (typeof a.score === 'number' && Number.isFinite(a.score) && isObj(probabilities)) { selected = argmax(probabilities); extra = { score_position: a.score }; }
    if (typeof selected !== 'string') throw new Malformed(`question ${id} has no selected ${q.type}`);
    return record(base, { ...common, refused: false, options, probabilities, selected, confidence: isProb(a.confidence) ? a.confidence : null, ...extra });
  });
}

const BELOW = ['hand_off', 'escalate', 'deny'];
const QKEYS = ['allowed', 'act_at', 'min_margin', 'pin', 'consensus', 'below', 'calibration', 'max_calibration_age_days', 'require_calibration', 'operations'];
export function compileDecisionPolicy(p) {
  p = snapshot(p, () => new Error('policy: plain data only'));
  if (!isObj(p) || !isObj(p.decisions)) throw new Error('policy.decisions: object');
  const out = {};
  for (const [id, q] of Object.entries(p.decisions)) {
    const bad = m => { throw new Error(`policy.decisions.${id}: ${m}`); };
    if (!isObj(q)) bad('object');
    for (const k of Object.keys(q)) if (!QKEYS.includes(k)) bad('unknown field ' + k);
    // JavaScript callers can pass a present undefined, which the spread below would copy over a safe default
    // (CTO re-review 6717768775). Refuse it here, and in the nested objects, instead of guessing intent: omit the field.
    const noUndefined = (o, path) => { for (const [k, v] of Object.entries(o)) if (v === undefined) bad(`${path}${k}: present but undefined; omit it to use the default`); };
    noUndefined(q, '');
    for (const k of ['consensus', 'calibration']) if (isObj(q[k])) noUndefined(q[k], k + '.');
    if (Array.isArray(q.pin)) q.pin.forEach((x, i) => isObj(x) && noUndefined(x, `pin[${i}].`));
    if (!Array.isArray(q.allowed) || !q.allowed.length || !q.allowed.every(s => typeof s === 'string')) bad('allowed: non-empty list of options');
    if (!(typeof q.act_at === 'number' && q.act_at > 0 && q.act_at <= 1)) bad('act_at: number in (0,1]');
    if (q.min_margin !== undefined && !isProb(q.min_margin)) bad('min_margin: number in [0,1]');
    if (q.below !== undefined && !BELOW.includes(q.below)) bad('below: hand_off, escalate or deny');
    if (q.pin !== undefined && !(Array.isArray(q.pin) && q.pin.length && q.pin.every(x => isObj(x) && typeof x.provider === 'string' && typeof x.model === 'string'))) bad('pin: list of {provider, model}');
    if (q.consensus !== undefined) {
      const c = q.consensus;
      if (!isObj(c) || !Array.isArray(c.models) || !c.models.length || !c.models.every(m => typeof m === 'string')) bad('consensus.models: non-empty list');
      if (!(c.require === 'all' || (Number.isInteger(c.require) && c.require >= 1 && c.require <= c.models.length))) bad('consensus.require: "all" or 1..models');
      if (!isProb(c.max_divergence)) bad('consensus.max_divergence: number in [0,1]');
    }
    if (q.calibration !== undefined) {
      const c = q.calibration;
      if (!isObj(c) || typeof c.dataset !== 'string' || !isProb(c.accuracy_at_threshold) || !Number.isFinite(Date.parse(c.measured_at))) bad('calibration: {dataset, accuracy_at_threshold, measured_at}');
    }
    if (q.require_calibration !== undefined && typeof q.require_calibration !== 'boolean') bad('require_calibration: boolean');
    if (q.max_calibration_age_days !== undefined && !(Number.isFinite(q.max_calibration_age_days) && q.max_calibration_age_days > 0)) bad('max_calibration_age_days: positive number');
    if (q.operations !== undefined && !(isObj(q.operations) && Object.entries(q.operations).every(([k, v]) => q.allowed.includes(k) && typeof v === 'string'))) bad('operations: {allowed option: operation}');
    out[id] = { min_margin: 0, below: 'hand_off', max_calibration_age_days: 30, require_calibration: q.operations !== undefined, ...structuredClone(q) };
  }
  return freeze({ decisions: out });
}

function shapeOk(r, cfg) {
  const p = r.probabilities;
  if (!isObj(p)) return true; // absence is reported as margin_unavailable, not as an inconsistency
  const keys = Object.keys(p);
  if (keys.length !== r.options.length || !r.options.every(o => Object.hasOwn(p, o)) || !keys.every(k => isProb(p[k]))) return false;
  if (Math.abs(keys.reduce((s, k) => s + p[k], 0) - 1) > SUM_TOLERANCE) return false;
  if (!r.options.includes(r.selected) || !cfg.allowed.includes(r.selected)) return false;
  if (r.score_position !== undefined) {
    const pos = r.score_position, mean = r.options.reduce((m, o, i) => m + i * p[o], 0);
    if (!(pos >= 0 && pos <= r.options.length - 1) || Math.abs(pos - mean) > POSITION_TOLERANCE) return false;
  }
  return keys.every(k => p[k] <= p[r.selected] + 1e-12);
}
function assess(r, cfg) {
  if (r.refused) return ['refused'];
  const reasons = [];
  if (cfg.pin && !cfg.pin.some(x => x.provider === r.provider && x.model === r.model)) reasons.push('unpinned_model');
  if (!shapeOk(r, cfg)) return [...reasons, 'inconsistent'];
  if (!isObj(r.probabilities)) return [...reasons, 'margin_unavailable'];
  const top = r.probabilities[r.selected], second = Math.max(0, ...r.options.filter(o => o !== r.selected).map(o => r.probabilities[o]));
  if (top < cfg.act_at) reasons.push('below_threshold');
  if (top - second < cfg.min_margin) reasons.push('below_margin');
  return reasons;
}
function calibrationReasons(cfg, now) {
  if (!cfg.require_calibration) return [];
  if (!cfg.calibration) return ['calibration_missing'];
  if (!Number.isFinite(now) || now - Date.parse(cfg.calibration.measured_at) > cfg.max_calibration_age_days * DAY) return ['calibration_stale'];
  return [];
}
const unique = a => [...new Set(a)];

// route(policy, questionId, records, {now}) -> {outcome: act|escalate|hand_off|deny, selected, reasons[, next_model]}.
// The host makes every model call; this only decides what the records it already has allow.
export function route(policy, questionId, records, { now } = {}) {
  const cfg = policy?.decisions?.[questionId];
  if (!cfg) throw new Error('no policy for decision ' + questionId);
  const recs = records.filter(r => r.question_id === questionId);
  const fallback = cfg.below === 'deny' ? 'deny' : 'hand_off';
  if (!recs.length) return { outcome: fallback, selected: null, reasons: ['no_record'] };
  const cal = calibrationReasons(cfg, now);
  if (!cfg.consensus) {
    if (recs.length !== 1) return { outcome: fallback, selected: null, reasons: ['ambiguous_records'] };
    const reasons = unique([...assess(recs[0], cfg), ...cal]);
    return { outcome: reasons.length ? fallback : 'act', selected: recs[0].selected, reasons };
  }
  const { models, require, max_divergence } = cfg.consensus;
  const reasons = [];
  for (const r of recs) { reasons.push(...assess(r, cfg)); if (!models.includes(r.model)) reasons.push('unpinned_model'); }
  // Agreement is counted in distinct models: a second record from one model never stands in for another model.
  if (new Set(recs.map(r => r.provider + '\u0000' + r.model)).size !== recs.length) reasons.push('duplicate_model');
  const voters = new Map();
  for (const r of recs) if (r.selected !== null) voters.set(r.selected, (voters.get(r.selected) ?? new Set()).add(r.model));
  const counts = new Map([...voters].map(([k, v]) => [k, v.size]));
  const selected = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const needed = require === 'all' ? models.length : require;
  const seen = new Set(recs.map(r => r.model));
  const missing = models.filter(m => !seen.has(m));
  if (missing.length && (counts.get(selected) ?? 0) < needed) {
    const why = unique([...reasons, 'consensus_incomplete', ...cal]);
    return cfg.below === 'escalate' ? { outcome: 'escalate', selected, reasons: why, next_model: missing[0] } : { outcome: fallback, selected, reasons: why };
  }
  if ((counts.get(selected) ?? 0) < needed || (require === 'all' && counts.size > 1)) reasons.push('consensus_disagreement');
  const ps = recs.filter(r => r.selected === selected && isObj(r.probabilities)).map(r => r.probabilities[selected]);
  if (ps.length > 1 && Math.max(...ps) - Math.min(...ps) > max_divergence) reasons.push('consensus_divergence');
  const why = unique([...reasons, ...cal]);
  return { outcome: why.length ? fallback : 'act', selected, reasons: why };
}

// One receipt per typed decision. Unsigned until production signing is qualified. Vendors don't sign responses, so this
// proves what the host received and what this check decided, not what the vendor computed.
export function decisionReceipt({ policy, questionId, records, result, prev = null }) {
  const body = {
    object: 'curbi.decision-receipt.v1', v: 1, question_id: questionId, checker: CHECKER,
    policy_digest: digest(policy.decisions[questionId]),
    record_digests: records.filter(r => r.question_id === questionId).map(r => digest(r)),
    outcome: result.outcome, selected: result.selected, reasons: [...result.reasons],
    ...(result.next_model ? { next_model: result.next_model } : {}),
    prev_receipt_digest: prev, signed: false, provider_signed: false,
    does_not_prove: 'that the vendor computed these probabilities, that they are calibrated, or that the decision is correct'
  };
  return freeze({ ...body, receipt_digest: digest(body) });
}

// Output link: an action the agent proposes must match the decision that was checked.
export function checkAction(policy, questionId, result, operation) {
  const cfg = policy.decisions[questionId];
  const needs = Object.entries(cfg.operations ?? {}).filter(([, op]) => op === operation).map(([o]) => o);
  if (!needs.length) return [];
  if (result.outcome !== 'act') return [{ rule: 'decision:not_acted', why: `Decision ${questionId} was not acted (${result.outcome}); ${operation} needs an acted decision.` }];
  if (needs.includes(result.selected)) return [];
  return [{ rule: 'decision:contradicted', why: `Decision ${questionId} selected "${result.selected}"; ${operation} needs ${needs.map(o => `"${o}"`).join(' or ')}.` }];
}
