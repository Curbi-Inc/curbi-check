// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
import {test}from'node:test';import assert from'node:assert/strict';import{createStreamChecker}from'../src/stream.mjs';
test('unsafe fallback is refused before any speech is released',()=>{assert.throws(()=>createStreamChecker({policy:{forbid:[{id:'promise',phrases:['guarantee']}]},fallback:'We guarantee results.'}))});
test('invalid stream limits cannot widen the checked reply boundary',()=>{for(const maxChars of [0,-1,4001,Infinity,1.5])assert.throws(()=>createStreamChecker({policy:{},fallback:'Please wait.',maxChars}))});
