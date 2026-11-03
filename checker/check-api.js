// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Curbi Check API v1: POST /api/v1/check. Checks AI replies against a business policy and,
// when supplied, against the record of what the system actually did.
// Stateless: nothing is stored or logged, and there are no model calls.
// Untrusted input: policies carry literal phrases, never regex, so a caller cannot submit a
// catastrophic pattern. Every size is capped.
// Node/tests load receipts.js here; the worker and browser concatenate it ahead of this file.
if (typeof module !== 'undefined' && typeof verifyReceipts === 'undefined') Object.assign(globalThis, require('./receipts.js'));
const CHECK_LIMITS = { bodyBytes: 65536, cases: 50, replyChars: 4000, prices: 50, aliases: 8, forbid: 50, phrases: 20, phraseChars: 80, actions: 40, effects: 100, facts: 20 };
const CHECK_VERSION = '2026-11-01', CHECK_VERSIONS = ['2026-10-27', '2026-11-01'];
const CK_NEG = /(?:\bno\b|\bnot\b|n't\b|\bnever\b|\bwithout\b|\bcannot\b)/i;
// Phrases that contain a negation word but do not negate what follows ("not only do we guarantee").
const CK_NOT_NEG = /\b(?:not only|not just|no doubt|no question|without (?:a )?doubt|never (?:been )?(?:more|better|easier)|(?:never|not) (?:fail|fails|forget|forgets|neglect|neglects|cease|ceases) to|\w+n't not|not not|cannot not|never not)\b/gi;
const CK_CLAUSE = /[.,;:!?]|\b(?:and|but|if|when)\b/i;
// Amounts: "$39", "-$39", "USD 39", "US$39", "39 dollars", "39 USD". Text is NFKC-normalized first, so "＄39" is "$39".
// A number never starts inside a digit run: without the lookbehind, "1,1,1,..." was retried from every digit after a
// comma, each try scanning to the end of the run (quadratic). It also keeps the whole number together, so the tail of
// "1,000,...,000,049 dollars" is never read as 49 (a bounded run would have been: a silent pass, caught in review).
const CK_NUM = String.raw`(?<!\d|\d,)(\d[\d,]*\d|\d)(?:\.(\d+))?`;
const CK_WELLFORMED = /^(?:\d{1,3}(?:,\d{3})+|\d+)$/;
const CK_AMOUNT = new RegExp(String.raw`(-\s?)?(?:\$|\bUS\$|\bUSD\s?)\s?` + CK_NUM + String.raw`|(-\s?)?\b` + CK_NUM + String.raw`\s?(?:(?:dollars?|bucks|USD)\b|\$)`, 'gi');
// Another currency where the policy prices in USD is a mismatch even when the number matches (CMO ruling: price:mismatch, no new rule).
const CK_FOREIGN = new RegExp(String.raw`(?:€|£|¥|\bEUR\s?|\bGBP\s?)\s?` + CK_NUM + String.raw`|\b` + CK_NUM + String.raw`\s?(?:€|£|(?:euros?|EUR|pounds?|GBP)\b)`, 'gi');
// Action claims, active ("I've booked", "we had sent") and passive ("you're booked", "it's been refunded").
const CK_ACTED = /\b(?:(?:I|we)(?:'ve|'d|\s+have|\s+had)?|you(?:'re|\s+are|'ve\s+been|\s+have\s+been)|(?:it|this|that|everything)(?:'s\s+been|\s+has\s+been|'s|\s+is|\s+was))\s+(?:just\s+|already\s+|now\s+|all\s+)?([a-z]+)\b/gi;
// Completion claims the subject+verb pattern above misses (adversarial pass, PR #155). Each yields {index, 0, 1: verb}
// so the same record/receipt logic applies. Negated, future and question forms do not match by construction.
const CK_DONE_VERBS = 'processed|issued|completed|sent|finalized|confirmed|applied|made|done';
function ckMoreActed(text, actions) {
  const out = [], NOT_THE_ACT = '(?!\\s+(?:request|requests|form|policy|policies|status|window|option|options|eligibility|process|link|amount|fee|terms))', esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const verb of Object.keys(actions)) {
    const stem = verb.replace(/e?d$/, ''), nouns = [...new Set([stem, stem.replace(/(.)\1$/, '$1'), stem + 'ing', stem + 'ation', stem.replace(/(.)\1$/, '$1') + 'ation'])].map(esc).join('|'), v = esc(verb);
    const rx = [
      // passive with a person or thing as subject: "You were refunded", "It got refunded"
      new RegExp(`\\b(?:you|it|this|that|everything|your\\s+\\w+)\\s+(?:were|was|got|have\\s+been|has\\s+been)\\s+(?:just\\s+|already\\s+|now\\s+|fully\\s+)?(${v})\\b`, 'gi'),
      // coordinated or adverbial first person: "I went ahead and refunded", "we successfully refunded"
      new RegExp(`\\b(?:I|we)\\s+(?:went\\s+ahead\\s+and|also|then|finally|successfully|quickly)\\s+(${v})\\b`, 'gi'),
      // bare or after a colon/dash, ending the sentence: "Refunded!", "I did it: refunded."
      new RegExp(`(?:^|[.!?\\n]\\s*|[:\\u2014\\u2013-]\\s*)(?:(?:all|already|fully)\\s+)?(${v})\\s*(?=[.!]|$)`, 'gim'),
      // first person + completion verb + noun: "I have issued the refund", "I processed your refund"
      new RegExp(`\\b(?:I|we)(?:'ve|\\s+have|\\s+had)?\\s+(?:just\\s+|already\\s+|now\\s+)?(?:${CK_DONE_VERBS})\\s+(?:the|your|a|an|this|that|its)?\\s*(?:full\\s+)?(${nouns})\\b${NOT_THE_ACT}`, 'gi'),
      // noun + passive completion: "Your refund has been processed", "The refund was issued"
      new RegExp(`\\b(?:the|your|a|this|that)\\s+(?:full\\s+)?(${nouns})${NOT_THE_ACT}\\s+(?:has\\s+been|have\\s+been|was|is|'s\\s+been|got)\\s+(?:just\\s+|already\\s+|now\\s+|fully\\s+)?(?:${CK_DONE_VERBS})\\b`, 'gi'),
      // noun, then a one-word verdict: "The refund? Done.", "Refund: completed."
      new RegExp(`\\b(${nouns})\\s*[?:\\u2014\\u2013-]\\s*(?:all\\s+)?(?:done|completed|complete|processed|issued|sent)\\s*(?=[.!]|$)`, 'gim'),
    ];
    for (const r of rx) for (const m of text.matchAll(r)) if (!/\b(?:once|if|when|whenever|after|until|before|unless|soon\s+as)\s*$/i.test(text.slice(Math.max(0, m.index - 20), m.index))) out.push({ index: m.index, 0: m[0], 1: verb, length: m[0].length });
  }
  return out;
}
const CK_KINDS = { time: /\b\d{1,2}(?::\d\d)?\s?(?:am|pm)\b/i, money: /\$\s?\d[\d,]*(?:\.\d{1,2})?/, date: /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b\d{1,2}\/\d{1,2}\b/i };
const ckEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Negated only if a negation word sits in the same clause within the four words before the match.
const ckNegated = (t, at) => {
  const clause = t.slice(Math.max(0, at - 60), at).split(CK_CLAUSE).pop().replace(CK_NOT_NEG, ' ');
  return CK_NEG.test(clause.trim().split(/\s+/).slice(-4).join(' '));
};
// Invisible characters are dropped and compatibility forms (fullwidth, ligatures) folded; common
// Cyrillic/Greek look-alikes map to Latin. map[i] is the original offset of normalized char i,
// so every span reported points into the caller's original text.
const CK_INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/;
const CK_CONFUSABLE = { 'а':'a','е':'e','о':'o','р':'p','с':'c','у':'y','х':'x','і':'i','ј':'j','ѕ':'s','ԁ':'d','ӏ':'l','А':'A','В':'B','Е':'E','К':'K','М':'M','Н':'H','О':'O','Р':'P','С':'C','Т':'T','Х':'X','Ѕ':'S','І':'I','Ј':'J','Α':'A','Β':'B','Ε':'E','Ζ':'Z','Η':'H','Ι':'I','Κ':'K','Μ':'M','Ν':'N','Ο':'O','Ρ':'P','Τ':'T','Υ':'Y','Χ':'X','ο':'o','ν':'v','‘':"'",'’':"'",'ʼ':"'",'＇':"'" };
// Fix 2–3 (PR #155 attack pass): accents are stripped (guarantée → guarantee), decimal digits from other scripts
// map to ASCII ($٩٩ → $99), lowercase Greek look-alikes fold (gυarantee), letter-spaced words collapse
// (g-u-a-r-a-n-t-e-e → guarantee) and spelled amounts before a currency word become digits (ninety-nine dollars → 99 dollars).
const CK_GREEK = { 'α':'a','ε':'e','ι':'i','κ':'k','ν':'v','ο':'o','ρ':'p','τ':'t','υ':'u','χ':'x','ω':'w',
  // Look-alike sweep (adversarial review #2: "gµarantee"; µ folds to Greek μ under NFKC). UTS #39 confusables for Latin lowercase.
  'μ':'u','ʋ':'u','ս':'u','ɡ':'g','ց':'g','ɑ':'a','ⱥ':'a','г':'r','ᴦ':'r','ո':'n','п':'n','т':'t','є':'e','ҽ':'e','℮':'e' };
const CK_DIGIT_ZEROS = [0x660,0x6F0,0x7C0,0x966,0x9E6,0xA66,0xAE6,0xB66,0xBE6,0xC66,0xCE6,0xD66,0xDE6,0xE50,0xED0,0xF20,0x1040,0x1090,0x17E0,0x1810,0x1946,0x19D0,0xA620,0xA8D0,0xA900,0xAA50,0xABF0];
const ckDigit = ch => { const c = ch.codePointAt(0); for (const z of CK_DIGIT_ZEROS) if (c >= z && c <= z + 9) return String(c - z); return null; };
const CK_NUM_WORDS = { zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90 };
const CK_SPELLED = new RegExp(String.raw`\b((?:(?:${Object.keys(CK_NUM_WORDS).join('|')}|hundred|thousand)(?:[\s-]+(?:and[\s-]+)?|(?=\s?(?:dollars?|bucks|usd|cents?)\b)))+)(?=\s?(?:dollars?|bucks|usd|cents?)\b)`, 'gi');
const ckWordsToNumber = phrase => { let total = 0, cur = 0, any = false; for (const w of phrase.toLowerCase().split(/[\s-]+/).filter(x => x && x !== 'and')) { if (w in CK_NUM_WORDS) { cur += CK_NUM_WORDS[w]; any = true; } else if (w === 'hundred') { cur = (cur || 1) * 100; any = true; } else if (w === 'thousand') { total += (cur || 1) * 1000; cur = 0; any = true; } } return any ? total + cur : null; };
function ckRewrite(st, rx, fn) {   // replace matches in st.norm, keeping every output char mapped into the original text
  let norm = '', map = [], end = [], at = 0;
  for (const m of st.norm.matchAll(rx)) {
    const r = fn(m); if (r === null) continue;
    norm += st.norm.slice(at, m.index); map.push(...st.map.slice(at, m.index)); end.push(...st.end.slice(at, m.index));
    const a = st.map[m.index], b = st.end[m.index + m[0].length - 1];
    for (let k = 0; k < r.length; k++) { norm += r[k]; map.push(a); end.push(b); }
    at = m.index + m[0].length;
  }
  norm += st.norm.slice(at); map.push(...st.map.slice(at, st.norm.length)); end.push(...st.end.slice(at, st.norm.length));
  return { norm, map, end };
}
function ckNormalize(text) {
  let norm = '', map = [], end = [], i = 0;
  for (const ch of text) {
    const at = i; i += ch.length;
    if (CK_INVISIBLE.test(ch)) continue;
    const digit = ckDigit(ch);
    const nk = ch.normalize('NFKC'), folded = digit ?? CK_CONFUSABLE[ch] ?? CK_GREEK[ch] ?? CK_GREEK[nk] ?? nk;   // µ only becomes μ after NFKC
    const out = folded.normalize('NFD').replace(/\p{M}/gu, '') || folded;
    for (const o of out) { norm += o; for (let k = 0; k < o.length; k++) { map.push(at); end.push(i); } }
  }
  let st = { norm, map, end };
  st = ckRewrite(st, /(?<![A-Za-z])(?:[A-Za-z][-._](?=[A-Za-z]))+[A-Za-z](?![A-Za-z])|(?<![A-Za-z])(?:[A-Za-z] (?=[A-Za-z]))+[A-Za-z](?![A-Za-z])/g, m => { const letters = m[0].replace(/[-._ ]/g, ''); return letters.length >= 4 ? letters : null; });
  st = ckRewrite(st, CK_SPELLED, m => { const v = ckWordsToNumber(m[1]); return v === null ? null : String(v) + (/\s$/.test(m[1]) ? ' ' : ''); });
  ({ norm, map, end } = st);
  map.push(text.length); end.push(text.length);
  return { norm, from: (a, b) => [map[a], b > a ? end[b - 1] : map[a]] };
}
const ckStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
// Item names (pass 2, overlapping names): normalized exactly like reply text (Crème matches "Creme", Prо with a
// Cyrillic о matches "Pro"), spaces or hyphens between words match any run of them ("Pro-Plus", "Pro  Plus"), and
// edges are letter/digit lookarounds instead of \b, which never matches after a trailing symbol ("Pro+", "C++").
const CK_NAME_GAP = String.raw`[\s\-\u2010-\u2015]+`;
const ckNameRx = name => { const n = ckNormalize(name).norm.trim();
  return new RegExp('(?<![A-Za-z0-9_])' + n.split(/[\s\-\u2010-\u2015]+/).map(ckEsc).join(CK_NAME_GAP) + (/[a-z]$/i.test(n) ? '(?:e?s)?' : '') + '(?![A-Za-z0-9_])', 'gi'); };
// Which item an amount belongs to. Name mentions inside a longer mention are dropped first, so the longest name wins
// ("Pro Plus is $19" is Pro Plus, never Pro) whatever order the policy lists them in; identical spans from two items
// keep the first listed (validate_policy warns duplicate_item). Then the nearest mention within 60 characters wins,
// preferring one before the amount. Mentions are found once per sentence and looked up by binary search, so the cost
// is linear in the sentence, not amounts x names x length (a reply of 1,333 "$1"s used to take seconds per case).
function ckMentions(pol, s) {
  const all = []; let o = 0;
  for (const p of pol.prices) for (const rx of p.rx) { for (const n of s.matchAll(rx)) all.push({ start: n.index, end: n.index + n[0].length, o, p }); o++; }
  all.sort((a, b) => a.start - b.start || b.end - a.end || a.o - b.o);
  const out = []; let maxEnd = -1, maxStart = -1;
  for (const m of all) {
    const last = out[out.length - 1];
    if (last && last.start === m.start && last.end === m.end) continue;             // same span, later item: keep the first listed
    if (maxEnd > m.end || (maxEnd === m.end && maxStart < m.start)) continue;        // strictly inside an earlier, longer mention
    out.push(m); if (m.end > maxEnd) { maxEnd = m.end; maxStart = m.start; }
  }
  return out;
}
function ckAttribute(mentions, at) {
  let lo = 0, hi = mentions.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (mentions[mid].start < at - 60) lo = mid + 1; else hi = mid; }
  let best = null;
  for (let k = lo; k < mentions.length && mentions[k].start <= at + 60; k++) {
    const n = mentions[k], d = Math.abs(n.start - at), score = n.start < at ? d : d + 1000;
    if (!best || score < best.score) best = { score, p: n.p, k };
  }
  return best;
}
// Pass 3: one amount for several items ("Both Pro and Pro Plus are $19", "Pro, Team and Starter each cost $49") is
// a claim about each of them. Only a plain list (commas, and, &) directly followed by a plural price verb counts.
const CK_LIST_VERB = /^\s*(?:plans?\s+|tiers?\s+)?(?:are|cost|both\s+cost|each\s+cost|all\s+cost|are\s+(?:both|each|all)|(?:both|each|all)\s+are)\s*(?:only\s+|just\s+)?$/i;
const CK_LIST_GAP = /^\s*(?:,\s*(?:and\s+|&\s+)?|and|&)\s*$/i;
function ckListed(s, mentions, best, at) {
  const first = mentions[best.k]; if (first.start >= at || !CK_LIST_VERB.test(s.slice(first.end, at))) return [best.p];
  const items = [best.p]; let prev = first;
  for (let k = best.k - 1; k >= 0 && CK_LIST_GAP.test(s.slice(mentions[k].end, prev.start)); k--) { prev = mentions[k]; if (!items.includes(prev.p)) items.unshift(prev.p); }
  return items;
}
// Pass 3 amount edges, read from the text right after an amount: magnitude ("$49k" is 49,000), trailing cents
// ("$49 and 99 cents"), and the upper bound of a range ("$49-59"). Standalone cents ("99 cents", "5900¢") are amounts.
const CK_MAGNITUDE = /^\s?(k|thousand|m|mm|million|bn|b|billion)(?![A-Za-z])/i, CK_MAG = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
const CK_AND_CENTS = /^\s*(?:and\s+)?(\d{1,2})\s?(?:cents?|¢)(?![A-Za-z])/i;
const CK_RANGE_TO = /^\s?(?:-|–|—|to)\s?(\d[\d,]*\d|\d)(?:\.(\d{1,2}))?(?![\d,]|\.\d|\s?%|\s?(?:seats?|users?|days?|months?|years?|people|members?|hours?|minutes?)\b)/i;
const CK_CENTS = /(?<!\d|\d,|\$\s?)(\d[\d,]*\d|\d)\s?(?:cents?|¢)(?![A-Za-z])/gi;
// "Starter is free" claims a price of $0. Not when negated, not "free trial / to try / for 14 days / of ads", not "nothing extra".
const CK_FREE_HINT = /\b(?:free|no\s+(?:cost|charge)|nothing|complimentary)\b/i;
const CK_FREE_AFTER = /^(?:\s+(?:plan|tier))?(?:\s+(?:is|are|comes|costs?|will\s+be)(?:\s+now)?|'s)\s+(?:completely\s+|totally\s+|entirely\s+|absolutely\s+|100%\s+)?(free(?:\s+of\s+charge)?|at\s+no\s+(?:cost|charge)|no\s+charge|nothing|complimentary)(?![A-Za-z])(?!\s+(?:to|for|trial|with|until|through|during|extra|more|of(?!\s+charge))\b)/i;

class CheckInputError extends Error {}
const bad = m => { throw new CheckInputError(m); };
// A misspelled field ("forbids") must never turn a check silently green, so unknown keys are errors.
const ckOnly = (o, where, keys) => { for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`${where}.${k}: unknown field (allowed: ${keys.join(', ')})`); };

function compilePolicy(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) bad('policy must be an object');
  if (Object.hasOwn(p, 'actions') && p.actions === null) bad('policy.actions must be an object');
  ckOnly(p, 'policy', ['name', 'description', 'prices', 'forbid', 'actions', 'unknownAmounts']);
  if (p.unknownAmounts !== undefined && p.unknownAmounts !== 'flag' && p.unknownAmounts !== 'allow') bad('policy.unknownAmounts: "flag" or "allow"');
  for (const field of ['name','description']) if (p[field] !== undefined && typeof p[field] !== 'string') bad(`policy.${field}: string`);
  for (const field of ['prices','forbid']) if (p[field] === null) bad(`policy.${field}: array`);
  const prices = p.prices ?? [], forbid = p.forbid ?? [], actions = p.actions ?? {};
  if (!Array.isArray(prices) || prices.length > CHECK_LIMITS.prices) bad(`policy.prices: array of at most ${CHECK_LIMITS.prices}`);
  if (!Array.isArray(forbid) || forbid.length > CHECK_LIMITS.forbid) bad(`policy.forbid: array of at most ${CHECK_LIMITS.forbid}`);
  if (typeof actions !== 'object' || Array.isArray(actions) || Object.keys(actions).length > CHECK_LIMITS.actions) bad(`policy.actions: object of at most ${CHECK_LIMITS.actions}`);
  return {
    prices: prices.map((x, i) => {
      if (!x || typeof x !== 'object' || Array.isArray(x)) bad(`policy.prices[${i}]: object`);
      ckOnly(x, `policy.prices[${i}]`, ['item', 'amount', 'amounts', 'aliases']);
      if (x.amount !== undefined && x.amounts !== undefined) bad(`policy.prices[${i}]: amount or amounts, not both`);
      if (!ckStr(x?.item, CHECK_LIMITS.phraseChars)) bad(`policy.prices[${i}].item: short string`);
      const amounts = x.amounts ?? [x.amount];
      if (!Array.isArray(amounts) || !amounts.length || amounts.length > 8 || !amounts.every(a => typeof a === 'number' && isFinite(a) && a >= 0)) bad(`policy.prices[${i}]: amount or amounts (non-negative numbers)`);
      if (x.aliases === null) bad(`policy.prices[${i}].aliases: array`);
      const aliases = x.aliases ?? [x.item];
      if (!Array.isArray(aliases) || aliases.length > CHECK_LIMITS.aliases || !aliases.every(a => ckStr(a, CHECK_LIMITS.phraseChars))) bad(`policy.prices[${i}].aliases: up to ${CHECK_LIMITS.aliases} short strings`);
      if (!aliases.every(a => ckNormalize(a).norm.trim())) bad(x.aliases ? `policy.prices[${i}].aliases: every alias needs a visible character` : `policy.prices[${i}].item: needs a visible character`);
      return { item: x.item, amounts, rx: aliases.map(ckNameRx) };
    }),
    forbid: forbid.map((x, i) => {
      if (!x || typeof x !== 'object' || Array.isArray(x)) bad(`policy.forbid[${i}]: object`);
      ckOnly(x, `policy.forbid[${i}]`, ['id', 'phrases', 'why', 'negatable']);
      if (x.why !== undefined && (typeof x.why !== 'string' || x.why.length > 200)) bad(`policy.forbid[${i}].why: string of at most 200 chars`);
      if (x.negatable !== undefined && typeof x.negatable !== 'boolean') bad(`policy.forbid[${i}].negatable: boolean`);
      if (!ckStr(x?.id, 40) || !/^[a-z0-9-]+$/.test(x.id)) bad(`policy.forbid[${i}].id: lowercase slug`);
      if (!Array.isArray(x.phrases) || !x.phrases.length || x.phrases.length > CHECK_LIMITS.phrases || !x.phrases.every(s => ckStr(s, CHECK_LIMITS.phraseChars) && ckNormalize(s).norm.trim().length > 0)) bad(`policy.forbid[${i}].phrases: 1-${CHECK_LIMITS.phrases} literal strings`);
      return { id: x.id, why: ckStr(x.why, 200) ? x.why : 'Not approved by this policy.', negatable: x.negatable !== false,
        rx: new RegExp(x.phrases.map(s => '(?<![a-zA-Z0-9_])' + ckEsc(ckNormalize(s).norm) + (/[a-z]$/i.test(s) ? '(?:s|es|d|ed|ing)?' : '') + '(?![a-zA-Z0-9_])').join('|'), 'gi') };
    }),
    actions: Object.fromEntries(Object.entries(actions).map(([verb, op]) => {
      if (!/^[a-z]{2,20}$/.test(verb) || !ckStr(op, 60)) bad(`policy.actions.${verb}: lowercase verb -> operation string`);
      return [verb, op];
    })),
    unknownAmounts: p.unknownAmounts === 'allow' ? 'allow' : 'flag',
  };
}

function compileRecord(r, verified) {
  const signed = verified ? verified.ops : new Set(), signedAmounts = (verified && verified.amounts) || new Map();
  if (r === undefined) return { done: new Set(signed), signed, signedAmounts, callerOps: 0, facts: [] };
  if (!r || typeof r !== 'object' || Array.isArray(r)) bad('record must be an object');
  ckOnly(r, 'record', ['subject', 'effects', 'facts', 'receipts']);
  if (r.receipts !== undefined && (!Array.isArray(r.receipts) || !r.receipts.every(x=>typeof x==='string'))) bad('record.receipts: array');
  if (r.subject !== undefined && !ckStr(r.subject, 200)) bad('record.subject: string of at most 200 chars');
  for (const field of ['effects','facts']) if (r[field] === null) bad(`record.${field}: array`);
  const effects = r.effects ?? [], facts = r.facts ?? [];
  if (!Array.isArray(effects) || effects.length > CHECK_LIMITS.effects || !effects.every(e=>e && typeof e==='object' && !Array.isArray(e) && (e.operation===undefined || typeof e.operation==='string') && (e.status===undefined || typeof e.status==='string'))) bad(`record.effects: array of at most ${CHECK_LIMITS.effects}`);
  if (!Array.isArray(facts) || facts.length > CHECK_LIMITS.facts) bad(`record.facts: array of at most ${CHECK_LIMITS.facts}`);
  return {
    ...(() => { const caller = effects.filter(e => e?.status === 'DONE' && typeof e.operation === 'string').map(e => e.operation);
      return { done: new Set([...caller, ...signed]), signed, signedAmounts, callerOps: caller.length }; })(),
    facts: facts.map((f, i) => {
      if (!f || typeof f !== 'object' || Array.isArray(f)) bad(`record.facts[${i}]: object`);
      ckOnly(f, `record.facts[${i}]`, ['near', 'kind', 'value']);
      if (!ckStr(f?.near, CHECK_LIMITS.phraseChars) || !Object.prototype.hasOwnProperty.call(CK_KINDS, f.kind) || !['string','number'].includes(typeof f.value) || !ckStr(String(f.value ?? ''), 40)) bad(`record.facts[${i}]: {near, kind: time|money|date, value}`);
      return { near: new RegExp('\\b' + ckEsc(f.near), 'i'), kind: CK_KINDS[f.kind], value: String(f.value) };
    }),
  };
}

function checkReply(pol, rec, reply, requireSigned) {
  const n = ckNormalize(reply), text = n.norm, out = [];
  const add = (rule, at, len, why) => { const span = n.from(at, at + len); out.push({ rule, span, text: reply.slice(span[0], span[1]), why }); };
  if (!text.trim()) return { pass: false, findings: [{ rule: 'empty', span: [0, 0], text: '', why: 'No reply.' }] };
  for (const f of pol.forbid) for (const m of text.matchAll(f.rx)) {
    if (f.negatable && ckNegated(text, m.index)) continue;
    add('forbid:' + f.id, m.index, m[0].length, f.why); break;
  }
  for (const sm of text.matchAll(/(?:[^.!?;\n]|\.(?=\d))+[.!?;]?/g)) {
    const s = sm[0]; let mentions = null; const ment = () => mentions ??= ckMentions(pol, s), consumed = [];
    const taken = (a, b) => consumed.some(([x, y]) => a < y && b > x);
    const money = v => '$' + (Math.round(v * 100) / 100);
    // One price claim at sentence offset `at`: attribute it (with any list it closes) and compare.
    const claim = (at, len, v, said) => {
      const best = ckAttribute(ment(), at);
      if (!best) { if (pol.unknownAmounts === 'flag') add('price:unattributed', sm.index + at, len, 'A dollar figure not tied to any approved price.'); return; }
      for (const p of ckListed(s, mentions, best, at)) if (!p.amounts.some(a => Math.abs(a - v) < 1e-9)) add('price:mismatch', sm.index + at, len, `${p.item} is ${p.amounts.map(a => '$' + a).join(' or ')}, not ${said ?? money(v)}.`);
    };
    for (const m of s.matchAll(CK_AMOUNT)) {
      if (taken(m.index, m.index + m[0].length)) continue;
      const neg = m[1] || m[4], whole = m[2] || m[5], frac = m[2] ? m[3] : m[6];
      let len = m[0].length, v = (neg ? -1 : 1) * parseFloat(whole.replace(/,/g, '') + (frac ? '.' + frac : ''));
      if (!CK_WELLFORMED.test(whole) || (frac && frac.length > 2)) { add('price:malformed', sm.index + m.index, len, 'An amount that is not a well-formed price (check commas and cents).'); continue; }
      let tail = s.slice(m.index + len), x;
      if (m[2] && (x = CK_MAGNITUDE.exec(tail))) { v *= CK_MAG[x[1].toLowerCase()]; len += x[0].length; tail = tail.slice(x[0].length); }
      else if (!frac && (x = CK_AND_CENTS.exec(tail))) { v += (v < 0 ? -1 : 1) * Number(x[1]) / 100; len += x[0].length; tail = tail.slice(x[0].length); }
      consumed.push([m.index, m.index + len]);
      claim(m.index, len, v);
      if ((x = CK_RANGE_TO.exec(tail)) && CK_WELLFORMED.test(x[1])) {
        const at = m.index + len + x[0].indexOf(x[1]), hi = parseFloat(x[1].replace(/,/g, '') + (x[2] ? '.' + x[2] : ''));
        consumed.push([at, m.index + len + x[0].length]); claim(at, x[0].length - x[0].indexOf(x[1]), hi);
      }
    }
    for (const m of s.matchAll(CK_CENTS)) {
      if (taken(m.index, m.index + m[0].length) || !CK_WELLFORMED.test(m[1])) continue;
      consumed.push([m.index, m.index + m[0].length]); claim(m.index, m[0].length, parseFloat(m[1].replace(/,/g, '')) / 100);
    }
    // Another currency is a mismatch only when it is tied to an item (no unattributed finding: "Shipping is €10").
    for (const m of s.matchAll(CK_FOREIGN)) if (ckAttribute(ment(), m.index)) claim(m.index, m[0].length, NaN, m[0].trim());
    if (pol.prices.length && CK_FREE_HINT.test(s)) for (const n of ment()) {
      const f = CK_FREE_AFTER.exec(s.slice(n.end)); if (!f || n.p.amounts.includes(0)) continue;
      add('price:mismatch', sm.index + n.end + f.index + f[0].indexOf(f[1]), f[1].length, `${n.p.item} is ${n.p.amounts.map(a => '$' + a).join(' or ')}, not free.`);
    }
  }
  const acted = [...text.matchAll(CK_ACTED)], seen = acted.filter(m => Object.prototype.hasOwnProperty.call(pol.actions, m[1].toLowerCase())).map(m => [m.index, m.index + m[0].length]);
  // Extra completion forms count once: skip any span overlapping one already found.
  for (const m of ckMoreActed(text, pol.actions).sort((x, y) => x.index - y.index)) { const e = m.index + m[0].length; if (!seen.some(([a, b]) => m.index < b && e > a)) { seen.push([m.index, e]); acted.push(m); } }
  // A second action after "and" / "then" / a comma shares the claim's subject ("I've merged X and submitted Y"). Follow the
  // chain only while the word after each connector is a policy verb; "and will submit" or "you, Sam, and booked" stop it.
  const isAct = v => Object.prototype.hasOwnProperty.call(pol.actions, v.toLowerCase());
  for (const m of [...acted]) {
    if (!isAct(m[1])) continue;
    let at = m.index + m[0].length, c;
    while ((c = /^[^.!?;\n]{0,60}?(?:,\s*(?:and\s+|then\s+)?|\s+(?:and|then)\s+)(?:also\s+|then\s+)?([a-z]+)\b/i.exec(text.slice(at))) && isAct(c[1])) {
      const vi = at + c[0].length - c[1].length, ve = vi + c[1].length; at = ve;
      if (!seen.some(([a, b]) => vi < b && ve > a)) { seen.push([vi, ve]); acted.push({ index: vi, 0: c[1], 1: c[1], length: c[1].length }); }
    }
  }
  for (const m of acted) {
    const op = Object.prototype.hasOwnProperty.call(pol.actions, m[1].toLowerCase()) ? pol.actions[m[1].toLowerCase()] : null;
    if (op && !rec.done.has(op)) add('action:unrecorded', m.index, m[0].length, `Says "${m[0]}" but no ${op} effect is DONE in the record.`);
    else if (op && requireSigned && !rec.signed.has(op)) add('action:unverified', m.index, m[0].length, `Says "${m[0]}" but no Curbi-signed receipt proves ${op}.`);
    // A signed receipt fixes the amount. Any dollar figure in the same sentence as the claim must match it.
    const signedAmts = op && rec.signedAmounts.get(op);
    if (signedAmts) {
      const usd = signedAmts.filter(x => x.currency === 'usd').map(x => x.minor);
      const sStart = Math.max(text.lastIndexOf('.', m.index), text.lastIndexOf('!', m.index), text.lastIndexOf('?', m.index), text.lastIndexOf('\n', m.index)) + 1;
      const rest = text.slice(m.index).search(/[!?\n]|\.(?!\d)/), sEnd = rest < 0 ? text.length : m.index + rest;
      for (const am of text.slice(sStart, sEnd).matchAll(CK_AMOUNT)) {
        const neg = am[1] || am[4], whole = am[2] || am[5], frac = am[2] ? am[3] : am[6];
        if (!CK_WELLFORMED.test(whole) || (frac && frac.length > 2)) continue;   // reported as price:malformed
        const minor = (neg ? -1 : 1) * Math.round(parseFloat(whole.replace(/,/g, '') + (frac ? '.' + frac : '')) * 100);
        if (!usd.includes(minor)) add('fact:contradicts-receipt', sStart + am.index, am[0].length, `The signed receipt for ${op} says ${usd.length ? usd.map(x => '$' + (x / 100).toFixed(2)).join(' or ') : 'no matching USD amount'}, not ${am[0].trim()}.`);
      }
    }
  }
  for (const f of rec.facts) {
    const l = f.near.exec(text); if (!l) continue;
    const said = f.kind.exec(text.slice(l.index, l.index + 80));
    if (said && said[0].replace(/\s/g, '').toLowerCase() !== f.value.replace(/\s/g, '').toLowerCase())
      add('fact:contradicts-record', l.index + said.index, said[0].length, `Record says ${f.value}, reply says ${said[0]}.`);
  }
  out.sort((a, b) => a.span[0] - b.span[0]);
  return { pass: out.length === 0, findings: out };
}

// Body: {policy, reply, record?} or {policy, cases:[{id?, reply, record?}]}, optional verify:"required".
// verified[i] is the result of verifyReceipts for case i (single reply: index 0). Without it,
// receipts are not trusted and only caller-asserted effects count.
function recordTrust(c, v) {
  const signed = v && v.valid > 0, caller = (Array.isArray(c?.record?.effects) && c.record.effects.some(e => e?.status === 'DONE')) || (Array.isArray(c?.record?.facts) && c.record.facts.length > 0);
  return signed ? (caller ? 'mixed' : 'curbi_signed') : 'caller_supplied_unverified';
}
function runCheck(body, verified) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('body must be a JSON object');
  if (body.version !== undefined && !CHECK_VERSIONS.includes(body.version)) bad(`version: unsupported "${String(body.version).slice(0, 20)}" (supported: ${CHECK_VERSIONS.join(', ')})`);
  if (body.cases !== undefined && body.reply !== undefined) bad('send reply or cases, not both');
  ckOnly(body, 'body', body.cases !== undefined ? ['version', 'policy', 'cases', 'verify'] : ['version', 'policy', 'reply', 'record', 'verify']);
  if (body.verify !== undefined && body.verify !== 'required' && body.verify !== 'optional') bad('verify: "required" or "optional"');
  const requireSigned = body.verify === 'required';
  const pol = compilePolicy(body.policy);
  const one = (c, i) => {
    if (body.cases !== undefined) { if (!c || typeof c !== 'object' || Array.isArray(c)) bad(`cases[${i}]: object`); ckOnly(c, `cases[${i}]`, ['id', 'reply', 'record']); }
    if (Array.isArray(body.cases) && c.id !== undefined && typeof c.id !== 'string') bad(`cases[${i}].id: string`);
    if (typeof c?.reply !== 'string' || c.reply.length > CHECK_LIMITS.replyChars) bad(`reply: string of at most ${CHECK_LIMITS.replyChars} chars`);
    const v = verified && verified[i];
    const out = { recordTrust: recordTrust(c, v), ...checkReply(pol, compileRecord(c.record, v), c.reply, requireSigned), proof: { scope: 'operation_and_subject_only', factsAuthenticated: false, replayProtection: 'within_request_only', authorizationGranted: false } };
    if (c?.record?.receipts !== undefined) out.receipts = v ? { valid: v.valid, rejected: v.rejected } : { valid: 0, rejected: [{ index: 0, reason: 'not_verified_here' }] };
    return out;
  };
  if (Array.isArray(body.cases)) {
    if (!body.cases.length || body.cases.length > CHECK_LIMITS.cases) bad(`cases: 1-${CHECK_LIMITS.cases} items`);
    const ids = body.cases.map((c, i) => typeof c?.id === 'string' ? c.id.slice(0, 60) : String(i)), dup = ids.find((x, i) => ids.indexOf(x) !== i);
    // Results are matched to cases by id; a duplicate would make that ambiguous, so it is an error, never a pass.
    if (dup !== undefined) bad(`cases: duplicate id "${dup}" (ids, including the default index ids, must be unique)`);
    const results = body.cases.map((c, i) => ({ id: ids[i], ...one(c, i) }));
    const trusts = new Set(results.map(r => r.recordTrust));
    return { object: 'check.batch', version: CHECK_VERSION, recordTrust: trusts.size === 1 ? [...trusts][0] : 'mixed', pass: results.every(r => r.pass), results };
  }
  return { object: 'check', version: CHECK_VERSION, ...one(body, 0) };
}

let CK_KEYS = null, CK_KEYS_SRC = null;
async function receiptKeys(env) {
  const src = (env && env.CURBI_RECEIPT_KEYS) || '{"keys":[]}';
  if (src !== CK_KEYS_SRC) { CK_KEYS = await importReceiptKeys(JSON.parse(src)); CK_KEYS_SRC = src; }
  return CK_KEYS;
}
async function verifyBody(body, env) {
  const cases = Array.isArray(body?.cases) ? body.cases : [body];
  if (!cases.some(c => c?.record?.receipts !== undefined)) return undefined;
  const keys = await receiptKeys(env);
  return Promise.all(cases.slice(0, CHECK_LIMITS.cases).map(c => verifyReceipts(c?.record?.receipts, c?.record?.subject, keys)));
}
// Public verification keys, so anyone can check a receipt offline. Private keys never live here.
async function handleReceiptKeys(env) {
  const keys = JSON.parse((env && env.CURBI_RECEIPT_KEYS) || '{"keys":[]}').keys || [];
  const pub = (Array.isArray(keys) ? keys : []).filter(k => k && k.kty === 'OKP' && k.crv === 'Ed25519' && !k.d).map(k => ({ kty: k.kty, crv: k.crv, kid: k.kid, x: k.x, use: 'sig', alg: 'EdDSA', ...(typeof k.not_before === 'string' ? { not_before: k.not_before } : {}), ...(typeof k.not_after === 'string' ? { not_after: k.not_after } : {}) }));
  return new Response(JSON.stringify({ keys: pub }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' } });
}

// Best-effort per-isolate burst guard. This is not a distributed quota or an entitlement.
const CK_BURSTS = new Map();
function checkBurst(ip, now=Date.now()) {
  if(!ip) return true;
  if(CK_BURSTS.size>=4096){for(const [k,v] of CK_BURSTS)if(now-v.start>=60000)CK_BURSTS.delete(k);if(CK_BURSTS.size>=4096&&!CK_BURSTS.has(ip))return false;}
  let b=CK_BURSTS.get(ip);if(!b||now-b.start>=60000){b={start:now,count:0};CK_BURSTS.set(ip,b);}return ++b.count<=30;
}
async function handleCheck(request, env) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
  const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: h });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (request.method === 'GET' && (request.headers.get('Accept')||'').includes('text/html')) return Response.redirect(new URL('/developers/#reference',request.url),302);
  if (request.method === 'GET') return j({ object: 'check.info', version: 'v1', apiVersion: CHECK_VERSION, supportedVersions: CHECK_VERSIONS, contract: { openapi: '/developers/check-api.openapi.json', policySchema: '/developers/policy.v1.schema.json' }, preview: true, method: 'POST', limits: CHECK_LIMITS, docs: '/developers/#reference', recordTrust: 'caller_supplied_unverified', signedReceipts: { field: 'record.receipts', subject: 'record.subject', keys: '/.well-known/curbi-receipt-keys.json', require: 'verify: "required"' }, stores: 'nothing' });
  if (request.method !== 'POST') return j({ error: { type: 'method_not_allowed', message: 'Use POST' } }, 405);
  if (!checkBurst(request.headers.get('CF-Connecting-IP'))) return new Response(JSON.stringify({error:{type:'rate_limited',message:'Preview burst limit reached; try again later.'}}),{status:429,headers:{...h,'Retry-After':'60'}});
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return j({ error: { type: 'invalid_request', message: 'Content-Type must be application/json' } }, 415);
  const reader = request.body?.getReader(); let bytes = 0; const chunks = [];
  if(reader) { while(true) { const {done,value}=await reader.read(); if(done) break; bytes+=value.byteLength; if(bytes>CHECK_LIMITS.bodyBytes){await reader.cancel();return j({error:{type:'invalid_request',message:'Body exceeds 65536 bytes'}},413);} chunks.push(value); } }
  const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;} const raw = new TextDecoder().decode(joined);
  if (new TextEncoder().encode(raw).length > CHECK_LIMITS.bodyBytes) return j({ error: { type: 'invalid_request', message: `Body over ${CHECK_LIMITS.bodyBytes} bytes` } }, 413);
  let body; try { body = JSON.parse(raw); } catch { return j({ error: { type: 'invalid_request', message: 'Body is not valid JSON' } }, 400); }
  try { return j(runCheck(body, await verifyBody(body, env))); }
  catch (e) { if (e instanceof CheckInputError) return j({ error: { type: 'invalid_request', message: e.message } }, 400); throw e; }
}
if (typeof module !== 'undefined') module.exports = { runCheck, handleCheck, handleReceiptKeys, CHECK_LIMITS, CHECK_VERSION, CHECK_VERSIONS };
