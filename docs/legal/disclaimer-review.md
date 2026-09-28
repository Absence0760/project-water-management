# Disclaimer and sign-off wording: pack for the legal review

Roadmap WP-3.13, decision D10, issue #47. This file is what to send the
client's legal adviser. It quotes, word for word, every liability text the app
shows: the report disclaimer, the professional sign-off statement, and the
short lines a farmer sees in the farm view and in alert emails. Tests keep the
quotes current. `packages/engine/src/liability/disclaimer.test.ts` checks the
report disclaimer and the sign-off statement,
`frontend/src/lib/components/farm/disclaimer.test.ts` the farm view line, and
`backend/src/mail/i18n/liability.test.ts` the alert email lines. If code
changes a word, one of those tests fails until this file quotes the new text.

**State today: draft.** Nothing below is agreed wording. Until
`DISCLAIMER.status` is `agreed`, the report and the outlook panel print
*Draft wording, pending the client’s legal review (decision D10).* beside the
disclaimer.

## 1. The report disclaimer

Source: `packages/engine/src/liability/disclaimer.ts`, `DISCLAIMER`.
Version `draft-2026-09-26`, status `draft`. English only.

Where it is shown:

- The last section of every catchment report (the report page and the
  server-rendered PDF), all four paragraphs, with its version.
- The seasonal outlook panel on the River tab: paragraphs 1 and 3 only.
- A sign-off records the disclaimer version the signer was shown.

Who reads it: hydrologists, WUA managers, licence applicants and assessors.
Farmers don't see it (see § 3).

> 1. These results come from a computer model of the catchment. They are estimates made from the historical record of rainfall and flow, not measurements or forecasts, and they can be wrong.
> 2. This report supports, and does not replace, the specialist hydrology report. Any decision on a water-use licence belongs to the responsible authority (National Water Act, sections 27 and 41).
> 3. Modelled shortfalls, curtailment and equitable shares are not official restrictions or allocations. Only a notice from the Water User Association or the responsible authority is.
> 4. The platform operator gives no hydrological opinion. The model, its inputs and its results are the responsibility of the person who made the run and, where the run is signed off, of the professional who signed it.

## 2. The professional sign-off statement

Source: `packages/engine/src/liability/signoff.ts`, `signoffStatement()`.
Version `signoff-1`. English only.

A registered professional signs one model run. The dialog shows five
confirmations, each ticked on its own, then the run's known limitations
(generated from `docs/engine-audit.md`), then three notes that are printed but
not confirmed. The signer enters their name, professional body and
registration number. The backend stores a SHA-256 hash of the exact statement
shown, so a signature is bound to these words and to the version numbers. The
report's sign-off section lists each signature with the versions and hash it
recorded.

Confirmations:

> 1. The calibration and the observed record chosen for it are appropriate for this catchment.
> 2. The EWR tables and their source are correct for the EWR sites in this run.
> 3. *(a baseline run)* The modelled network represents the existing works and water use of the catchment.
>    *(a scenario run, instead)* The scenario represents the proposed works and water use.
> 4. The assurance levels and demand patterns used suit the water use assessed.
> 5. I have read the known limitations listed below and considered them for this run.

Notes printed with the statement:

> - The registration number is self-declared. This app does not check it against the professional body’s register.
> - Dams higher than 5 m with a capacity above 50 000 m³ also need a dam safety classification (DW793) by others; this sign-off does not cover it.
> - The signature covers this run only, as it was made. A later run, even of the same inputs, is not signed.

## 3. What a farmer sees (English and Afrikaans)

The farm view and the alert emails don't show the report disclaimer. They
carry their own short lines, translated into Afrikaans. These are not
versioned and don't show a draft note, so the review has to cover them
explicitly, in both languages.

**Farm view**, under the farm's figures (`frontend/src/lib/components/farm/cards.ts`, `disclaimer()`):

> These figures come from a computer model of the catchment. They can be wrong. Only a notice from your WUA is a restriction.

> Hierdie syfers kom van ’n rekenaarmodel van die opvanggebied. Hulle kan verkeerd wees. Net ’n kennisgewing van jou WGV is ’n beperking.

**Alert emails** about a modelled figure, such as a dam running low or an EWR
miss (`backend/src/mail/i18n/en.ts`, `mail.alert.model`):

> This comes from the catchment model: an estimate from the figures the WUA published, not a measurement, and not an instruction. Check with your WUA before you act on it.

> Dit kom van die opvanggebied se model: ’n skatting uit die syfers wat die WGV gepubliseer het, nie ’n meting nie, en nie ’n opdrag nie. Vra eers jou WGV voordat jy daarop optree.

**Alert emails** about a WUA restriction notice (`mail.alert.restriction.wua`):

> This notice is the WUA’s own. It is shown here as the WUA published it.

> Hierdie kennisgewing is die WGV s’n. Dit word hier gewys soos die WGV dit gepubliseer het.

### Is an Afrikaans version of the report disclaimer needed?

**No, as the app stands.** The report, the outlook panel and the sign-off are
workspace screens, and the workspace is English only (`docs/ui.md` §
Language). No farmer-facing page shows `DISCLAIMER`. The farmer lines above
already have Afrikaans versions, so the adviser should check both languages of
those lines. If a farmer page ever shows the full disclaimer, it would need an
Afrikaans version too, reviewed the same way.

## 4. Questions for the adviser

1. Does paragraph 4 limit the platform operator's liability enough, and can it
   be enforced against a reader who never agreed to any terms, such as a
   licence assessor reading a PDF someone sent them?
2. Should the report disclaimer refer to terms of use, and do those terms
   exist yet?
3. Do the five confirmations fit what a registered professional (for example,
   under ECSA or SACNASP) can properly certify? Is anything missing?
4. Is the self-declared registration number acceptable, or must the app check
   it before a signature appears on a report?
5. Do the farmer lines, in English and Afrikaans, say clearly enough that the
   figures are estimates and not instructions?
6. Does anything need to be said about the rain-forecast inputs (CHIRPS-GEFS)
   in the outlook and the forecast alerts?

## 5. When the wording is agreed

1. Put the agreed text in `DISCLAIMER.paragraphs`. Set `version` to a
   non-draft value, such as `2026-10-15`, and set `status` to `agreed`.
   `disclaimer.test.ts` refuses a `draft-` version with an `agreed` status, and
   a non-`draft-` version with a `draft` status.
2. If any sign-off wording changed, change it in `signoff.ts` and bump
   `SIGNOFF_STATEMENT_VERSION` (`signoff-2`). A new disclaimer version also
   changes the statement's hash, because `disclaimerVersion` is part of it.
3. Change any farmer line in its source. Send the Afrikaans through the
   `af-translator` and `af-checker` agents and `pnpm gen:i18n:apply`, then run
   `pnpm gen:i18n:sheet`. For those lines, use the Afrikaans the adviser
   agreed.
4. Update the quotes in this file. The tests named at the top fail until you
   do.
5. Tick the item in `docs/followups.md` § Blocking releases (operator) and
   close issue #47.

Sign-offs made before the change keep the versions and hash they recorded.
They stay valid for what was shown at the time. The report prints the current
disclaimer, and the recorded disclaimer version shows which one the signer saw.
