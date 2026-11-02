# Framework package release handoff

These are new distribution candidates, not an assertion that the names are already published. Install commands in the individual READMEs become registry commands after the first release. No publisher identity or token is created by committing this code.

| Registry | Package | GitHub owner / repository | Workflow filename | Environment |
|---|---|---|---|---|
| npm | `@curbi/vercel` | `Curbi-Inc` / `curbi-check` | `publish-npm.yml` | `npm` |
| PyPI | `curbi-langchain` | `Curbi-Inc` / `curbi-check` | `publish-python.yml` | `pypi` |
| PyPI | `curbi-llamaindex` | `Curbi-Inc` / `curbi-check` | `publish-python.yml` | `pypi` |

Commit and merge the reviewed workflows before configuring publisher trust. GitHub-hosted runners are required. Configure the matching GitHub environments with the human release owner and appropriate deployment protection before publishing. Run publishing workflows only from `main`, with the reviewed version and explicit confirmation checkbox. They build/test before handing immutable run artifacts to the publisher job; publishing identity is available only in that job. Neither workflow runs a publish on push or PR.

## npm

1. Human signs in at npmjs.com and verifies ownership of the `@curbi` scope. The existing `curbi` account owns this personal scope; no new organization or paid plan is required. If the scope is unavailable or belongs to someone else, stop instead of silently changing the package name.
2. npm's documented trusted-publisher setup starts in an existing package's settings. For this new package, first publishing/bootstrap must be completed through the account's supported publishing flow; do not invent an existing package or create a permanent token prematurely. The reviewed local tarball and checksum are the release artifact to inspect.
3. After the first package exists, add the exact GitHub trust tuple above in package Settings → Trusted publishing. Permit `npm publish` for the current direct-publish workflow, or deliberately change the workflow to `npm stage publish` if human staged approval is desired. These are separate permissions. A new trust configuration must successfully publish within two days to bind the repository identity.
4. npm CLI must be at least 11.5.1 (Node at least 22.14). The workflow uses Node24 and refuses an older CLI. It uses OIDC and provenance, with no `NPM_TOKEN` secret. Keep 2FA enabled; never paste a credential into chat.

## PyPI

1. Human signs in to pypi.org and opens account Publishing. Add the `curbi-langchain` **pending publisher** using the exact tuple above. Pending registration does not reserve the name and no API token is needed. PyPI refuses a second pending project with an identical publishing identity, so bootstrap these projects sequentially.
2. With the protected `pypi` GitHub environment ready, dispatch `publish-python.yml` selecting `curbi-langchain`, the reviewed version, and explicit confirmation. After successful upload converts its pending publisher into an active publisher, add the `curbi-llamaindex` pending publisher with the same tuple and dispatch again selecting that project. Both wheels are built and tested on each run, but only the selected project is uploaded. Never re-upload an existing version or infer that the other project published.
3. Verify the published wheels/sdists and registry provenance by downloading into a fresh environment and rerunning framework tests. Publishing a version is distinct from preparing and testing it locally.

## Evidence and scope

The Vercel middleware uses the real AI SDK interface; the Python packages use real LangChain and LlamaIndex interfaces. Tests replace HTTP with deterministic local responses and include mutation, error and malformed-verdict paths. Packed/wheel consumers verify that no sibling source directory is required. Live availability, registry ownership, trusted-publisher configuration and a successful public install remain separate observations until completed.

All three packages audit completed text using the managed/public Check API. They do not intercept every tool call, authorize an action, independently confirm a provider outcome, or replace PAP receipt verification. Do not send secrets or customer data in fixtures; policy and reply are transmitted to Curbi. Streaming remains unsupported and is refused.

Official setup references: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [npm organizations](https://docs.npmjs.com/creating-an-organization/), [PyPI pending publishers](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/).

ROI: real installable framework artifacts and exact publishing identities replace ambiguous recipes and manual token handling. — CTO Codex
