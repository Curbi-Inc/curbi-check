// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
export const CHECKER: string;
export type Outcome = 'act' | 'escalate' | 'hand_off' | 'deny';
export interface DecisionRecord {
  object: 'curbi.decision.v1'; shape: 'systemone' | 'decisions'; provider: string; model: string; model_echo: string | null;
  request_digest: string; response_digest: string; received_at: string | null; bytes_bound: { request: boolean; response: boolean };
  question_id: string; type: string; refused: boolean; options: string[]; probabilities: Record<string, number> | null;
  selected: string | null; confidence: number | null; confidence_source?: 'vendor' | 'derived'; expected_level?: number | null; score_position?: number;
}
export interface NormalizeArgs { provider: string; request?: unknown; response?: unknown; receivedAt?: string; requestBytes?: Uint8Array; responseBytes?: Uint8Array }
export function normalizeSystemone(args: NormalizeArgs): readonly DecisionRecord[];
export function normalizeDecisions(args: NormalizeArgs): readonly DecisionRecord[];
export interface DecisionPolicy { readonly decisions: Readonly<Record<string, unknown>> }
export function compileDecisionPolicy(policy: { decisions: Record<string, unknown> }): DecisionPolicy;
export interface RouteResult { outcome: Outcome; selected: string | null; reasons: string[]; next_model?: string }
export function route(policy: DecisionPolicy, questionId: string, records: readonly DecisionRecord[], opts?: { now?: number }): RouteResult;
export interface DecisionReceipt {
  object: 'curbi.decision-receipt.v1'; v: 1; question_id: string; checker: string; policy_digest: string; record_digests: string[];
  outcome: Outcome; selected: string | null; reasons: string[]; next_model?: string; prev_receipt_digest: string | null;
  signed: false; provider_signed: false; does_not_prove: string; receipt_digest: string;
}
export function decisionReceipt(args: { policy: DecisionPolicy; questionId: string; records: readonly DecisionRecord[]; result: RouteResult; prev?: string | null }): DecisionReceipt;
export function checkAction(policy: DecisionPolicy, questionId: string, result: RouteResult, operation: string): { rule: 'decision:not_acted' | 'decision:contradicted'; why: string }[];
export function canonical(value: unknown): string;
export function digest(value: unknown): string;
