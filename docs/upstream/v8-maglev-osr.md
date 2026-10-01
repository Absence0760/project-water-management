# V8 Maglev OSR miscompile: upstream report

The V8 bug behind issue #192 ([engine-audit.md V1](../engine-audit.md#findings)),
written up for crbug.com/v8 (issue #232). The engine is already safe from it:
`tallyWindow` keeps the loop out of the miscompiled shape, and the
`assurance` self-check redoes every saved run's assurance of supply, so the
bug can't reach a saved run silently. The fix itself is V8's.

**Status: draft, not filed.** The operator files it. Read
[Before posting](#before-posting) first. Everything below the
[report](#the-report) heading can be pasted into a new crbug.com/v8 issue
(component Blink>JavaScript>Compiler>Maglev).

## What we know and what we don't

| Platform | Node (V8) | Result | Source |
|---|---|---|---|
| linux/arm64 (docker) | 24.21.0 (13.6.233.17-node.53) | fails: 34 of 64 stressed runs over the sweeps, 30–75 % of processes at one N | issue #192 |
| macOS arm64 | 25.6.1 (14.1.146.11-node.19) | fails | issue #192 |
| linux/x64 (GitHub Actions) | 24 | failed once, unstressed, in CI's prefix-stability test | issue #192 |
| linux/x64, 4 vCPU | 24.21.0 (13.6.233.17-node.53) | 0 of 123 stressed runs wrong | issue #232, 2026-10-01 |
| linux/x64, 4 vCPU | 22.22.0 (12.4.254.21-node.33) | 0 of 60 stressed runs wrong | issue #232, 2026-10-01 |
| linux/x64, 4 vCPU | 25.6.1 (14.1.146.11-node.19) | 0 of 60 stressed runs wrong | issue #232, 2026-10-01 |

The x64 sweeps were the `pnpm test:backend:v8-osr` defaults: N = 1800,
2200, 2600, 2900 and 3200, two processes each, six full runs per process.
Node 24 also ran N = 1500, 3500, 4000 and 5000 the same way, plus one
process of 15 runs at N = 2900. So the stress reproduces the fault on arm64
but not, so far, on x64, even though x64 is
where it first showed up (once, in CI). Node 22's clean x64 sweep says
nothing about Node 22 on arm64, which nobody has tested yet.

The flag table below comes from the arm64 runs in #192, and the two
harnesses there partly disagreed. x64 can't re-check it, because x64
doesn't fail without flags either. Re-check it on an arm64 machine (any
Apple Silicon Mac will do) before filing:

```
pnpm test:backend:v8-osr -- --no-maglev-osr
pnpm test:backend:v8-osr -- --no-concurrent-recompilation
pnpm test:backend:v8-osr -- --single-threaded
pnpm test:backend:v8-osr -- --no-maglev
pnpm test:backend:v8-osr -- --no-osr-from-maglev
pnpm test:backend:v8-osr -- --no-use-osr
pnpm test:backend:v8-osr -- --no-concurrent-osr
```

Each prints one line per process and a total, and exits 1 when a run went
wrong. Paste the totals into the report's flag table.

### The standalone reduction

V8 wants a standalone script, and there isn't one yet. A 150-line harness
holds the pre-fix `nodeReliability` and the calendar helpers verbatim, and
feeds them four synthetic farms of 5 479 days, freshly allocated each round
or reused, with garbage in between. It never failed on x64 Node 24, under
any of these:

- no flags;
- `--deopt-every-n-times` at N = 500 … 5000;
- `--no-concurrent-osr`, `--no-turbofan`, `--always-osr`, `--stress-maglev`
  or `--jit-fuzzing`;
- `%OptimizeOsr()` forced inside the loop.

Its `--trace-osr --trace-deopt` shows the sequence the issue describes: the
Maglev OSR code for the loop is compiled once and entered again on the next
calls, which then eagerly deopt after the loop. The results stay right
anyway, so that sequence isn't enough by itself. The full engine run adds
something the harness lacks, such as other functions competing for the
concurrent compiler or a GC between OSR compile and entry. The next steps
for a reduction, on arm64 where the fault shows:

1. Delete whole engine modules from the bundle, with the stress command as
   the pass/fail test. The bundle comes from `buildBundle` in
   `backend/scripts/v8-osr-stress.ts`.
2. Or replay the full run's calls to `supplyAssurance`. The inputs can be
   dumped from the bundle: four Float64Array pairs of 5 479 days for
   Sandspruit's farms. Then add back the engine's other work, piece by
   piece, until the harness fails.

If no reduction comes, file anyway with the bundle. V8's triage accepts a
large repro when it is deterministic enough to bisect, and this one fails
about half the time on arm64.

## Before posting

- [ ] The flag table is re-checked on arm64 (above).
- [ ] Any attached bundle is built with `buildBundle` from this public repo
      at `47e1ddb1^`, which holds only invented example catchments.
      `pnpm check:terms` passes over this file and the attachment.
- [ ] The operator has read the report and the attachment.
- [ ] Once it is filed, link the crbug issue from issue #232 and from
      [followups.md](../followups.md). A nodejs/node issue is worth filing
      only if V8 confirms the bug and the fix needs backporting to a Node
      LTS line.

## The report

**Title:** [maglev] OSR code for a loop reads the arrays of an earlier
call's argument object (wrong results, Node 24 / V8 13.6, arm64)

**Summary.** With Maglev and TurboFan both on, a function with a long loop
over two typed arrays, read through a property of an object argument
(`n.demand[t]`, `n.supplied[t]`), sometimes returns the sums of the arrays
passed on an *earlier* call. Properties read outside the loop (`n.nodeId`)
are those of the current call. The function is called once per object, with
four objects of four Float64Arrays of 5 479 elements. The wrong result is
always exactly another call's result, never garbage.

**Versions.**

- Fails: Node v24.21.0 (V8 13.6.233.17-node.53) on linux/arm64 (docker);
  Node v25.6.1 (V8 14.1.146.11-node.19) on macOS arm64.
- Seen once on linux/x64 Node 24, unstressed.
- Not reproduced under stress on linux/x64: Node 22.22.0, 24.21.0 or
  25.6.1. Not tried: d8.

**Reproduction.**

```
git clone https://github.com/Absence0760/project-water-management
cd project-water-management && pnpm install
pnpm test:backend:v8-osr          # exit 1 and "k of n runs wrong" when it reproduces
```

That bundles the pre-fix code (git revision `47e1ddb1^`, about 650 KB)
with esbuild and runs it as
`node --deopt-every-n-times=N <bundle>.mjs 6` for N from 1800 to 3200.
Each run's result is compared with an unstressed run's. On arm64 about
30–75 % of processes give a wrong result at a given N. Without
`--deopt-every-n-times` it is rare: it surfaced once in CI. The function
is `nodeReliability` in `packages/engine/src/network/reliability.ts` at
that revision.

**Flags (arm64).**

| Flag | Result |
|---|---|
| none | fails |
| `--no-maglev-osr` | clean |
| `--no-concurrent-recompilation` | clean |
| `--single-threaded` | clean |
| `--no-maglev` | clean in about 110 runs of one harness, 1 of 8 processes failed in another |
| `--no-osr-from-maglev` | fails |
| `--no-use-osr` | fails |
| `--no-concurrent-osr` | one harness failed far more often, the other was clean |

**What `--trace-osr --trace-deopt` shows** (inferred, not confirmed from a
code dump). Maglev compiles OSR code for the loop concurrently during one
call. Later calls for other objects enter that cached OSR code at the loop
back edge. They then deopt eagerly at the first named property load after
the loop ("Insufficient type feedback for generic named access"). In a
failing run the loop has used the earlier call's arrays by then.

**Workaround.** Moving the loop into its own function that takes the arrays
as parameters avoids it: 0 wrong in 88 stressed runs, against 34 in 64
before. Loading the arrays into locals before the loop did not help.
