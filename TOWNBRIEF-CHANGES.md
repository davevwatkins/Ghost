# TownBrief fork — change log

This file is the source of truth for **every modification this fork makes to upstream
Ghost core**. When an upstream sync (`git merge main` into `townbrief`) hits a conflict,
this log tells you whether to keep ours, theirs, or both.

Rules:
- Prefer building outside core (Content/Admin API, theme, separate app) over editing core.
- Every edit to a file that exists in upstream MUST be logged here.
- New files we add (that upstream doesn't have) rarely conflict — note them, but the
  priority is logging *edits to existing upstream files*.

## Upstream baseline

- Forked from: https://github.com/tryghost/ghost
- `main` = clean mirror, pinned to release tags only (never dev `main`).
- Current pin: **v6.45.0**
- All product work lives on `townbrief` (or feature branches merged into it).

## Update workflow

```
git fetch upstream --tags
git checkout main
git reset --hard <next release tag>     # e.g. v6.46.0
git checkout townbrief
git merge main                          # resolve conflicts using the table below
```

## Edits to existing upstream files

| File | What we changed | Why | Added (tag) |
|------|-----------------|-----|-------------|
| _(none yet)_ | | | |

## New files we added (not in upstream)

| Path | Purpose |
|------|---------|
| TOWNBRIEF-CHANGES.md | This change log. |
