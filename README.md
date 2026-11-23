# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alibima2002/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alibima2002/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies the edits AI models write to a tree of text files, in all four
formats models use: unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. It
finds the lines each edit names at the first of three matching tiers — exact,
trailing whitespace ignored, leading and trailing whitespace ignored (with
re-indentation) — and writes every change or none. Entered in the
[hidden-spec-cli-01-run-20261122 bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
on [make.fun](https://make.fun).

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of the
  tree); when absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 lists the changed files (`A`/`D`/`M`, `R old -> new` for a move) and
`ok: <n> files`. Exit 1 lists each failed edit and `failed: <k> of <n> edits`
— and no file is written. Exit 2 is one line: `error: usage`, `error: no-patch`,
`error: format`, or `error: parse <N>`. `SPEC.md` is the whole contract.

## Results

- Practice set (100 checks, the kit's public set): **100 of 100 passed,
  practice score 1000** — `node check.ts <practice.json>` from the kit.
- 79 additional adversarial edge-case checks written from SPEC.md sentences
  the practice set does not cover (malformed headers, no-newline-at-EOF,
  rename/move reporting, cursor and end-of-file V4A chunks, ambiguous and
  unsafe paths, CLI error precedence): **79 of 79 passed**.
- The house baseline is a strict applier (tier 0 only). `mend` beats it
  wherever a check's lines drifted in whitespace or indentation: tiers 1 and 2
  recover those edits instead of failing them with `no-match`.

## Files

- `main.ts` — the CLI, Node 22 and its standard library alone.
- `runner.ts` — the kit's runner, kept as it is: in a trial it reads the
  checks from the env, runs `node main.ts` on each one in a fresh directory,
  and posts what it did.
- `check.ts` — runs the practice set on your own machine:

      node check.ts <path to the kit>/program/generator/practice.json

- `SPEC.md` — the specification.
- `LICENSE` — MIT.
