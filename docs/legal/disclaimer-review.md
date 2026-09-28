# Liability wording: the agreed texts and how they were agreed

Roadmap WP-3.13, decision D10, issue #47. This file quotes, word for word,
every liability text the app shows: the report disclaimer, the forecast-rain
line on a forecast run's report, the professional sign-off statement, and the
short lines a farmer or WUA staff member sees in the farm view and in alert
emails. Tests keep the quotes current.
`packages/engine/src/liability/disclaimer.test.ts` checks the report
disclaimer and the sign-off statement,
`frontend/src/lib/components/farm/disclaimer.test.ts` the farm view line, and
`backend/src/mail/i18n/liability.test.ts` the alert email lines. If code
changes a word, one of those tests fails until this file quotes the new text.

**State: agreed, 2026-09-28.** The operator accepted this wording on
2026-09-28, as operator, after a pre-counsel review (§ 5). **No external
legal adviser has reviewed it.** That was the operator's decision; the
questions a lawyer should still answer are in § 6 and in
[legal-status.md](../legal-status.md). If a later change needs review
again, set `DISCLAIMER.status` back to `draft` with a `draft-` version: every
surface then shows *Draft wording, pending the client’s legal review (decision D10).*
beside the disclaimer.

## 1. The report disclaimer

Source: `packages/engine/src/liability/disclaimer.ts`, `DISCLAIMER`.
Version `2026-09-28`, status `agreed`. English only.

Where it is shown:

- The last section of every catchment report (the report page and the
  server-rendered PDF), all five paragraphs, with its version.
- The seasonal outlook panel on the River tab: paragraphs 1 and 3 only.
- A sign-off records the disclaimer version the signer was shown.

Who reads it: hydrologists, WUA managers, licence applicants and assessors.
Farmers don't see it (see § 3). Terms of use §3 refers to it and cites the
same sections of the National Water Act.

> 1. These results are estimates from a computer model of the catchment. They are not measurements or predictions of what will happen, and they can be wrong.
> 2. This report supports, and does not replace, the specialist hydrology report. It is not an authorisation to use water. Only the responsible authority decides that, under the National Water Act, 1998 (sections 22, 27 and 41).
> 3. Modelled shortfalls, curtailment and equitable shares are not official restrictions or allocations. Only a notice from a body with the legal power to make one, such as the responsible authority or the water user association, is.
> 4. The person who made this run chose its inputs and settings. Where the run is signed off, the signature is that professional’s own statement.
> 5. This software is provided as it is. Its operator did not prepare this report, checks none of its inputs or results, and, as far as the law allows, accepts no responsibility to anyone who relies on it. Have the results checked by a qualified hydrologist before you act on them. Account holders’ use of the service is governed by its Terms of use.

**Forecast runs.** A forecast run's report also prints, on its cover, one of
two lines (`FORECAST_RAIN_NOTE(from, source)`). When a CHIRPS-GEFS data feed
wrote every forecast day:

> From {date}, this run uses forecast rain (CHIRPS-GEFS, Climate Hazards Center, doi:10.15780/G2PH2M), not recorded rain. Rain forecasts are often wrong, more so further ahead, and each new forecast replaces the last.

Otherwise (an uploaded or edited forecast):

> From {date}, this run uses forecast rain, not recorded rain. Rain forecasts are often wrong, more so further ahead, and each new forecast replaces the last.

## 2. The professional sign-off statement

Source: `packages/engine/src/liability/signoff.ts`, `signoffStatement()`.
Version `signoff-2`. English only.

A registered professional signs one model run. The dialog asks for the
signer's name, professional body and registration number, then shows ten
confirmations, each ticked on its own, then the run's known limitations
(generated from `docs/engine-audit.md`), then five notes that are printed but
not confirmed. The backend stores a SHA-256 hash of the exact statement shown,
so a signature is bound to these words and to the version numbers. The
report's sign-off section lists each signature with the versions and hash it
recorded. Sign-offs made under `signoff-1` keep that version and hash; the
report says they confirmed an earlier wording.

Confirmations:

> 1. I am the person named above, and I am currently registered with the professional body shown, under the registration number shown.
> 2. This work is within my competence and the category of my registration, and I did it or supervised it.
> 3. I have disclosed in writing to my client any interest that could conflict with this work, and I have none that prevents me from doing it.
> 4. I have checked the input data (rainfall, evaporation and the observed record) against their sources, and they are adequate in quality and length for this assessment.
> 5. The calibration and the observed record chosen for it are appropriate for this catchment.
> 6. The EWR tables are the applicable ones for the EWR sites in this run, from the source cited, and are entered as published.
> 7. *(a baseline run)* Checked against the sources I cite, the modelled network represents the existing works and water use of the catchment.
>    *(a scenario run, instead)* The scenario represents the proposed works and water use, as described to me by the applicant and checked against the sources I cite.
> 8. The assurance levels and demand patterns used suit the water use assessed.
> 9. I have reviewed the results for plausibility.
> 10. I have read the known limitations listed below and considered them for this run.

Notes printed with the statement:

> - The registration details are the signer’s own declaration. This app does not check them. You can check them on the public register: ECSA “Find a Registered Person”, or the SACNASP database of registered scientists.
> - A dam that can hold more than 50 000 m³ and has a wall more than 5 m high, or one the Minister has declared, is a dam with a safety risk (National Water Act, Chapter 12). The Department of Water and Sanitation must classify it; for a licence application that is form DW793. It also needs its own dam safety approvals. This sign-off does not cover dam safety.
> - This sign-off makes no finding on whether any water use or works are lawful.
> - The signature covers professional judgement on this run’s inputs and results. It relies on the app’s calculations and does not verify its software.
> - The signature covers this run only, as it was made. A later run, even of the same inputs, is not signed.

## 3. What a farmer or WUA staff member sees (English and Afrikaans)

The farm view and the alert emails don't show the report disclaimer. They
carry their own short lines, translated into Afrikaans. These are not
versioned; this file and its tests are their record.

**Farm view**, under the farm's figures (`frontend/src/lib/components/farm/cards.ts`, `disclaimer()`):

> These figures are worked out by a computer model of the catchment. They are estimates, not measurements or instructions, and they can be wrong. Only a notice from your WUA or from the Department of Water and Sanitation (DWS) is a restriction.

> Hierdie syfers is deur ’n rekenaarmodel van die opvanggebied bereken. Dit is skattings, nie metings of opdragte nie, en dit kan verkeerd wees. Net ’n kennisgewing van jou WGV of van die Departement van Water en Sanitasie (DWS) is ’n beperking.

**Farm view forecast card** (`forecastCard.ts`, `forecastFine()`); the farm
view's *why* page and the farmer glossary say the same about restrictions:

> Forecasts change, and this is worked out by the model, not a promise. Only a notice from your WUA or from DWS is a restriction.

> Voorspellings verander, en dit is deur die model bereken, nie ’n belofte nie. Net ’n kennisgewing van jou WGV of van die DWS is ’n beperking.

**Alert emails about a dam, to the farmer** (`backend/src/mail/i18n/en.ts`, `mail.alert.model`):

> This is the catchment model’s estimate, worked out from the figures your WUA published. It is not a measurement of your dam and not an instruction. Check your dam yourself, and ask your WUA if you are unsure. Only a notice from your WUA or from DWS is a restriction.

> Dit is ’n skatting van die opvanggebied se model, bereken uit die syfers wat jou WGV gepubliseer het. Dit is nie ’n meting van jou dam nie, en nie ’n opdrag nie. Kyk self na jou dam, en vra jou WGV as jy onseker is. Net ’n kennisgewing van jou WGV of van die DWS is ’n beperking.

**Alert emails about a dam, to WUA staff** (`mail.alert.model.dam.staff`):

> This is the catchment model’s estimate, worked out from the figures the WUA published. It is not a measurement of the dam and not an instruction. Only a notice from the WUA or from DWS is a restriction.

> Dit is ’n skatting van die opvanggebied se model, bereken uit die syfers wat die WGV gepubliseer het. Dit is nie ’n meting van die dam nie, en nie ’n opdrag nie. Net ’n kennisgewing van die WGV of van die DWS is ’n beperking.

**River-flow (EWR) forecast alerts, WUA staff only** (`mail.alert.model.staff`):

> This comes from the newest forecast run of the catchment model, which may not be published yet. It is an estimate, not a measurement, and not a restriction.

> Dit kom uit die nuutste voorspellingslopie van die opvanggebied se model, wat dalk nog nie gepubliseer is nie. Dit is ’n skatting, nie ’n meting nie, en nie ’n beperking nie.

**Alert emails about a WUA restriction notice** (`mail.alert.restriction.wua`):

> This notice is the WUA’s own. It is shown here as the WUA published it. Questions about it go to your WUA.

> Hierdie kennisgewing is die WGV s’n. Dit word hier gewys soos die WGV dit gepubliseer het. Rig vrae daaroor aan jou WGV.

Alerts about data feeds and background jobs carry no liability line: they
report the system's state, not a model result.

The Afrikaans went through the `i18n-checker` agent; no native speaker has
reviewed it yet (`.claude/agents/i18n/languages/af.md`).

### Is an Afrikaans version of the report disclaimer needed?

**No, as the app stands.** The report, the outlook panel and the sign-off are
workspace screens, and the workspace is English only (`docs/ui.md` §
Language). No farmer-facing page shows `DISCLAIMER`. If a farmer page ever
shows the full disclaimer, it needs an Afrikaans version too.

## 4. What changed from the draft (`draft-2026-09-26`, `signoff-1`)

- **Disclaimer.** Paragraph 1 no longer claims the results are "not
  forecasts" (a forecast run's report is one); it says they are not
  predictions. Paragraph 2 says a report is not an authorisation to use
  water and cites National Water Act sections 22, 27 and 41 (s22 is the
  one about authorisation). Paragraph 3 names any body with the legal power
  to restrict, not only the WUA (Schedule 3 item 6 lets the responsible
  authority restrict too). The old paragraph 4 is split: 4 says whose
  choices a run holds, and 5 says the operator did not prepare the report,
  accepts no responsibility to anyone who relies on it as far as the law
  allows, advises a hydrologist's check, and points account holders to the
  Terms of use. A reader who accepted no terms can only claim in delict, and
  there a clear "no responsibility to readers" statement is what counts.
- **Forecast line.** New; CHIRPS-GEFS is credited (its licence asks for the
  DOI) only when its feed wrote the forecast.
- **Sign-off.** Five confirmations became ten: identity and current
  registration, competence and supervision (ECSA Rules of Conduct r 3.1(b),
  SACNASP Code r 2.3.1), conflict of interest disclosed, input data checked,
  results reviewed for plausibility. "The EWR tables are correct" became
  "the applicable ones, from the source cited, entered as published": a
  signer can't certify a DWS Reserve determination. The works confirmation
  rests on cited sources. The dam note now uses the Act's test (a wall more
  than 5 m high and able to hold more than 50 000 m³, or a declared dam),
  names DWS as the classifier and DW793 as the licence form. New notes say
  the sign-off makes no finding on lawfulness and doesn't verify the
  software, and point to the ECSA and SACNASP public registers.
- **Farmer and staff lines.** Every farmer line that said only a WUA notice
  is a restriction now names DWS too. The farm view line adds "not
  measurements or instructions". The dam email tells the farmer to check the
  dam themselves rather than "check with your WUA before you act". Each
  alert kind now gets its own line (feed and job alerts used to call
  themselves model estimates), with staff wording for staff. The EWR
  forecast alert says "ecological reserve" and "Forecasts change."

## 5. The review behind it (2026-09-28)

Three pre-counsel reviews, one per text group, each against South African
law and practice: the disclaimer (delict and negligent misstatement,
Consumer Protection Act ss 48, 49 and 51, the National Water Act
references, CHIRPS-GEFS), the sign-off (ECSA and SACNASP codes, the public
registers, the Dam Safety Regulations GN R139 of 2012 and GN R267 of 2017),
and the farmer lines (plain language, Schedule 3 item 6 restrictions,
Afrikaans usage). Their reports are not committed (they sit with the
operator). They are not legal advice, and they said so.

What they settled, against the draft pack's questions:

1. *Does paragraph 4 limit the operator's liability enough, and against a
   reader who agreed to nothing?* Not as drafted. Against such a reader only
   delict applies; paragraph 5 now says plainly that the operator accepts no
   responsibility to anyone who relies on the report.
2. *Should the disclaimer refer to terms of use?* Yes, for account holders
   only, without implying that readers are bound (paragraph 5).
3. *Do the confirmations fit what a registered professional can certify?*
   Broadly; competence, conflict, inputs and plausibility were missing, and
   the EWR confirmation asked too much. Fixed in `signoff-2`.
4. *Is a self-declared registration number acceptable?* Yes, as a ticked
   personal declaration (a false one is misconduct under both codes), with
   the public registers named so any reader can check. No automated check:
   neither register offers one.
5. *Do the farmer lines say clearly enough that figures are estimates?*
   Yes, but "only a notice from your WUA" was wrong in law. Fixed.
6. *Rain-forecast inputs?* A forecast run's report now says so on its cover
   (§ 1), and both forecast alerts say forecasts change.

## 6. Still for a lawyer

The operator accepted the wording without one. These stay open for counsel
(tracked in [legal-status.md](../legal-status.md)):

- Whether the Consumer Protection Act reaches the service while it is free,
  and whether a WUA offering the farm view to its members is a supplier
  under it. If it applies, s49 asks for liability notices to be conspicuous:
  the farm view line is the page's last small-print paragraph.
- Whether paragraph 5 holds against a claim in delict by a farmer, applicant
  or objector who relied on a report.
- Whether the signer fields should become fixed choices (body, category,
  field of registration) and the report print the signer's scope. The app
  keeps them as free text today.

## 7. Changing the wording

1. While a change is unreviewed, set `DISCLAIMER.status` to `draft` and its
   `version` to `draft-<date>`; when accepted, a non-draft date and
   `agreed`. `disclaimer.test.ts` refuses a `draft-` version with an
   `agreed` status, and a non-`draft-` version with a `draft` status.
2. If any sign-off wording changes, change it in `signoff.ts` and bump
   `SIGNOFF_STATEMENT_VERSION`. A new disclaimer version also changes the
   statement's hash, because `disclaimerVersion` is part of it.
3. Change any farmer or staff line in its source. Send the Afrikaans through
   the `i18n-translator` and `i18n-checker` agents and
   `pnpm gen:i18n:apply af`, then run `pnpm gen:i18n:sheet`.
4. Update the quotes in this file. The tests named at the top fail until you
   do.

Sign-offs made before a change keep the versions and hash they recorded.
They stay valid for what was shown at the time. The report prints the current
disclaimer, and the recorded disclaimer version shows which one the signer saw.
