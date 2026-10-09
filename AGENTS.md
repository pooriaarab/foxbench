# AGENTS.md

<!-- pr-standards:start -->

## Pull requests

One issue. One PR. One concern. Under 500 counted lines.

Open the issue first. No issue, no branch. The issue number ties the branch, the
title, the body and the merged commit to one agreed piece of work.

```text
branch:  fbn-<issue>-<slug>          fbn-142-fix-onboarding-drop-off
title:   [FBN-<issue>] <Subject>   [FBN-142] Fix onboarding drop-off
body:    Closes #142
         ## What / ## Why / ## How I verified
         Assisted-by: <agent>:<model>
         Assisted-by: <agent>:<model>
```

One `Assisted-by: <agent>:<model>` line per contributor. Repeat the line for
each contributor. A comma-separated list on one line fails the check.

Subject line: imperative mood, 10-50 characters, no trailing period, no emoji.
Write "Fix the drop-off", not "Fixed the drop-off".

Hard caps, failed by the `pr-standards` CI check: 500 counted lines, 40 counted
files, exactly one `Closes #`. Lockfiles, build output, snapshots, generated
code and migrations are not counted. There is no label that clears the cap and
no one to ask for one. Split the change.

Settings for this repo are in `.github/pr-standards.json`. The standard is at
https://github.com/pooriaarab/scripts/blob/main/pr-standards.md

## Merge gates

Run the repo `ci:local` script before every `git push` when it exists.
Else run the same lint, typecheck, and unit tests CI runs.
Do not push a red local gate. Do not use CI as the test runner.

For a change a user can see, or that talks to a third party, walk the
Cloudflare Worker Preview before merge. Quote the Preview URL and status
codes. A 2xx on the site home is not that walk.

Wait for one LLM review APPROVED. Red CI blocks merge even when GitHub
does not require checks.

## Agent presence

Before you cut a branch:

```
bin/fleet-presence claim pooriaarab/<repo> <N> --goal "..." --branch <branch>
```

One sticky GitHub comment per agent. Create once, then PATCH. Same-machine
lock is local. Name harness, model, host, start time, and goal. Do not dump
transcripts. Full rule: pooriaarab/agents-private `rules/fleet-claim.md`.

<!-- pr-standards:end -->

## Layout

```text
src/              the library source, built to dist/ by tsc
tests/            tests for the failure modes in docs/failure-modes.md
docs/failure-modes.md  every way the code can fail, written before the code
.github/          CI, release, PR and issue standards
extension/        the demo extension that shows this repo working in Firefox
scripts/build-ext.mjs  bundles extension/ into dist-ext/ with esbuild
e2e/run.mjs       the Firefox E2E test; writes artifacts/e2e-<date>.json
```

## Commands

```bash
pnpm install
pnpm ci:local   # lint + typecheck + test + build; run before every hand-off
pnpm build:ext  # extension/ -> dist-ext/; fails if the manifest and package.json versions differ
pnpm lint:ext   # web-ext lint on dist-ext/ (part of ci:local)
pnpm e2e        # Firefox E2E; set FIREFOX if Firefox is not in the usual place
```

## Testing

Prefer E2E tests. Do not write unit tests after the code. To test a part in
isolation, first list its failure modes in `docs/failure-modes.md`, then write
the tests, then the code. Commit in that order.

## Release

`main` is staging and `release` is production. A push to `release` runs
`.github/workflows/release.yml`. It refuses a version that has a tag, runs
`pnpm ci:local`, publishes to npm with the `NPM_TOKEN` secret, then tags
`v<version>` and creates a GitHub release.

After the npm publish, it signs `dist-ext/` with AMO on the unlisted channel
and attaches the `.xpi` to the GitHub release. It needs the secrets
`AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. Keep the `version` in
`extension/manifest.json` equal to the one in `package.json`.
