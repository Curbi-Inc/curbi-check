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
// A currency prefix is a complete token, not the final letter of ordinary prose (costs$99).
const CK_FOREIGN_DOLLAR = String.raw`\b(?:R|AU?|CA?|NZ|HK|MX|SG?|NT|TT|J|BZ|FJ|BS|Z)`;
const CK_AMOUNT = new RegExp(String.raw`(-\s?)?(?:(?<!${CK_FOREIGN_DOLLAR})\$|\bUS\$|\bUSD\s?)\s?` + CK_NUM + String.raw`|(-\s?)?\b` + CK_NUM + String.raw`\s?(?:(?:dollars?|bucks|USD|dolar(?:es)?)\b|д[оo]лл[аa][рp](?:[оo][вb]|[аa])?|[トド]ル|美元|دولار|${'달러'.normalize('NFD')}|đo\s*la|डॉलर|\$)`, 'gi');
// Another currency where the policy prices in USD is a mismatch even when the number matches (CMO ruling: price:mismatch, no new rule).
const CK_FOREIGN = new RegExp(String.raw`(?:${CK_FOREIGN_DOLLAR}\$|€|£|¥|₹|₽|₩|₺|₱|₪|₦|₴|₸|฿|₫|\bEUR\s?|\bGBP\s?|\bINR\s?)\s?` + CK_NUM + String.raw`|\b` + CK_NUM + String.raw`\s?(?:€|£|₹|₽|円|元|(?:euros?|EUR|pounds?|GBP|rupees?|INR|yen|JPY|yuan|CNY)\b)`, 'gi');
// Action claims, active ("I've booked", "we had sent") and passive ("you're booked", "it's been refunded").
const CK_ACTED = /\b(?:(?:I|we)(?:'ve|ve|'d|\s+have|\s+had)?|you(?:'re|\s+are|'ve\s+been|\s+have\s+been)|(?:it|this|that|everything)(?:'s\s+been|\s+has\s+been|'s|\s+is|\s+was))(?:\s*,[^,.!?;\n]{1,60},)?(?:\s+|\s*(?:[\u2600-\u27bf\ufe0f]|[\ud83c-\ud83e][\udc00-\udfff])+\s*)(?:just\s+|already\s+|now\s+|all\s+|both\s+|also\s+|[a-z]+ly\s+)?([a-z]+)\b/gi;
// Completion claims the subject+verb pattern above misses (adversarial pass, PR #155). Each yields {index, 0, 1: verb}
// so the same record/receipt logic applies. Negated, future and question forms do not match by construction.
const CK_DONE_VERBS = 'processed|issued|completed|sent|finalized|confirmed|applied|made|done|initiated|started|put\\s+through|kicked\\s+off|handled|taken\\s+care\\s+of|took\\s+care\\s+of|squared\\s+away|sorted(?:\\s+out)?|finalised|wrapped\\s+up|complete|finished';
function ckMoreActed(text, actions) {
  const out = [], NOT_THE_ACT = '(?!\\s+(?:request|requests|form|policy|policies|status|window|option|options|eligibility|process|link|amount|fee|terms))', esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const verb of Object.keys(actions)) {
    const stem = verb.replace(/e?d$/, ''), nouns = [...new Set([stem, stem.replace(/(.)\1$/, '$1'), stem + 'ing', stem + 'ation', stem.replace(/(.)\1$/, '$1') + 'ation'])].map(esc).join('|'), v = esc(verb);
    // base and -ing forms: refunded -> refund / refunding, cancelled -> cancel / cancelling / canceling, upgraded -> upgrade / upgrading
    const B = [...new Set([verb.replace(/ed$/, ''), verb.replace(/d$/, ''), verb.replace(/ed$/, '').replace(/(.)\1$/, '$1')])].map(esc).join('|');
    const ING = [...new Set([verb.replace(/ed$/, '') + 'ing', verb.replace(/d$/, '').replace(/e$/, '') + 'ing', verb.replace(/ed$/, '').replace(/(.)\1$/, '$1') + 'ing'])].map(esc).join('|');
    const rx = [
      // passive with a person or thing as subject: "You were refunded", "It got refunded"
      new RegExp(`\\b(?:you|it|this|that|everything|(?:your|the|our|this|that)\\s+\\w+)\\s+(?:were|was|got|have\\s+been|has\\s+been)\\s+(?:just\\s+|already\\s+|now\\s+|fully\\s+)?(${v})\\b`, 'gi'),
      // emphatic did with the base form: "I did refund you", "We really did cancel it"
      new RegExp(`\\b(?:I|we)\\s+(?:[a-z]+ly\\s+|actually\\s+|just\\s+|already\\s+)?did\\s+(${B})\\b`, 'gi'),
      // coordinated or adverbial first person: "I went ahead and refunded", "we successfully refunded"
      new RegExp(`\\b(?:I|we)(?:'ve|\\s+have|\\s+had)?\\s+(?:(?:went|gone)\\s+ahead\\s+and|also|then|finally|successfully|quickly)\\s+(${v})\\b`, 'gi'),
      // bare or after a colon/dash, ending the sentence: "Refunded!", "I did it: refunded."
      new RegExp(`(?:^|[.!?\\n]\\s*|[:\\u2014\\u2013-]\\s*|(?:[\\u2600-\\u27bf]|[\\udc00-\\udfff])\\ufe0f?\\s*)(?:(?:all|already|fully)\\s+)?(${v})\\s*(?=[.!]|\\s*[\\u2014\\u2013:]|\\s+-\\s|\\s*[+&]\\s*[a-z]|$)`, 'gim'),
      // sentence-initial verb with you as object, no subject: "Refunded you and cancelled the plan."
      new RegExp(`(?<=^|[.!?\\n]\\s*)(?:(?:all|already|just|also|then)\\s+)?(${v})\\s+(?:you|your|the|it|this|that)\\b`, 'gim'),
      // "Consider it refunded."
      new RegExp(`\\bconsider\\s+(?:it|this|that|yourself|your\\s+\\w+)\\s+(?:fully\\s+)?(${v})\\b`, 'gi'),
      // first person + completion verb + noun: "I have issued the refund", "I processed your refund"
      new RegExp(`\\b(?:I|we)(?:'ve|\\s+have|\\s+had)?\\s+(?:just\\s+|already\\s+|now\\s+)?(?:${CK_DONE_VERBS})\\s+(?:the|your|a|an|this|that|its)?\\s*(?:full\\s+)?(${nouns})\\b${NOT_THE_ACT}`, 'gi'),
      // completion idioms and disguised forms (break session 8)
      new RegExp(`\\bconsider\\s+(?:the|your|this|that)\\s+(${nouns})\\s+(?:done|sorted|handled|complete|processed|taken\\s+care\\s+of)\\b`, 'gi'),
      new RegExp(`\\byou(?:'ve|\\s+have)\\s+(?:now\\s+|already\\s+)?(?:got|gotten|received)\\s+(?:the|your|a)\\s+(?:full\\s+)?(${nouns})\\b${NOT_THE_ACT}`, 'gi'),
      new RegExp(`(?<=^|[.!?\\n]\\s*)having\\s+(?:already\\s+|just\\s+)?(${v})\\b`, 'gim'),
      new RegExp(`\\b(?:I|we)(?:'m|'re|\\s+am|\\s+are)\\s+(?:now\\s+|just\\s+|currently\\s+)?(${ING})\\b`, 'gi'),
      new RegExp(`(?<=^|[.!?\\n]\\s*)(${ING})\\s+(?:you|your|the|it)\\b(?=[^.!?\\n]{0,40}\\b(?:now|right\\s+away|as\\s+we\\s+speak)\\b)`, 'gim'),
      // An immediate negative answer resolves the question; "yes or no?" is a choice, not an answer.
      new RegExp(`\\b(?:didn't|haven't|hasn't)\\s+(?:I|we)\\s+(?:already\\s+|just\\s+)?(?:${B}|${v})\\b(?![^.!?\\n]{0,60}\\?\\s*(?:no|nope|nah)(?=\\s*[,;.!?]|$))`, 'gi'),
      new RegExp(`\\bdid\\s+(?:I|we)\\s+(?:${B})\\b[^?\\n]{0,60}\\?\\s*(?:yes|yep|yeah|yup|absolutely|of\\s+course|I\\s+did|we\\s+did)\\b(?!\\s*(?:or\\s+|/\\s*|,\\s*or\\s+)no\\b)`, 'gi'),
      new RegExp(`\\b(?:(?:can't|cannot|can\\s+not)\\s+say|not\\s+true)\\s+(?:that\\s+)?(?:I|we)\\s+(?:didn't|did\\s+not|haven't|have\\s+not)\\s+(?:${B}|${v})\\b`, 'gi'),
      // noun + passive completion: "Your refund has been processed", "The refund was issued"
      new RegExp(`\\b(?:the|your|a|this|that)\\s+(?:full\\s+|[a-z]+\\s+)?(${nouns})${NOT_THE_ACT}\\s+(?:has\\s+been|have\\s+been|was|is|'s\\s+been|got)\\s+(?:just\\s+|already\\s+|now\\s+|fully\\s+)?(?:${CK_DONE_VERBS})\\b`, 'gi'),
      // noun, then a one-word verdict: "The refund? Done.", "Refund: completed."
      new RegExp(`\\b(${nouns})\\s*\\u2705|\\b(${nouns})(?:\\s*(?:[?:\\u2014\\u2013-]|[\\u2600-\\u27bf\\ufe0f]|[\\ud83c-\\ud83e][\\udc00-\\udfff]))+\\s*(?:all\\s+)?(?:done|completed|complete|processed|issued|sent|\\u2705|\\u2714\\ufe0f?|\\u2611\\ufe0f?|\\u2713)\\s*(?=[.!]|$)`, 'gim'),
      // clause-initial noun or object with a verdict and no punctuation between: "Refund done, plan cancelled."
      new RegExp(`(?<=^|[.!?\\n,;]\\s*)(${nouns})\\s+(?:is\\s+|was\\s+)?(?:done|completed|complete|processed|issued|sent|sorted|handled|finalised|finalized|through|set)\\b(?=\\s*[,.;!]|\\s+and\\b|$)`, 'gim'),
      new RegExp(`(?<=^|[.!?\\n,;]\\s*)(?:the\\s+|your\\s+)?(?:plan|subscription|order|account|booking|ticket|payment|charge|card|refund)\\s+(${v})\\b(?=\\s*[,.;!]|$)`, 'gim'),
      // in flight or observed: "Your refund is on its way", "You'll see the refund on your card"
      new RegExp(`\\b(?:the|your|a|this|that)\\s+(?:full\\s+)?(${nouns})${NOT_THE_ACT}\\s+(?:is|'s|has\\s+been|went|has\\s+gone|have\\s+gone)\\s+(?:already\\s+|now\\s+|all\\s+)?(?:on\\s+(?:its|the)\\s+way|in\\s+progress|underway|going\\s+through|through|all\\s+set(?!\\s+to\\s+be\\s+(?:processed|issued|sent|initiated|started)\\b)|sorted|done)\\b`, 'gi'),
      new RegExp(`\\byou(?:'ll|\\s+will|\\s+should)\\s+(?:see|notice)\\s+(?:the|your|a)\\s+(?:full\\s+)?(${nouns})\\b${NOT_THE_ACT}`, 'gi'),
    ];
    for (const r of rx) for (const m of text.matchAll(r)) if (!/\b(?:once|if|when|whenever|after|until|before|unless|soon\s+as)\s*$/i.test(text.slice(Math.max(0, m.index - 20), m.index))) out.push({ index: m.index, 0: m[0], 1: verb, length: m[0].length });
  }
  return out;
}
const CK_KINDS = { time: /\b\d{1,2}(?::\d\d)?\s?(?:am|pm)\b/i, money: /\$\s?\d[\d,]*(?:\.\d{1,2})?/, date: /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b\d{1,2}\/\d{1,2}\b/i };
// Digits and symbols standing in for letters inside forbidden phrases ("gu4rantee", "r1sk fr33").
const CK_LEET = { a: '[a4@]', b: '[b8]', e: '[e3]', g: '[g9]', i: '[i1!|]', l: '[l1|]', o: '[o0]', s: '[s5$]', t: '[t7+]' };
// Discounts the policy does not list ("50% off", "half price"): a price claim with no approved amount.
const CK_PCT = '(\\d{1,3}(?:\\.\\d+)?)\\s?(?:%|percent\\b|pct\\b)';
const CK_FRACTION = { half: 50, quarter: 25, third: Math.round(10000 / 3) / 100 };
// Discount claims and the percent each states. One combined regex scans; the pattern that matches gives the percent.
const CK_DISC = [
  [`\\b${CK_PCT}\\s*(?:off|discount|cheaper|savings)\\b`, m => +m[1]],
  [`\\bsave\\s+${CK_PCT}`, m => +m[1]],
  [`\\b(?:discount(?:ed)?|reduced|cut|lowered|marked\\s+down)\\s+(?:by|of)\\s+${CK_PCT}`, m => +m[1]],
  [`\\b(?:reduced|cut|lowered|marked\\s+down)\\s+by\\s+(?:a\\s+|one\\s+)?(half|quarter|third)\\b`, m => CK_FRACTION[m[1].toLowerCase()]],
  [`\\b${CK_PCT}\\s+of\\s+the\\s+(?:usual|normal|regular|list|full|original)\\s+price\\b`, m => 100 - m[1] || null],
  [`\\b(0?\\.\\d+)\\s?x\\s+(?:the\\s+)?(?:usual|normal|regular|list|full|original)\\s+price\\b`, m => Math.round((1 - m[1]) * 100)],
  [`(?<=[:(]\\s*|^)[-\\u2212]\\s?${CK_PCT}`, m => +m[1]],
  [`\\b((?:[a-z]+[- ])?[a-z]+)\\s+percent\\s+(?:off|discount)\\b`, m => ckWordsToNumber(m[1])],
  [`\\b(?:(?:half|1\\/2)[- ](?:price|off)|half\\s+off|half\\s+the\\s+(?:usual\\s+|normal\\s+|regular\\s+)?price|(?:2|two)[- ]for[- ](?:1|one)|bogo|buy\\s+one\\b[^.!?\\n]{0,40}?\\bget\\s+one\\s+free)\\b`, () => 50],
];
const CK_DISCOUNT = new RegExp(CK_DISC.map(([x]) => `(?:${x})`).join('|'), 'gi');
const CK_DISC_ONE = CK_DISC.map(([x, f]) => [new RegExp(`^(?:${x})$`, 'i'), f]);
const ckDiscountPct = m => { for (const [rx, f] of CK_DISC_ONE) { const x = rx.exec(m[0]); if (x) return f(x); } return null; };
// Letters in a forbidden phrase may be split by one hyphen, apostrophe, dot or emoji ("guaran-tee", "guar🙂antee").
// One character class (emoji as UTF-16 code units, up to one emoji plus a variation selector): an alternation here made
// 1,000-phrase policies compile and run 15x slower (C8 CPU guard).
const CK_SPLIT = "[-'’.*~_()\\u2010-\\u2015\\u2600-\\u27bf\\ufe0f\\ud83c-\\ud83e\\udc00-\\udfff]{0,8}";
// Words of 5+ letters may also be split by whitespace ("GUAR ANTEE", "guar\nantee"); short words may not ("no risk" stays two words).
const CK_SPLIT_WS = "[-'’.*~_()\\s\\u2010-\\u2015\\u2600-\\u27bf\\ufe0f\\ud83c-\\ud83e\\udc00-\\udfff]{0,8}";
// CJK, kana and Hangul (as jamo after normalization) have no spaces inside words: a space or middle dot there is a split.
const CK_CJK = /[\u1100-\u11ff\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
const CK_SPLIT_CJK = "[\\s\\u00b7\\u30fb\\u2022.\\-_*~]{0,3}";
// Between a phrase's words: any spaces, a hyphen or dash, or nothing ("risk free", "risk-free", "riskfree").
const CK_WORD_GAP = "[\\s\\-\\u2010-\\u2015]*";
// Splits only in phrases of up to 30 letters: real phrases are short, and it keeps 1,000-phrase policies at base speed.
const ckPhrase = n => { const split = (n.match(/[a-z]/gi) || []).length <= 30;
  return n.trim().split(/[\s\-‐-―]+/).map(w => [...w].map((c, i, a) => /[a-z]/i.test(c) ? (CK_LEET[c.toLowerCase()] ?? c) + (split && /[a-z]/i.test(a[i + 1] ?? '') ? (w.length >= 5 ? CK_SPLIT_WS : CK_SPLIT) : '') : ckEsc(c) + (CK_CJK.test(c) && CK_CJK.test(a[i + 1] ?? '') ? CK_SPLIT_CJK : '')).join('')).join(CK_WORD_GAP); };
// Plan-state claims: "You're now on Team", "Your plan has now been moved to Team". Needs a plan-change action.
const CK_PLAN_NOW = /\b(?:you|your\s+(?:account|plan|subscription|workspace))(?:'re|'s|\s+are|\s+is|\s+has|\s+have|\s+was)\s+now(?:\s+been)?\s+(?:on|switched\s+to|moved\s+to|upgraded\s+to|downgraded\s+to|changed\s+to)\s+([^.!?;\n]{1,60})/gi;
const CK_PLAN_VERB = /^(?:up|down)grad|^switch|^chang|^mov|^migrat/i;
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
// Letters drawn from emoji blocks: regional indicators (two of them read 'gu'), negative circled and squared letters, the FREE button.
const ckEmojiLetter = ch => { const c = ch.codePointAt(0);
  return c >= 0x1F1E6 && c <= 0x1F1FF ? String.fromCharCode(97 + c - 0x1F1E6) : c >= 0x1F150 && c <= 0x1F169 ? String.fromCharCode(65 + c - 0x1F150) : c >= 0x1F170 && c <= 0x1F189 ? String.fromCharCode(65 + c - 0x1F170) : c === 0x1F193 ? 'free' : null; };
const ckDigit = ch => { const c = ch.codePointAt(0); for (const z of CK_DIGIT_ZEROS) if (c >= z && c <= z + 9) return String(c - z); return null; };
const CK_NUM_WORDS = { zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90 };
const CK_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', dollar: '$', euro: '€', pound: '£', yen: '¥', cent: '¢', ndash: '–', mdash: '—', hellip: '...',
  shy: '', zwj: '', zwnj: '', lrm: '', rlm: '', ZeroWidthSpace: '', NoBreak: '', InvisibleTimes: '', InvisibleComma: '', it: '', ic: '', Tab: ' ', NewLine: '\n', colon: ':', period: '.', comma: ',', excl: '!', quest: '?', lowbar: '_', num: '#', percnt: '%' };
const CK_MARKUP = [
  [/~~[^~\n]{0,200}~~|<(s|del|strike)\b[^<>]{0,100}>[\s\S]{0,200}?<\/\1\s*>/gi, ''],
  [/<!--[\s\S]{0,500}?-->/g, ''],
  [/<\/?[a-z][a-z0-9-]{0,20}(?:\s[^<>]{0,200})?\/?>/gi, ''],
  [/\[(?=[^\]\n]{1,200}\]\([^)\s]{0,500}\))/g, ''],
  [/(?<=\S)\]\([^)\s]{0,500}\)/g, ''],
  [/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]*/gm, ''],
  [/^[ \t]*\|[ \t]*|[ \t]*\|[ \t]*$/gm, ''],
  [/[ \t]+\|[ \t]+/g, ' '],
  [/\*\*|__|`/g, ''],
  [/(?<=^|[\s(\[])[*_](?=\S)|(?<=\S)[*_](?=$|[\s.,;:!?)\]])/gm, ''],
];
// Small capitals and Cherokee letters that look like Latin ones (UTS #39 confusables).
const CK_LETTERLIKE = { 'ᴀ':'a','ʙ':'b','ᴄ':'c','ᴅ':'d','ᴇ':'e','ꜰ':'f','ɢ':'g','ʜ':'h','ɪ':'i','ᴊ':'j','ᴋ':'k','ʟ':'l','ᴍ':'m','ɴ':'n','ᴏ':'o','ᴘ':'p','ʀ':'r','ꜱ':'s','ᴛ':'t','ᴜ':'u','ᴠ':'v','ᴡ':'w','ʏ':'y','ᴢ':'z',
  'Ꭰ':'D','Ꭱ':'R','Ꭲ':'T','Ꭵ':'i','Ꭺ':'A','Ꭻ':'J','Ꭼ':'E','Ꮃ':'W','Ꮆ':'G','Ꮇ':'M','Ꮋ':'H','Ꮐ':'G','Ꮓ':'Z','Ꮜ':'U','Ꮪ':'S','Ꮮ':'L','Ꮯ':'C','Ꮲ':'P','Ꮶ':'K','Ᏼ':'B','Ꮩ':'V' };
const CK_PERIOD = String.raw`(?:\s*\/\s*(?:mo|month|yr|year)\b|\s+(?:a|per|each|every)\s+(?:month|mo|year|yr|seat|user)\b|\s+(?:monthly|annually|yearly)\b)`;
const CK_W10_99 = String.raw`(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)`;
const CK_W1_99 = String.raw`(?:${CK_W10_99}|one|two|three|four|five|six|seven|eight|nine)`;
const CK_BARE_PRICE = new RegExp(String.raw`(?<=(?:\b(?:is|are|costs?|for|at|priced\s+at|just|only)|:)\s+(?:just\s+|only\s+)?)(?:(\d+(?:\.\d{1,2})?)(?=${CK_PERIOD})|(${CK_W1_99})(?:[\s-]+(${CK_W10_99}))?(?=${CK_PERIOD})|(${CK_W1_99})[\s-]+(${CK_W10_99})(?=\s*[.!?;]|\s*$|\s+and\b))`, 'gi');
const CK_SPELLED = new RegExp(String.raw`\b((?:(?:${Object.keys(CK_NUM_WORDS).join('|')}|hundred|thousand)(?:[\s-]+(?:and[\s-]+)?|(?=\s?(?:dollars?|bucks|usd|cents?)\b)))+)(?=\s?(?:dollars?|bucks|usd|cents?)\b)`, 'gi');
const ckWordsToNumber = phrase => { let total = 0, cur = 0, any = false; for (const w of phrase.toLowerCase().split(/[\s-]+/).filter(x => x && x !== 'and')) { if (w in CK_NUM_WORDS) { cur += CK_NUM_WORDS[w]; any = true; } else if (w === 'hundred') { cur = (cur || 1) * 100; any = true; } else if (w === 'thousand') { total += (cur || 1) * 1000; cur = 0; any = true; } } return any ? total + cur : null; };
// Spanish, Portuguese and French number words, accent-stripped as ckNormalize leaves them. As in English, they are read as
// an amount only right before a currency word ("veintinueve dólares", "vingt-neuf dollars"), so ages and counts stay prose.
const CK_ROMANCE_NUM = Object.assign(Object.create(null), {
  cero:0,uno:1,un:1,una:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10,once:11,doce:12,trece:13,catorce:14,quince:15,
  dieciseis:16,diecisiete:17,dieciocho:18,diecinueve:19,veinte:20,veintiun:21,veintiuno:21,veintiuna:21,veintidos:22,veintitres:23,veinticuatro:24,
  veinticinco:25,veintiseis:26,veintisiete:27,veintiocho:28,veintinueve:29,treinta:30,cuarenta:40,cincuenta:50,sesenta:60,setenta:70,ochenta:80,noventa:90,
  zero:0,um:1,uma:1,dois:2,duas:2,quatro:4,sete:7,oito:8,nove:9,dez:10,onze:11,doze:12,treze:13,catorze:14,quatorze:14,quinze:15,dezesseis:16,dezasseis:16,
  dezessete:17,dezassete:17,dezoito:18,dezenove:19,dezanove:19,vinte:20,trinta:30,quarenta:40,cinquenta:50,sessenta:60,oitenta:80,
  une:1,deux:2,trois:3,quatre:4,cinq:5,six:6,sept:7,huit:8,neuf:9,dix:10,douze:12,treize:13,seize:16,vingt:20,vingts:20,trente:30,quarante:40,
  cinquante:50,soixante:60,septante:70,huitante:80,octante:80,nonante:90 });
for (const [w, v] of [['doscient', 200], ['trescient', 300], ['cuatrocient', 400], ['quinient', 500], ['seiscient', 600], ['setecient', 700], ['ochocient', 800], ['novecient', 900],
  ['duzent', 200], ['trezent', 300], ['quatrocent', 400], ['quinhent', 500], ['seiscent', 600], ['setecent', 700], ['oitocent', 800], ['novecent', 900]]) for (const s of ['os', 'as']) CK_ROMANCE_NUM[w + s] = v;
const CK_ROMANCE_CUR = String.raw`\s?(?:dolares|dolar|dollars?|usd|euros?)\b`;
const CK_SPELLED_ROMANCE = new RegExp(String.raw`(?<!(?:\b(?:${Object.keys(CK_NUM_WORDS).join('|')}|hundred|thousand)|[\d.,])[\s-]+)(?<![\d.,])\b((?:\d{1,3}[\s-]+(?=mil(?:le)?\b))?(?:(?:${[...Object.keys(CK_ROMANCE_NUM), 'cien', 'ciento', 'cem', 'cento', 'cents', 'cent', 'mille', 'mil'].sort((a, b) => b.length - a.length).join('|')})(?:[\s-]+(?:(?:y|e|et)[\s-]+)?|(?=${CK_ROMANCE_CUR}))){1,12})(?=${CK_ROMANCE_CUR})`, 'gi');   // capped: a price is never 13 words
// A phrase made only of words English also reads ("six dollars", "twenty-six dollars") is left to CK_SPELLED. Digits only
// lead a thousand ("5 mil dólares"); a number word right after a digit ("1,5 mil", "5 veinte") is not read.
const ckRomanceToNumber = phrase => { let total = 0, cur = 0, own = false;
  for (const w of phrase.toLowerCase().replace(/quatre[\s-]+vingts?/g, 'quatrevingt').split(/[\s-]+/)) {
    if (!w || w === 'y' || w === 'e' || w === 'et') continue;
    if (/^\d+$/.test(w)) { cur += +w; own = true; continue; }
    if (!(w in CK_NUM_WORDS)) own = true;
    if (w === 'quatrevingt') cur += 80;
    else if (w in CK_ROMANCE_NUM) cur += CK_ROMANCE_NUM[w];
    else if (w === 'mil' || w === 'mille') { total += (cur || 1) * 1000; cur = 0; }
    else cur = (cur || 1) * 100; }   // cien, ciento, cem, cento, cent, cents
  return own ? total + cur : null; };
// Chinese and Japanese numerals right before a currency mark digits are already read with (美元, ドル, 元, 円). 元 inside
// a word is not money (三元组 "triple", 二元论 "dualism"), nor is トル in トルク/トルコ. Only whole runs of up to 12 numerals are
// read, with a leading digit amount before a unit ("5万美元" = 50000, "1.5千円" = 1500).
const CK_CJK_DIGIT = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
const CK_SPELLED_CJK = /(?<![\d.,零〇一二两兩三四五六七八九十百千万萬])((?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)?[零〇一二两兩三四五六七八九十百千万萬]{1,12})(?=\s?(?:美元|[トド]ル(?![コク])|円|元(?![组組论論化素件数數宵旦])))/g;
const ckCjkToNumber = s => { const d = /^[\d.,]+/.exec(s)?.[0] ?? '', rest = s.slice(d.length);
  if (d && !/^[十百千万萬]/.test(rest)) return null;
  if (!/[十百千万萬]/.test(rest)) return +[...rest].map(c => CK_CJK_DIGIT[c]).join('');
  let total = 0, sec = 0, num = d ? +d.replace(/,/g, '') : 0;
  for (const c of rest) { if (c in CK_CJK_DIGIT) num = CK_CJK_DIGIT[c];
    else if (c === '万' || c === '萬') { total += ((sec + num) || 1) * 10000; sec = 0; num = 0; }
    else { sec += (num || 1) * (c === '十' ? 10 : c === '百' ? 100 : 1000); num = 0; } }
  return Math.round((total + sec + num) * 100) / 100; };
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
function ckNormalize(text, markup = false) {
  let norm = '', map = [], end = [], i = 0;
  for (const ch of text) {
    const at = i; i += ch.length;
    if (CK_INVISIBLE.test(ch)) continue;
    if (/^[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u0640\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed]$/.test(ch)) continue;   // also Arabic/Hebrew vowel marks and kashida   // a lone combining mark ("g\u0332uarantee")
    const digit = ckDigit(ch);
    const nk = ch.normalize('NFKC'), folded = digit ?? ckEmojiLetter(ch) ?? (ch === '\u{1F4B2}' ? '$' : ch === '\u00df' || ch === '\u1e9e' ? 'ss' : null) ?? CK_CONFUSABLE[ch] ?? CK_GREEK[ch] ?? CK_GREEK[nk] ?? CK_LETTERLIKE[ch]
      // Case variants only after direct entries, so "ГАРАНТИЯ" folds like "гарантия" without turning Greek υ into Y.
      ?? CK_CONFUSABLE[ch.toLowerCase()] ?? CK_GREEK[ch.toLowerCase()] ?? CK_CONFUSABLE[ch.toUpperCase()] ?? nk;   // µ only becomes μ after NFKC
    const out = folded.normalize('NFD').replace(/\p{M}/gu, '') || folded;
    for (const o of out) { norm += o; for (let k = 0; k < o.length; k++) { map.push(at); end.push(i); } }
  }
  let st = { norm, map, end };
  // HTML entities: numeric ("guar&#97;ntee") and named ("&dollar;29", "guar&shy;antee"), mapped back to the whole entity.
  // Invisible characters decode to nothing and a no-break space to a space, as they would if typed directly.
  st = ckRewrite(st, /&(?:#(?:[xX]([0-9a-fA-F]{1,6})|(\d{1,7}))|([A-Za-z]{2,24}));/g, m => {
    if (m[3] !== undefined) return Object.hasOwn(CK_ENTITY, m[3]) ? CK_ENTITY[m[3]] : null;
    const c = m[1] ? parseInt(m[1], 16) : +m[2]; if (!(c > 0 && c <= 0x10ffff)) return null;
    const ch = String.fromCodePoint(c); return CK_INVISIBLE.test(ch) ? '' : ch === ' ' ? ' ' : ch.normalize('NFKC'); });
  // Markup the reader never sees as text: struck-through content, comments, tags, link targets, list and table syntax,
  // emphasis and code marks ("I **refunded** you", "guar<!-- -->antee", "I ~~did not~~ refunded you").
  if (markup) for (const [rx, r] of CK_MARKUP) st = ckRewrite(st, rx, () => r);
  // Prices in structured data ('{"plan":"Pro","price":29}', 'price: 29') are dollar amounts. Keys that usually hold
  // cents (amount, unit_amount) are left alone.
  st = ckRewrite(st, /(?<=["']?(?<![A-Za-z0-9_])(?:price|cost|total|price_usd|monthly_price)["']?\s*[:=]\s*)\d+(?:\.\d{1,2})?(?![\d.]|\s*(?:dollars?|usd|bucks|cents?|%|\u00a2))/gi, m => '$' + m[0]);
  // Bare-number prices: after a price word and before a billing period a number is dollars ("Pro is 29 a month",
  // "just 29/mo", "twenty-nine a month"); a spelled dollars-and-cents pair needs no period ("forty-nine ninety-nine").
  st = ckRewrite(st, CK_BARE_PRICE, m => { if (m[1] !== undefined) return '$' + m[1];
    const d = ckWordsToNumber(m[2] ?? m[4]), c = m[3] ?? m[5]; return d === null ? null : '$' + d + (c === undefined ? '' : '.' + String(ckWordsToNumber(c)).padStart(2, '0')); });
  st = ckRewrite(st, /(?<![A-Za-z])(?:[A-Za-z][-._](?=[A-Za-z]))+[A-Za-z](?![A-Za-z])|(?<![A-Za-z])(?:[A-Za-z] (?=[A-Za-z]))+[A-Za-z](?![A-Za-z])/g, m => { const letters = m[0].replace(/[-._ ]/g, ''); return letters.length >= 4 ? letters : null; });
  st = ckRewrite(st, CK_SPELLED_ROMANCE, m => {
    // English 'a mil' is ambiguous slang, not evidence of the Romance value 1000.
    if (/^mil\s*$/.test(m[1]) && /\ba\s+$/.test(m.input.slice(0, m.index))) return null;
    const v = ckRomanceToNumber(m[1]); return v === null ? null : String(v) + (/\s$/.test(m[1]) ? ' ' : ''); });
  st = ckRewrite(st, CK_SPELLED_CJK, m => { const v = ckCjkToNumber(m[1]); return v === null ? null : String(v); });
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
// The same name with digits straight after it ("Pro29美元"). A name ending in a digit ("Plan5") is never glued to a number.
const ckGluedNameRx = name => { const n = ckNormalize(name).norm.trim(); if (!/[A-Za-z]$/.test(n)) return null;
  return new RegExp('(?<![A-Za-z0-9_])' + n.split(/[\s\-\u2010-\u2015]+/).map(ckEsc).join(CK_NAME_GAP) + '(?=\\d)', 'gi'); };
// An amount glued after a Latin letter and followed by a CJK or Korean currency mark. Latin currency words and codes are
// left out: "Q4 USD" and "FY2026 dollars" are labels, not prices.
const CK_GLUED_AMOUNT = new RegExp(String.raw`(?<=[A-Za-z])((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s?(美元|[トド]ル(?![コク])|円|元(?![组組论論化素件数數宵旦])|${'달러'.normalize('NFD')})`, 'g');
const CK_GLUED_HINT = new RegExp(String.raw`[A-Za-z]\d[\d,.]*\s?(?:美元|[トド]ル|円|元|${'달러'.normalize('NFD')})`);
// Digit offset in s -> the longest item or alias name written straight before it (ties: the first listed item).
function ckGlued(pol, s) { const at = new Map();
  for (const p of pol.prices) for (const rx of p.grx) if (rx) for (const n of s.matchAll(rx)) { const e = n.index + n[0].length, was = at.get(e); if (!was || n.index < was.start) at.set(e, { start: n.index, p }); }
  return at; }
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
  ckOnly(p, 'policy', ['name', 'description', 'prices', 'forbid', 'actions', 'discounts', 'unknownAmounts']);
  if (p.unknownAmounts !== undefined && p.unknownAmounts !== 'flag' && p.unknownAmounts !== 'allow') bad('policy.unknownAmounts: "flag" or "allow"');
  for (const field of ['name','description']) if (p[field] !== undefined && typeof p[field] !== 'string') bad(`policy.${field}: string`);
  for (const field of ['prices','forbid']) if (p[field] === null) bad(`policy.${field}: array`);
  const prices = p.prices ?? [], forbid = p.forbid ?? [], actions = p.actions ?? {};
  if (!Array.isArray(prices) || prices.length > CHECK_LIMITS.prices) bad(`policy.prices: array of at most ${CHECK_LIMITS.prices}`);
  if (!Array.isArray(forbid) || forbid.length > CHECK_LIMITS.forbid) bad(`policy.forbid: array of at most ${CHECK_LIMITS.forbid}`);
  if (typeof actions !== 'object' || Array.isArray(actions) || Object.keys(actions).length > CHECK_LIMITS.actions) bad(`policy.actions: object of at most ${CHECK_LIMITS.actions}`);
  // Approved discounts: a claimed "N% off" passes only when listed here, and the discounted price counts as approved.
  if (p.discounts !== undefined && (!Array.isArray(p.discounts) || p.discounts.length > 20)) bad('policy.discounts: array of at most 20');
  const itemNames = new Set(prices.map(x => x?.item));
  const discounts = (p.discounts ?? []).map((d, i) => {
    if (!d || typeof d !== 'object' || Array.isArray(d)) bad(`policy.discounts[${i}]: object`);
    ckOnly(d, `policy.discounts[${i}]`, ['percent', 'items']);
    if (typeof d.percent !== 'number' || !(d.percent > 0 && d.percent <= 100)) bad(`policy.discounts[${i}].percent: number above 0, at most 100`);
    if (d.items !== undefined && (!Array.isArray(d.items) || !d.items.length || d.items.length > CHECK_LIMITS.prices || !d.items.every(x => typeof x === 'string' && itemNames.has(x)))) bad(`policy.discounts[${i}].items: item names from policy.prices`);
    return { percent: d.percent, items: d.items ? [...d.items] : null };
  });
  return {
    discounts,
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
      const ok = [...amounts, ...discounts.filter(d => !d.items || d.items.includes(x.item)).flatMap(d => amounts.map(a => Math.round(a * (100 - d.percent)) / 100))];
      return { item: x.item, amounts, ok, rx: aliases.map(ckNameRx), grx: aliases.map(ckGluedNameRx) };
    }),
    forbid: forbid.map((x, i) => {
      if (!x || typeof x !== 'object' || Array.isArray(x)) bad(`policy.forbid[${i}]: object`);
      ckOnly(x, `policy.forbid[${i}]`, ['id', 'phrases', 'why', 'negatable', 'match']);
      if (x.why !== undefined && (typeof x.why !== 'string' || x.why.length > 200)) bad(`policy.forbid[${i}].why: string of at most 200 chars`);
      if (x.negatable !== undefined && typeof x.negatable !== 'boolean') bad(`policy.forbid[${i}].negatable: boolean`);
      if (x.match !== undefined && x.match !== 'word' && x.match !== 'prefix') bad(`policy.forbid[${i}].match: "word" or "prefix"`);
      if (!ckStr(x?.id, 40) || !/^[a-z0-9-]+$/.test(x.id)) bad(`policy.forbid[${i}].id: lowercase slug`);
      if (!Array.isArray(x.phrases) || !x.phrases.length || x.phrases.length > CHECK_LIMITS.phrases || !x.phrases.every(s => ckStr(s, CHECK_LIMITS.phraseChars) && ckNormalize(s).norm.trim().length > 0)) bad(`policy.forbid[${i}].phrases: 1-${CHECK_LIMITS.phrases} literal strings`);
      return { id: x.id, why: ckStr(x.why, 200) ? x.why : 'Not approved by this policy.', negatable: x.negatable !== false,
        rx: new RegExp(x.phrases.map(phrase => {
          const normalized = ckNormalize(phrase).norm.trim();
          const literal = ckPhrase(normalized);
          // Prefix matching is opt-in. Letters may extend the match, with word boundaries at both ends.
          if (x.match === 'prefix' && /[A-Za-zÀ-ÖØ-öø-ɏ]$/.test(normalized)) {
            return '(?<![A-Za-zÀ-ÖØ-öø-ɏ0-9_])' + literal + '[A-Za-zÀ-ÖØ-öø-ɏ]*(?![A-Za-zÀ-ÖØ-öø-ɏ0-9_])';
          }
          return '(?<![a-zA-Z0-9_])' + literal + (/[a-z]$/i.test(phrase) ? '(?:s|es|d|ed|ing)?' : '') + '(?![a-zA-Z0-9_])';
        }).join('|'), 'gi') };
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
  effects.forEach((e, i) => ckOnly(e, `record.effects[${i}]`, ['operation', 'status']));
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
  // Replies are read with markup stripped. Forbidden phrases are also tried on the text with markup kept, so a policy can
  // forbid markup itself ("<img src=x onerror=...>") while "guar<b></b>antee" is still caught.
  const n = ckNormalize(reply, true), text = n.norm, out = [], raw = ckNormalize(reply);
  const add = (rule, at, len, why) => { const span = n.from(at, at + len); out.push({ rule, span, text: reply.slice(span[0], span[1]), why }); };
  if (!text.trim()) return { pass: false, findings: [{ rule: 'empty', span: [0, 0], text: '', why: 'No reply.' }] };
  // Bidi overrides and isolates can make the text a customer sees differ from the text checked ("\u202eeetnaraug"): fail closed.
  { const b = /[\u202a-\u202e\u2066-\u2069]/.exec(reply); if (b) out.push({ rule: 'text:bidi_control', span: [b.index, b.index + 1], text: reply[b.index], why: 'Bidirectional control characters can hide what the reader sees.' }); }
  for (const f of pol.forbid) find: for (const v of [n, raw]) for (const m of v.norm.matchAll(f.rx)) {
    if (f.negatable && ckNegated(v.norm, m.index)) continue;
    const span = v.from(m.index, m.index + m[0].length); out.push({ rule: 'forbid:' + f.id, span, text: reply.slice(span[0], span[1]), why: f.why }); break find;
  }
  if (pol.prices.length) for (const m of text.matchAll(CK_DISCOUNT)) {
    const pct = ckDiscountPct(m); if (pct === null || ckNegated(text, m.index)) continue;
    // Items named in the same sentence decide which approved discount applies; none named means everything.
    const stops = ['.', '!', '?', ';', '\n'], a = Math.max(...stops.map(c => text.lastIndexOf(c, m.index - 1))) + 1, ends = stops.map(c => text.indexOf(c, m.index + m[0].length)).filter(i => i >= 0);
    const named = [...new Set(ckMentions(pol, text.slice(a, ends.length ? Math.min(...ends) : text.length)).map(x => x.p.item))];
    if (pol.discounts.some(d => d.percent === pct && (!d.items || (named.length && named.every(i => d.items.includes(i)))))) continue;
    add('price:discount', m.index, m[0].length, pol.discounts.length
      ? `${pct}% off${named.length ? ' ' + named.join(', ') : ''} is not an approved discount. Approved: ${pol.discounts.map(d => d.percent + '%' + (d.items ? ' ' + d.items.join(', ') : '')).join('; ')}.`
      : `A discount the policy does not list. Approved: ${pol.prices.map(p => p.item + ' ' + p.amounts.map(a => '$' + a).join(' or ')).join(', ')}.`);
  }
  // Sentences: a period ends one unless it is a decimal point or ends a common abbreviation ("approx. €29" stays with "Pro").
  for (const sm of text.matchAll(/(?:[^.!?;\n]|\.(?=\d)|(?<=\b(?:approx|ca|vs|incl|excl|est|etc|e\.g|i\.e))\.)+[.!?;]?/gi)) {
    const s = sm[0]; let mentions = null; const ment = () => mentions ??= ckMentions(pol, s), consumed = [];
    const taken = (a, b) => consumed.some(([x, y]) => a < y && b > x);
    const money = v => '$' + (Math.round(v * 100) / 100);
    // One price claim at sentence offset `at`: attribute it (with any list it closes) and compare.
    const claim = (at, len, v, said) => {
      const best = ckAttribute(ment(), at);
      if (!best) { if (pol.unknownAmounts === 'flag') add('price:unattributed', sm.index + at, len, 'A dollar figure not tied to any approved price.'); return; }
      for (const p of ckListed(s, mentions, best, at)) if (!p.ok.some(a => Math.abs(a - v) < 1e-9)) add('price:mismatch', sm.index + at, len, `${p.item} is ${p.amounts.map(a => '$' + a).join(' or ')}, not ${said ?? money(v)}.`);
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
    // "Pro29美元", "Pro二十九美元": an amount written straight after an item name, the usual spacing in Chinese and Japanese.
    // Read here only, so forbid and action rules keep the text as written ("Pro49" can still be a forbidden SKU). A glued
    // run inside a longer configured name ("Plan5美元" when Plan5 is an item) belongs to that name and is not read.
    if (pol.prices.length && CK_GLUED_HINT.test(s)) { const glued = ckGlued(pol, s);
      for (const m of s.matchAll(CK_GLUED_AMOUNT)) {
        const g = glued.get(m.index); if (!g || taken(m.index, m.index + m[0].length) || ment().some(x => x.start < m.index && x.end > m.index)) continue;
        const usd = !/^[円元]/.test(m[2]), v = usd ? parseFloat(m[1].replace(/,/g, '')) : NaN; consumed.push([m.index, m.index + m[0].length]);
        if (!g.p.ok.some(a => Math.abs(a - v) < 1e-9)) add('price:mismatch', sm.index + m.index, m[0].length, `${g.p.item} is ${g.p.amounts.map(a => '$' + a).join(' or ')}, not ${usd ? money(v) : m[0].trim()}.`);
      } }
    if (pol.prices.length && CK_FREE_HINT.test(s)) for (const n of ment()) {
      const f = CK_FREE_AFTER.exec(s.slice(n.end)); if (!f || n.p.ok.includes(0)) continue;
      add('price:mismatch', sm.index + n.end + f.index + f[0].indexOf(f[1]), f[1].length, `${n.p.item} is ${n.p.amounts.map(a => '$' + a).join(' or ')}, not free.`);
    }
  }
  // "Once it's fixed", "If you're refunded": a future condition, not a claim. A past "when" clause still counts.
  const acted = [...text.matchAll(CK_ACTED)].filter(m => {
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    // "Once I have refunded you" is a future condition; simple past and "had refunded" still claim past action.
    const futureForm = /(?:'s|'re|\s+is|\s+are)\b/i.test(m[0]) || /^(?:(?:I|we)(?:'ve|\s+have)\b|you(?:'ve|\s+have)\s+been\b)/i.test(m[0]);
    return !(/\b(?:if|unless)\s*$/i.test(before) || (/\b(?:once|until|soon\s+as)\s*$/i.test(before) && futureForm));
  }), seen = acted.filter(m => Object.prototype.hasOwnProperty.call(pol.actions, m[1].toLowerCase())).map(m => [m.index, m.index + m[0].length]);
  // Extra completion forms count once: skip any span overlapping one already found.
  for (const m of ckMoreActed(text, pol.actions).sort((x, y) => x.index - y.index)) { const e = m.index + m[0].length; if (!seen.some(([a, b]) => m.index < b && e > a)) { seen.push([m.index, e]); acted.push(m); } }
  { const planVerbs = Object.keys(pol.actions).filter(v => CK_PLAN_VERB.test(v));
    if (planVerbs.length) for (const m of text.matchAll(CK_PLAN_NOW)) {
      if (!pol.prices.some(p => p.rx.some(rx => { rx.lastIndex = 0; return rx.test(m[1]); }))) continue;
      if (/\b(?:once|if|when|whenever|after|until|before|unless|soon\s+as)\s*$/i.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
      const len = m[0].length - m[1].length, e = m.index + len; if (seen.some(([a, b]) => m.index < b && e > a)) continue;
      const verb = planVerbs.find(v => rec.done.has(pol.actions[v])) ?? planVerbs[0];
      seen.push([m.index, e]); acted.push({ index: m.index, 0: m[0].slice(0, len).trimEnd(), 1: verb, length: len });
    } }
  // A second action after "and" / "then" / a comma shares the claim's subject ("I've merged X and submitted Y"). Follow the
  // chain only while the word after each connector is a policy verb; "and will submit" or "you, Sam, and booked" stop it.
  const isAct = v => Object.prototype.hasOwnProperty.call(pol.actions, v.toLowerCase());
  for (const m of [...acted]) {
    if (!isAct(m[1])) continue;
    let at = m.index + m[0].length, c;
    while ((c = /^[^.!?;\n]{0,60}?(?:,\s*(?:(?:and|then|plus)\b\s*)?|;\s*|\s*[+&]\s*|[\s(\[]+(?:and|then|plus|as\s+well\s+as)\b\s*)(?:(?:also|then|just|already|finally|even)\s+|(?:went|gone)\s+ahead\s+and\s+|,?\s*as\s+(?:requested|discussed|promised|agreed)\s*,\s*|(?:[\u2600-\u27bf\ufe0f]|[\ud83c-\ud83e][\udc00-\udfff])+\s*)*([a-z]+)\b/i.exec(text.slice(at))) && isAct(c[1])) {
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
  const pub = (Array.isArray(keys) ? keys : []).filter(k => k && k.kty === 'OKP' && k.crv === 'Ed25519' && !k.d).map(k => ({ kty: k.kty, crv: k.crv, kid: k.kid, x: k.x, use: 'sig', alg: 'EdDSA', ...(typeof k.curbi_env === 'string' ? { curbi_env: k.curbi_env } : {}), ...(typeof k.not_before === 'string' ? { not_before: k.not_before } : {}), ...(typeof k.not_after === 'string' ? { not_after: k.not_after } : {}) }));
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


