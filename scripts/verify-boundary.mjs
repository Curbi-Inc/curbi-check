import {readdirSync,readFileSync,lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
const allowedRoot=new Set(['README.md','LICENSE','package.json','package-lock.json','SOURCE-MANIFEST.json','.gitignore','.gitleaks.toml','.github','scripts','checker','mcp','test','adapters','proof','schemas']);
const forbidden=/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|["'](?:d|private_key|client_secret)["']\s*:\s*["'][A-Za-z0-9_+\/-]{30,})/;
let count=0;
function walk(dir,rel='') {for(const name of readdirSync(dir)) {if(!rel&&['node_modules','.git'].includes(name))continue;
 const path=rel?rel+'/'+name:name; const stat=lstatSync(dir+'/'+name);
 assert.ok(!stat.isSymbolicLink(),'Symlink forbidden: '+path);
 if(!rel)assert.ok(allowedRoot.has(name),'Unreviewed root: '+name);
 assert.ok(!/(^|\/)(?:attest|hosted-proof|ledger|\.env(?:\..*)?|wrangler\.toml|log\.mjs|issuer\.mjs)(\/|$)/.test(path),'Private surface: '+path);
 if(stat.isDirectory()){walk(dir+'/'+name,path);continue;}
 const text=readFileSync(dir+'/'+name,'utf8');
 assert.ok(!forbidden.test(text),'Private key material: '+path);
 if(path.endsWith('.mjs')||path.endsWith('.js')) assert.ok(!/(?:from\s*|require\s*\(\s*)["'][^"']*(?:attest|hosted-proof|issuer\.mjs)/.test(text),'Private import: '+path);
 count++;
}}
walk(root);console.log(`Public boundary checked: ${count} files. This supplements secret scanning; it is not a credential detector or approval.`);
