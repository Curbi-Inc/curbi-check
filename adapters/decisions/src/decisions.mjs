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
      if (e.label !== undefined && e.label !== options[e.value]) throw new Malformed('probabilities: label does not match its level index');
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
const label = o => isObj(o) ? o.label ?? o.name ?? o.value ?? o.key : o;
const argmax = p => Object.keys(p).reduce((a, k) => (a === null || p[k] > p[a] ? k : a), null);

function record(base, fields) {
  return freeze({ object: 'curbi.decision.v1', ...base, ...fields });
}
function binary(p, confidence) {
  if (!isProb(p)) throw new Malformed('probability must be a number in [0,1]');
  return { options: ['true', 'false'], probabilities: { true: p, false: 1 - p }, selected: p >= 0.5 ? 'true' : 'false',
    confidence: isProb(confidence) ? confidence : Math.abs(2 * p - 1) };
}

// Shape 1: POST /v1/systemone (TypeSafe Jev, Fastino GLiDE). request = {model, state, questions:{id:{type, instructions, criteria}}}.
// The host passes the per-question answers as response.answers; the response envelope is not yet confirmed (FIELDS.md).
export function normalizeSystemone({ provider, request, response, receivedAt, requestBytes, responseBytes }) {
  if (typeof provider !== 'string' || !isObj(request) || typeof request.model !== 'string' || !isObj(request.questions)) throw new Malformed('request needs model and questions');
  if (!isObj(response) || !isObj(response.answers)) throw new Malformed('response needs answers');
  const base = { shape: 'systemone', provider, model: request.model, model_echo: typeof response.model === 'string' ? response.model : null,
    request_digest: digest(requestBytes ?? request), response_digest: digest(responseBytes ?? response), received_at: receivedAt ?? null };
  const ids = Object.keys(request.questions).sort();
  if (Object.keys(response.answers).length !== ids.length || !Object.keys(response.answers).every(k => Object.hasOwn(request.questions, k)))
    throw new Malformed('answers must match the requested questions exactly');
  return ids.map(id => {
    const q = request.questions[id], a = response.answers[id];
    if (!isObj(q) || !isObj(a)) throw new Malformed(`question ${id} has no answer`);
    // Supported types only, and the answer's own discriminant must match its question before anything is coerced.
    // TypeSafe answers carry `type` (primary Choice contract, per CTO review); GLiDE's may omit it, but if present it must match.
    if (!['noul', 'choice', 'score'].includes(q.type)) throw new Malformed(`question ${id} type ${q.type}`);
    const common = { question_id: id, type: q.type, refused: false };
    // Criteria: an object keyed by option, or an array. An array gives Choice its labels and Score its indexed levels.
    const options = q.type === 'noul' ? ['true', 'false'] : Array.isArray(q.criteria) ? (q.type === 'score' ? q.criteria.map((_, i) => String(i)) : q.criteria.map(c => String(label(c))))
      : isObj(q.criteria) ? Object.keys(q.criteria) : null;
    if (a.type !== undefined || provider === 'typesafe') {
      if (a.type === 'refusal') return record(base, { ...common, options, probabilities: null, selected: null, confidence: null, refused: true });
      if (a.type !== q.type) throw new Malformed(`question ${id} answered as ${a.type}`);
    }
    if (q.type === 'noul') return record(base, { ...common, ...binary(a.noul, a.confidence) });
    const probabilities = probs(a.probabilities);
    if (!options?.length || !probabilities) throw new Malformed(`question ${id} needs criteria and probabilities`);
    // A Score is an integer level index (GLiDE) or a fractional position (TypeSafe, per review). A fractional position
    // never selects: the level comes from the probabilities, and the position is kept as score_position.
    let selected, extra = {};
    // GLiDE's score is an integer level index. TypeSafe's is a mean position, whole numbers included (per CTO re-review).
    if (q.type === 'choice') selected = a.choice;
    else if (provider === 'fastino') { if (Number.isInteger(a.score)) selected = String(a.score); }
    else if (typeof a.score === 'number' && Number.isFinite(a.score)) { selected = argmax(probabilities); extra = { score_position: a.score }; }
    if (typeof selected !== 'string') throw new Malformed(`question ${id} has no selected ${q.type}`);
    return record(base, { ...common, options, probabilities, selected,
      confidence: isProb(a.confidence) ? a.confidence : null, ...(q.type === 'score' ? { expected_level: typeof a.expected_level === 'number' ? a.expected_level : null, ...extra } : {}) });
  });
}

// Shape 2: POST /v1/decisions (OpenAI, gpt-6-luna). request = {model, input, questions:[{type, name, instructions, choices|levels}]},
// response.answers = [{type, name, probability | choice, confidence[, probabilities] | ...}]; type "refusal" never acts.
export function normalizeDecisions({ provider, request, response, receivedAt, requestBytes, responseBytes }) {
  if (typeof provider !== 'string' || !isObj(request) || typeof request.model !== 'string' || !Array.isArray(request.questions)) throw new Malformed('request needs model and questions');
  if (!isObj(response) || !Array.isArray(response.answers)) throw new Malformed('response needs answers');
  const base = { shape: 'decisions', provider, model: request.model, model_echo: typeof response.model === 'string' ? response.model : null,
    request_digest: digest(requestBytes ?? request), response_digest: digest(responseBytes ?? response), received_at: receivedAt ?? null };
  // Answers correspond one to one, in order, with the requested questions: a duplicate, extra, missing or mismatched
  // answer is malformed, so a later answer can never erase a refusal or a conflicting decision.
  if (response.answers.length !== request.questions.length) throw new Malformed('answers must match the requested questions one to one');
  return request.questions.map((q, i) => {
    if (!isObj(q)) throw new Malformed('question ' + i);
    const a = response.answers[i];
    if (!isObj(a)) throw new Malformed('answer ' + i);
    const id = typeof q.name === 'string' ? q.name : String(i);
    if (typeof q.name === 'string' ? a.name !== q.name : a.name !== undefined) throw new Malformed(`answer ${i} does not match question ${id}`);
    if (!['predicate', 'choice', 'score'].includes(q.type)) throw new Malformed(`question ${id} type ${q.type}`);
    const raw = q.type === 'predicate' ? [true, false] : (q.type === 'choice' ? q.choices : q.levels)?.map(o => isObj(o) ? label(o) : o);
    const options = raw?.map(String);
    if (!Array.isArray(options) || !options.length) throw new Malformed(`question ${id} needs options`);
    const common = { question_id: id, type: q.type };
    if (a.type === 'refusal') return record(base, { ...common, options, probabilities: null, selected: null, confidence: null, refused: true });
    if (a.type !== q.type) throw new Malformed(`question ${id} answered as ${a.type}`);
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
  if (!isObj(p) || !isObj(p.decisions)) throw new Error('policy.decisions: object');
  const out = {};
  for (const [id, q] of Object.entries(p.decisions)) {
    const bad = m => { throw new Error(`policy.decisions.${id}: ${m}`); };
    if (!isObj(q)) bad('object');
    for (const k of Object.keys(q)) if (!QKEYS.includes(k)) bad('unknown field ' + k);
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
