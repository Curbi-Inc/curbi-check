import type {wrapLanguageModel} from 'ai';
export interface Finding {rule:string; span:[number,number]; text:string; why:string}
export interface CheckResult {object:'check'; version:'2026-11-01'; pass:boolean; findings:Finding[]; proof:{authorizationGranted:false; [key:string]:unknown}}
export interface CurbiOptions {policy:Record<string,unknown>; record?:Record<string,unknown>; apiKey?:string; timeoutMs?:number; fetch?:typeof globalThis.fetch}
export class CurbiCheckError extends Error {constructor(code:string,findings?:Finding[]); readonly code:string; readonly findings:Finding[]}
export function checkReply(reply:string, config:CurbiOptions):Promise<CheckResult>;
export function curbiMiddleware(config:CurbiOptions):Exclude<Parameters<typeof wrapLanguageModel>[0]['middleware'], unknown[]>;
