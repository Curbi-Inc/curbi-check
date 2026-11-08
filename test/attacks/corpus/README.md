# Corpus additions for curbi-platform's attack suite

These files use the curbi-platform attack format (`revenue-engine/claimcheck-web-v14/attacks`). `../corpus.test.mjs` runs them here, under the same rule as the platform's `attacks.test.mjs`:
- every case keeps its verdict and rules;
- an attack must be caught, and a guard must pass;
- `known-open` files are exempt from the attack/guard rule.

Each file carries the AI-agent verification policy.

| File | Cases | Production checker today | Checker on this branch |
|---|---|---|---|
| `session-11.json` | 18 attacks, 14 guards | 0 changed (matched live through the Curbi connector) | 0 changed |
| `session-12.json` | 7 attacks, 8 guards | 9 changed: the 7 attacks pass, and 2 whether-clause guards are flagged | 0 changed |
| `known-open-agent-claims.json` | 2 documented bypasses | they pass (open) | they pass (open) |

**To apply in curbi-platform:**
- Copy `session-11.json` and `known-open-agent-claims.json` to `attacks/` now.
- Copy `session-12.json` only together with the checker change on this branch, in `checker/check-api.js`: the same two edits apply to `v15/check-api.js`. Until that change is deployed, live-attacks would report `session-12.json` as changed.

**What the checker change does:**
1. A passive claim's subject may be up to four words after your/the/our/this/that/my/their, so "Your duplicate charge was refunded." and "The new key has been renewed." are read as claims. The subject stops at clause words (whether, if, that, who…), and negations, questions, conditions and future forms still pass.
2. "whether" joins the condition words, so "Ask your admin whether the key was rotated." is no longer flagged. The production checker flags it today.

The platform corpus, 302 attack-file cases and 66 template cases, gives 0 changed against both checkers. The curbi-check suite passes on both.

**Still open:** "Access granted." and "Done, your access is revoked.". A noun-plus-participle claim with no subject, or "is" plus a participle, isn't read. Closing these needs care, because the same shapes appear in honest status text.
