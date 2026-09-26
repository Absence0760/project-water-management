# Planned work — features beyond V1

A backlog of features that the initial design missed or deferred, gathered
from the workbooks (what the Excel tool does or was reaching for), from how
hydrologists actually work, and from what a team running many catchments
needs. [plan.md](./plan.md) holds the phased delivery plan; this doc is the
*what and why*. Items move into plan.md phases once the client prioritises
them (see "Questions for the client" there).

Effort: **S** ≈ a day or two · **M** ≈ a week · **L** ≈ several weeks.
Status: ⬜ not started · 🚧 partly there · ✅ done.

---

## Now — close the gaps a hydrologist will notice in the V1 demo

| Feature | Why | Effort |
| --- | --- | --- |
| ✅ **Curtailment targets per farm** | The b023 Shortfalls sheet's key output is *how much each farm must reduce (or may gain) so irrigation balances and the EWR is met* ("target volume", "reduce/gain" in m³/day and l/s). V1 shows deficits and EWR shortfalls but not the recommended cut. This is the answer the client actually sells. **Done:** `RunSummary.curtailment` over `settings.reportStart…reportEnd` (model.md §2.11; the audit removed the workbook's rounding, closing Q14/Q15), shown by `CurtailmentTable` in the Runs tab, with the reporting window in Settings. Q11 and Q13 are decided on a simulated assessor's recommendation (engine 0.17.0: fairness-benchmark labels, no supply cut on a farm without irrigation, bounded "Demand left %"), and Q17 charges EWR shortfalls to upstream farms (model.md §2.7b). Open: the hydrologist's confirmation of Q11–Q13 and Q17. | | M |
| ✅ **EWR compliance heat map** | Month × year grid of % days EWR not met, like the workbook's EWR pivot. The standard way to see *when* the river fails. — **Done:** engine grid `RunSummary.ewrCompliance` (outlet + per farm; model.md §2.9) shown by `EwrHeatmap` in the Runs tab. | | S |
| 🚧 **Run comparison** | Pick two runs (e.g. baseline vs dam raise) → per-farm delta table and overlaid hydrographs. Without it, every what-if needs screenshots side by side. **Built:** `/compare` page (same project or across a copy), "what changed" input diff, headline + per-farm deltas, overlaid catchment series ([run-comparison.md](./run-comparison.md)). The Runs tab links to it ("Compare runs"), and a per-series content hash catches values corrected inside the same dates. Left: per-node series overlay, copies that remember their source nodes. | M |
| ✅ **Calibration window + more metrics** | The workbook calibrates on a fixed window only; V1 scores the whole record (hence a poor NSE on the client catchment). Let the user pick the window; add KGE, R², log-NSE (low-flow fit), volume error per year. — **Done:** window, KGE, R², log-NSE and annual volumes in the engine, importer and Settings; `CalibrationPanel` in the Runs tab shows which simulated series was scored (natural flow; the Pitman input was removed in engine 0.10.0, audit P1). Which observed record the client catchment uses is issue #1. | | S |
| 🚧 **Export** | CSV/Excel download of any table or series, and a run's full daily output. Hydrologists will want to check numbers in Excel. — API done ([api.md § Export](./api.md#export)); `DownloadMenu` is in the Runs, Data and Overview tabs; summary CSV writes percentages. Left: `.xlsx` (library choice) and a path for exports over 5 MB. | | S |
| ✅ **Append daily data from the UI** | **Done:** upload defaults to append / update an existing series (`POST /series/merge`), and the header shows "Data up to …" with a staleness flag. | | S |
| ✅ **Help & glossary** | The workbook ships a 200-row Help sheet. Port it as contextual help (ⓘ next to fields) and a glossary page: EWR, MAP, A-pan, crop factor, flow share, NSE… — **Done:** `/help` glossary (searchable, anchor per term, sticky contents) and ⓘ `HelpTip`s next to the form fields, from `frontend/src/lib/help/content.ts`, plus guides, model explainers and a catchment picture tour. Open: a hydrologist read-through. | | S |
| ✅ **Password reset + email verification** | Required before real users. **Done:** API (hashed single-use tokens, session revocation, sign-in lockout, `logout-everywhere`), pages, the verify banner and "Forgot password?" link, Mailpit locally, SES in Terraform (not applied). The header's account menu offers "Sign out everywhere" and links to the `/account` page (display name, change password while signed in). Left: the sign-in / sign-up policy questions. | | M |
| ✅ **Invite people who don't have an account yet** | **Done:** pending invites (7 days) for unknown *and* unverified addresses, members-panel UI (invitation sent, pending list, revoke), and `/register?invite=` for signed-out and signed-in visitors. | | S |

## Next — make it a working tool, not a demo

### Scenarios and what-ifs
| Feature | Why | Effort |
| --- | --- | --- |
| ✅ **Scenarios within a project** | The workbook had a placeholder Scenario sheet. A scenario = a named set of overrides on the base model (raise dam X by 20 %, replace crop, remove a farm, add a transfer, scale rainfall −10 %), run and compared without copying the whole project. Copy-project works today but diverges from the base. — **Engine, backend and API built** (issue #18, WP-3.2): `applyScenario`, the op catalogue and the proposal / baseline classifier; the `scenario` table (migration 024), `/projects/:id/scenarios` (create, edit, run, rebase) and the scenario per side in compare ([scenarios.md](./scenarios.md)); and the **Scenarios tab** (stage D): the list, the override editor for every op with undo, the baseline callout, rebase, the scenario-vs-base comparison and the compare page's Scenario overrides ([ui.md § Scenarios](./ui.md#scenarios-tabscenarios)). | L |
| ⬜ **Instant in-browser preview** | The engine already runs in the browser (a fraction of a second for a full record). Change a parameter → see the effect before saving. Makes calibration interactive. | M |
| ✅ **Automatic calibration** | Fit a, b, thresholds, seasonal factors to observed flow by maximising NSE/KGE (Nelder–Mead or DE in TypeScript, in a Web Worker). The workbook is tuned by hand. — **Done** (issue #4): DDS with multi-start, split-sample and dry → wet validation, exclusions and a stored fit record, as Fit automatically in Settings, in a Web Worker (model.md §2.10b). | M |
| ⬜ **Climate / stochastic scenarios** | Scale or shift rainfall, replay the worst drought years, or generate stochastic sequences to get reliability of supply rather than one historical answer. | L |

### Model completeness
| Feature | Why | Effort |
| --- | --- | --- |
| 🚧 **Water-use licences / allocations** | Registered volumes per farm (National Water Act, WARMS) vs modelled use → over/under-use and compliance. Central to catchment management agencies. **First slice built (WP-3.10, 2026-09-26):** volumes per farm with source, purpose, water source and validity; WARMS/CSV import with matching and file provenance; names hidden from viewers; modelled use vs registered volume per water year ([allocations.md](./allocations.md)). Left: `cap` / `fullAllocation` runs, XLSX and column mapping, the farm view ([followups.md § Allocations](./followups.md#allocations-wp-310)). | M |
| 🚧 **Assurance of supply & yield** | Reliability (% of time demand met), firm yield of each dam, storage–yield curves. Standard planning outputs. — **Assurance built** (engine 0.32.0, roadmap WP-3.4, model.md §2.11a, pending the hydrologist): time-based, volumetric and annual reliability per farm and user, resilience and vulnerability. Left: firm yield and storage–yield curves (WP-3.6). | M |
| ✅ **Dam evaporation, seepage, area–volume curves** | b023 ignores dam losses; material for small farm dams in summer. — **Done** (engine 0.16.0, audit N2, pending the hydrologist): power-law area–volume, lake evaporation from A-pan, rain on the dam and seepage (model.md §2.7a). Survey curves and releases are roadmap WP-3.5. | M |
| ⬜ **Operating rules** | Pump scenarios from the node-based design (dam-first, river-first, trigger-based, run-of-river) and drought restrictions (curtail when storage < x %). | L |
| ✅ **Groundwater abstraction** | Boreholes on farms and other users (supplemental, primary, drought) with lagged stream depletion of the river. Built in engine 0.23.0 (model.md §2.7d), off by default; the method and values await the hydrologist. Roadmap WP-1.34. | M |
| ✅ **Other water users** | Towns, industry and unlisted irrigators take river water the model used to hand to the listed farms. Built in engine 0.22.0 (node kind `user`, model.md §2.7c), off by default; the priority and curtailment rules await the hydrologist. Roadmap WP-1.33. | S |
| ✅ **Land-cover streamflow reductions** | Invasive alien trees and forestry use more water than natural vegetation; "clear the invasives" is a copy compared with the baseline. Built in engine 0.24.0 (model.md §2.5a), off by default; the class reductions are indicative and await the hydrologist. Roadmap WP-1.35. | M |
| 🚧 **Full EWR tables** | Import Desktop Version 2 percentile tables, high-flow components, EWR at more than one site (not only the outlet). — **Built:** each gauge is checked against its own EWR, and shortfalls are attributed per site (outlet and every gauge, engine 0.17.0); rule tables per site (engine 0.21.0); the DRM low-flow table (maintenance to drought) beside the total, freshet and flood components per site, paste or CSV entry, and a Reserve heat map per site (engine 0.33.0, WP-3.7, model.md §2.9d). Left: low flows on base flow, the daily charge from the rule table, gazetted/desktop confidence labels (followups.md). | M |
| ✅ **Stress classes & water account** | Port the node-based System/Monthly stress classes (Low → Critical) and the catchment water account (runoff − irrigation − outflow) as results views. — **Done** (engine 0.32.0, roadmap WP-3.4, model.md §2.11a–b, pending the hydrologist): system and per-farm stress per water-year month, the water account per water year closing to float noise, on the Runs tab and in the summary CSV. | S |
| ⬜ **Runoff module as an alternative flow generator** | The AI bucket model (soil store, quickflow/baseflow) with multiple rain gauges per hydrological unit — after fixing the large share of rainfall it leaves unaccounted. GR4J already fills the alternative-generator slot (the default since engine 0.11.0, `settings.runoffModel`); the bucket model would be a third option. | L |

### Data
| Feature | Why | Effort |
| --- | --- | --- |
| ✅ **In-browser workbook import** | Upload a b023 `.xlsm` from the UI (SheetJS from its CDN tarball, parsed in a Web Worker) instead of the Python CLI. Lets the client onboard their other catchments themselves. — **Landed (WP-1.31, 2026-09-25):** **Import b023 workbook** on the project list, with progress per sheet, Cancel, a review with the importer's notes and the unmapped report, and the gauge-as-reference option ([ui.md](./ui.md#import-a-b023-workbook)). Since then the import reads workbooks with its own streaming reader, not SheetJS (the client workbook's read uses ~90% less memory), and since profiling it in Chrome, Safari and on phone simulators (issue #23) it reads the picked file a slice at a time, never whole ([followups.md](./followups.md)). | M |
| ⬜ **Data feeds** | Per-project API keys (hashed, `series:write`, revocable) for logger gateways; scheduled fetchers for CHIRPS rainfall and DWS gauge records; auto re-run after new data. See plan.md §1e. | L |
| 🚧 **Data quality tools** | Flag outliers and flat-lines, fill gaps (interpolate or from a neighbouring gauge), per-value flags (observed / estimated / forecast), source and unit provenance. — **First check built:** every run compares the gauge and logger records per water year and warns when they disagree (model.md §2.10a; caught the client catchment's gauge problem). Since then: the agreement table on the Data tab with per-project thresholds (Settings → Data quality), plus negative / outlier / flat-line checks per series and the area-mismatch warning. Flagged zero-rain runs are now treated as missing so corrected CHIRPS fills them (CR-20, engine 0.15.0), and the Data tab previews how the model used each day. Left: gap filling, per-value flags and provenance. | M |
| ⬜ **Forecast mode** | Run with 7–14-day forecast rainfall appended, show forecast days distinctly, early warning of EWR failure or low dams. | M |
| ⬜ **Seasonal outlook** | "How much water will I get this season?" beyond the 14-day forecast: run the rest of the season from today's dam level with each historical year's rain and flows (an analogue ensemble) and report the likely range of "% of what you need" and the dam at season end, per farm. The farmer view ships without it and says nothing past 14 days until it exists ([design/farmer-view.md](./design/farmer-view.md) ask E3, issue #14). Trigger: before farmers' second season on the view (after forecast mode, WP-2.12). | M |
| ⬜ **Spreadsheet templates** | Download a CSV/Excel template for farms, crops and series, fill it in, upload — faster than typing 12 monthly values × every farm. | S |

### Maps
| Feature | Why | Effort |
| --- | --- | --- |
| ⬜ **Catchment map** | Upload the catchment boundary (GeoJSON/shapefile), place farms, dams and gauges on a map, draw the network over the terrain. Hydrologists think spatially; clients recognise farms on a map faster than in a tree. MapLibre with self-hosted Protomaps tiles (the estate already runs this pattern in project-running). | L |
| ⬜ **Derive areas from the map** | Farm catchment areas (km²) computed from drawn polygons instead of typed. | M |

### Collaboration, governance, reporting
| Feature | Why | Effort |
| --- | --- | --- |
| ⬜ **Change history & audit log** | Who changed which parameter when, with restore. The workbook kept a user-action log; regulators and clients will ask "why did the result change?". Runs already snapshot their inputs. | M |
| ⬜ **Notes and comments** | On a farm, a parameter or a run ("dam raised in 2019 per owner"). | S |
| ⬜ **Baseline / published run** | Mark one run as the official result a catchment's stakeholders see. | S |
| ⬜ **Stakeholder access** | Read-only links for clients, or a farmer view scoped to their own farm (allocation, shortfall, dam) without seeing neighbours. | M |
| 🚧 **Report generation** | One-click PDF/Word catchment report: network, inputs, calibration, shortfalls, EWR compliance, charts. The deliverable consultants hand over today by copy-pasting from Excel. **Phase A done** (issue #19, WP-2.15): **Report** on a run in the Runs tab opens `/projects/:id/report?run=`, a print route on the existing API that reuses the Runs tab's panels and prints to A4 through the browser (Download PDF → Save as PDF); [ui.md § Report](./ui.md#report). The report also closes with the validation statement (known limitations generated from engine-audit.md), the professional sign-off and the disclaimer (WP-3.13; the disclaimer is draft wording pending the client's legal review, D10). Left: Phase B (server-side PDFs, decision D9), the published-by line and restriction notice (WP-2.3), changes since the last publication (WP-2.4), the licensing evidence pack (#15), a Word export. | M |
| ⬜ **Portfolio dashboard** | Across all catchments a team manages: traffic-light EWR status, latest data date, last run, farms in deficit. Fits "a group has many catchments". | M |
| ⬜ **Alerts** | Email when a dam drops below a threshold, the EWR is forecast to fail, or data stops arriving. | M |

## Later — platform and product

| Feature | Why | Effort |
| --- | --- | --- |
| ⬜ **SSO / MFA** | Agencies and larger consultancies use Microsoft Entra ID; MFA for admins. | M |
| ⬜ **Background jobs** | Queue (SQS) for batch runs, stochastic ensembles, report rendering — anything beyond the 30 s Lambda budget. | M |
| ⬜ **Run storage in S3** | A full client catchment run is several MB of output; move per-series arrays to compressed S3 objects once runs accumulate (DB keeps summaries). | M |
| ⬜ **Unit preferences** | m³/day vs ML/day vs l/s vs m³/s; Mm³/a for annual volumes. | S |
| ⬜ **Public API docs** | OpenAPI spec for integrators (data feeds, other models). | S |
| ⬜ **Onboarding tour** | Guided first project using an example catchment. | S |
| ⬜ **Localisation** | Afrikaans UI if farmers become users (ask the client). | M |
| ⬜ **Excel round-trip** | Export a project back to a b023-compatible workbook for users who still need Excel. | L |
| ⬜ **Commercial model** | If the client offers this to others: organisations as tenants, plans, billing (Stripe is already on the workstation). | L |
| ⬜ **POPIA / data governance** | Data-processing terms, retention, export and deletion of an organisation's data, hosting region (af-south-1). | M |

---

## Suggested order

> **Superseded by [roadmap/](./roadmap/README.md)**, which groups these features into four steps by who they serve, with build plans. The order below is kept for history.

1. Curtailment targets, EWR heat map, calibration window, export, help — the
   demo lands better with each (≈ 2 weeks).
2. Email (reset, verify, invites) and the change log — needed before real
   users (≈ 1–2 weeks).
3. Scenarios + run comparison + instant preview — the biggest jump in
   usefulness over the spreadsheet (≈ 3–4 weeks).
4. Data feeds + forecast mode + alerts — turns it into an operational tool
   (≈ 3–4 weeks), then maps and reports.

All of it is subject to the client's answers in
[plan.md § Questions for the client](./plan.md#questions-for-the-client).
