// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
import{test}from'node:test';import assert from'node:assert/strict';import{curbiMiddleware}from'../src/ai-sdk.mjs';import{curbiGuard}from'../src/langchain.mjs';
for(const [name,make] of [['AI SDK',curbiMiddleware],['LangChain',curbiGuard]])test(name+' refuses an unsafe configured fallback',()=>assert.throws(()=>make({policy:{forbid:[{id:'promise',phrases:['guarantee']}]},fallback:'We guarantee results.'})));
