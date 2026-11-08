# Dogfood: Curbi checks Curbi's own posts

Runs CTO and CAIO outputs (issue comments, commit messages) through the same checker customers use, under [`team-policy.json`](team-policy.json): status claims (merged, deployed, released, published, qualified, renewed, rotated, revoked, pushed, refunded) need a DONE record, and readiness, coverage and security overclaims are findings. Negated mentions pass.

```sh
# Gate a draft before posting. Exit 1 on any finding.
node adapters/dogfood/cli.mjs --draft post.md [--record record.json] [--live]

# Report on posted comments (GitHub list-issue-comments JSON), with records read from GitHub.
NODE_USE_ENV_PROXY=1 node adapters/dogfood/cli.mjs --comments comments.json --roles CTO,CAIO \
  --evidence github --repo Curbi-Inc/curbi-platform --md report.md --json report.json
```

- **Local by default:** the exported production checker runs in process, with no network. `--live` posts the same cases to `CURBI_API` (default `https://api.curbi.io`) in batches of 50, and the report lists any row where live and local differ.
- **Rendering:** fenced blocks (attached check results, code) are dropped, markup is stripped, and the text is split into chunks of at most 4,000 characters at paragraph, line or sentence boundaries. The paragraph that opens "Unsigned Curbi check" is set aside as a mention of the forbidden phrases, and the report counts it.
- **Records from GitHub:** "merged" is backed only by a referenced pull request that reads back as merged. "Deployed" and "qualified" are backed only by a linked Actions run that reads back as a successful deploy or qualification run. Any read that fails stops the report (exit 2) rather than counting as unbacked.

## Limits

- **Unsigned.** Results are not PAP receipts. Records stay `caller_supplied_unverified`, even when read from GitHub.
- **Per post, not per claim.** One merged PR backs every "merged" in that post.
- **No GitHub read for keys, packages or pushes.** Those claims always need a record supplied another way.
- **Telegraphic claims go unread.** The shipped checker reads "I merged #312" and "The key has been renewed", but not "#316 merged at eaa5b55" or "The new key has been renewed". The tests lock these as documented gaps.
- **Mentions are not uses.** A forbidden phrase quoted in a table, or negated far away ("No A, B, C or D claim"), still flags.
