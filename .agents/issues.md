**This file is a stub. Fill it in for this repo before it is useful.**

# Writing issues in this repo

The TODOs below cannot be answered from outside the repo, and a guessed answer
is worse than an empty one.

The standard is [issue-standards.md](https://github.com/pooriaarab/scripts/blob/main/issue-standards.md).
This file holds only what is specific to this repo, and what an agent cannot
work out by reading the standard.

It lives in `.agents/` rather than `.claude/` because codex, pi, kimi and muse
read it too.

## Labels

Every issue carries exactly one from each group. More than one from a group is a
contradiction, not extra information.

| Group | Labels                                              |
| ----- | --------------------------------------------------- |
| Kind  | `bug` `feature` `chore` `epic`                      |
| Size  | `mini` `standard` `deep`                            |
| Route | `route:mechanical` `route:scoped` `route:judgement` |
| State | `triage` `ready-for-agent` `needs-info` `blocked`   |

The forms apply the kind and `triage`. Set size and route yourself.

## Success metrics

Name the repo's analytics helper and one real event. An invented event name sends the next agent looking for code that does not exist.

TODO: name this repo helper and 3 real events.

## High-stakes paths

An issue touching any of these is `route:judgement` whatever its size, because size measures the diff and not the cost of getting it wrong.

| Path | Why a mistake here is expensive |
| ---- | ------------------------------- |
| `path/to/example.ts` | Example placeholder. Replace with a real path. |

TODO: list this repo auth, billing, migration and webhook paths.

## Parents and blockers are native

Use the sub-issues API for a parent and issue dependencies for a blocker. Both
are native GitHub features.

Do not write `Parent: #NNNN` or `Blocked by: #NNNN` in the body. That convention
is deleted. A parent written in prose is a parent no tool knows about.

## Before you file

- Ground every claim about current behaviour in `file:line`. You have read access.
- Verify the flow exists before writing "when a user unpublishes...". If it does
  not, the issue names a feature that does not exist, and that is the finding.
- TODO: name where test accounts and local-versus-staging data live in this repo.
