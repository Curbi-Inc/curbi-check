// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
// Thin model-independent client. No LLM credentials, execution token, signer or storage.
export const TOOL_NAMES=Object.freeze(['policy_check','validate_policy','search','export_regression','verify_bundle','fetch']);
export class CurbiClient {
  constructor({name='curbi-agent',url='https://curbi.io/api/mcp',timeout=15000}={}) {
    const u=new URL(url);
    if (u.protocol!=='https:' || u.username || u.password || u.search || u.hash) throw new Error('https_endpoint_required');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('invalid_client_name');
    if (!Number.isSafeInteger(timeout) || timeout<1000 || timeout>60000) throw new Error('invalid_timeout');
    this.client=new Client({name,version:'0.1.0'},{capabilities:{}});
    this.transport=new StreamableHTTPClientTransport(u,{requestInit:{headers:{Accept:'application/json, text/event-stream'},redirect:'manual'}});
    this.timeout=timeout;this.connected=false;
  }
  async connect() {
    await this.client.connect(this.transport,{timeout:this.timeout});
    const result=await this.client.listTools({}, {timeout:this.timeout});
    const names=result.tools.map(t=>t.name);
    if (new Set(names).size!==names.length || TOOL_NAMES.some(n=>!names.includes(n)) || result.tools.some(t=>!TOOL_NAMES.includes(t.name)||t.annotations?.readOnlyHint!==true)) {await this.close();throw new Error('unexpected_tool_inventory');}
    this.tools=result.tools;this.connected=true;return this;
  }
  async call(name,args) {
    if (!this.connected || !TOOL_NAMES.includes(name)) throw new Error('read_only_tool_required');
    if (!args || typeof args!=='object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args),'utf8')>65536) throw new Error('invalid_tool_arguments');
    const result=await this.client.callTool({name,arguments:args},undefined,{timeout:this.timeout});
    if (result.isError) { const e=new Error('curbi_tool_refused');e.result=result;throw e; }
    return result;
  }
  async close() { this.connected=false;await this.client.close(); }
}
