const URL = 'https://api.curbi.io/v1/check';
const encoder = new TextEncoder();
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export class CurbiCheckError extends Error {
  constructor(code, findings = []) {
    super('Curbi check refused the reply (' + code + ').');
    this.name = 'CurbiCheckError'; this.code = code; this.findings = findings;
  }
}
const fail = code => { throw new CurbiCheckError(code); };
function capture(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { fail('invalid_configuration'); }
}
function bodyFor(reply, policy, record) {
  if (typeof reply !== 'string' || reply.length > 4000 || !plain(policy)) fail('invalid_input');
  if (!(Array.isArray(policy.prices) && policy.prices.length || Array.isArray(policy.forbid) && policy.forbid.length || plain(policy.actions) && Object.keys(policy.actions).length)) fail('no_rules');
  const body = JSON.stringify({policy, reply, ...(record !== undefined ? {record} : {})});
  if (encoder.encode(body).length > 65536) fail('request_too_large');
  return body;
}
function options(config) {
  if (!plain(config)) fail('invalid_configuration');
  const {policy, record, apiKey, timeoutMs = 15000, fetch: fetcher = globalThis.fetch} = config;
  if (typeof fetcher !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
      (apiKey !== undefined && (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(apiKey)))) fail('invalid_configuration');
  const snapshot = capture({policy, ...(record !== undefined ? {record} : {})});
  bodyFor('configuration check', snapshot.policy, snapshot.record);
  return {...snapshot, apiKey, timeoutMs, fetcher};
}
async function boundedJson(response, signal) {
  if (Number(response.headers.get('Content-Length') ?? 0) > 1048576) fail('response_too_large');
  const reader = response.body?.getReader(); if (!reader) fail('missing_response');
  let size = 0; const chunks = [], cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, {once:true}); if (signal.aborted) cancel();
  try {
    for (;;) { const {value,done} = await reader.read(); if (done) break; size += value.byteLength;
      if (size > 1048576) { await reader.cancel(); fail('response_too_large'); } chunks.push(value); }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(all)); } catch { fail('invalid_json'); }
}
function verdict(result, reply) {
  if (!plain(result) || result.object !== 'check' || result.version !== '2026-11-01' || typeof result.pass !== 'boolean' ||
      !Array.isArray(result.findings) || result.findings.length > 4000 || result.pass !== (result.findings.length === 0) ||
      result.proof?.authorizationGranted !== false) fail('invalid_verdict');
  for (const f of result.findings) {
    const s = f?.span;
    if (!plain(f) || typeof f.rule !== 'string' || !f.rule || f.rule.length > 200 || typeof f.text !== 'string' ||
        typeof f.why !== 'string' || f.why.length > 2000 || !Array.isArray(s) || s.length !== 2 || !s.every(Number.isSafeInteger) ||
        s[0] < 0 || s[1] < s[0] || s[1] > reply.length || reply.slice(s[0],s[1]) !== f.text) fail('invalid_finding');
  }
  return result;
}
async function perform(reply, config) {
  const body = bodyFor(reply, config.policy, config.record), controller = new AbortController(); let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new CurbiCheckError('timeout')); },config.timeoutMs); });
  try {
    return await Promise.race([(async () => {
      const response = await config.fetcher(URL, {method:'POST', redirect:'error', signal:controller.signal,
        headers:{'Content-Type':'application/json','Accept':'application/json','User-Agent':'curbi-vercel/0.1.0',...(config.apiKey ? {'Authorization':'Bearer '+config.apiKey} : {})},body});
      if (response.status !== 200) fail('http_'+response.status);
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') ?? '')) fail('non_json');
      return verdict(await boundedJson(response, controller.signal), reply);
    })(), timeout]);
  } catch (error) { if (error instanceof CurbiCheckError) throw error; fail('transport'); }
  finally { clearTimeout(timer); controller.abort(); }
}
export async function checkReply(reply, config) { return perform(reply, options(config)); }
export function curbiMiddleware(config) {
  const captured = options(config);
  return {
    specificationVersion:'v4',
    async wrapGenerate({doGenerate}) {
      const response = await doGenerate();
      if (!Array.isArray(response.content)) fail('invalid_model_content');
      let content;
      try { content = structuredClone(response.content); } catch { fail('invalid_model_content'); }
      if (content.some(p => !plain(p) || typeof p.type !== 'string' || (p.type === 'text' && typeof p.text !== 'string'))) fail('invalid_model_content');
      const text = content.filter(p => p.type === 'text').map(p => p.text).join('');
      const structuredOutputText = response.structuredOutputText;
      if (structuredOutputText !== undefined && structuredOutputText !== text) fail('structured_output_unsupported');
      if (!text.trim()) return {...response,content,structuredOutputText};
      const result = await perform(text,captured);
      if (!result.pass) throw new CurbiCheckError('findings',result.findings);
      return {...response,content,structuredOutputText,providerMetadata:{...response.providerMetadata,curbi:result}};
    },
    async wrapStream() { fail('streaming_unsupported'); },
  };
}
