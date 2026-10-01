# Known-defect procedure

> **Draft for counsel review** (2026-10-01, issue #103, Gate D in
> [legal-status.md](../legal-status.md#go-live-gates-in-order)). What the
> operator does when a bug in the model engine that changes results is
> confirmed. It sits beside the
> [incident procedure](./incident-procedure.md), which covers personal
> information; this one covers the figures. Pre-counsel research suggested
> the reasonable-care duty under negligent misstatement and, once fees start,
> the CPA's s54 quality right and s61 point to it
> ([legal-status.md § Counsel review](../legal-status.md)).

## What counts

An **erratum** is a confirmed bug: the engine did something other than its
documented method, and a result a user reads changed
([engine-errata.md](../engine-errata.md)). A method that is sound but open to
judgement is a known limitation instead ([engine-audit.md](../engine-audit.md)),
and this procedure doesn't apply to it. "Confirmed" means reproduced: a
failing test that shows the wrong figure, not a suspicion.

## Steps

| When | What |
| --- | --- |
| **At once**, when it is confirmed | Add its row to [engine-errata.md](../engine-errata.md): a new `ER-<n>`, keyed on `run` or `fit`, the first affected engine version, `open` for the fix, the severity, the conditions under which results change, and the source. Run `pnpm gen:liability`. Ship it in the next backend release, with or without the fix: the row, not the fix, is what tells people. |
| **Automatically**, on the first worker tick after that release | The app flags every run the erratum may affect (below) and emails each affected project's owners once (below). Nothing for the operator to send. |
| **As soon as practical** | Fix it, bump `ENGINE_VERSION`, and set the row's *Fixed in*. The flag then stops at the fixed version; nobody is emailed again for the same projects. |
| **Where an evidence pack was issued** from an affected run | Its verify page already lists the erratum under "Errata found since issue" ([evidence-pack.md § Verification](../evidence-pack.md)). If the severity is High and the conditions plausibly apply, also tell the client in writing (its contact under the [operator agreement](./operator-agreement.md)), so it can decide whether to withdraw or supersede the pack. The client decides; the operator informs. |
| **Record** | Keep a dated note with the erratum: when it was confirmed, the release that carried the row, the release that fixed it, and any client told by hand. The `erratum_notice` rows record who was emailed and when, for 30 days. |

## What the app does

- **The flag.** Every run carries the ids of the errata whose range holds
  its engine version (or, for a `fit` erratum, the engine of the automatic
  calibration its parameters came from), from the engine's list
  (`ENGINE_ERRATA`, backend `errata/runs.ts`). The run list tags such a run
  **May be affected** (the ids in its tooltip), and its header shows **May
  be affected by a known bug** (or *by n known bugs*), which opens the
  validation statement on its errata table, where each erratum's
  conditions are printed. The wording is deliberate: most old runs carry
  some erratum (ER-12 reaches back to engine 1.8.0), and each changes
  results only under its own conditions. The
  validation statement, sign-off statement and evidence report already list
  the errata of the run's engine
  ([engine-errata.md](../engine-errata.md)). The flag means *may* be
  affected: a run is wrong only when the erratum's conditions hold.
- **The email** (`153_erratum_notices.sql`, backend `errata/notices.ts`). On
  each tick the worker hands the list to `app_erratum_sweep`, which looks at
  the runs only for an erratum it hasn't swept with that range (an
  unchanged list costs a lookup per erratum). For each project with a run in
  range it queues one email to each **owner** (a project owner, or an admin
  of the project's team) with a confirmed address that isn't suppressed. The
  tick sends them, each built as its recipient (still an owner, address
  still good). The email names the erratum, its severity, the conditions,
  how many runs may be affected, whether it is fixed, and what to do (check
  the conditions; re-run on the current engine and compare; consider telling
  whoever relies on a published, signed or packed run), with a link to the
  project's runs. It never says the results *are* wrong. Each erratum emails
  a person about a project at most once, even if its range is later widened.
- **Later runs.** A run made after the sweep by an affected engine (an open
  erratum) or with an affected fit is flagged in the app but not emailed:
  the person who made it sees the flag on it.

## Open questions for counsel

- Is an email to the project's owners enough, or should editors, signers of
  affected sign-offs, or farmers shown affected figures hear too?
- Should the email go out before a fix exists (today: yes, as soon as the
  row ships), and does the notice change how the Terms' limitation of
  liability reads for results made after it?
