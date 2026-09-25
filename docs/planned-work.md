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
| ✅ **Curtailment targets per farm** | The b023 Shortfalls sheet's key output is *how much each farm must reduce (or may gain) so irrigation balances and the EWR is met* ("target volume", "reduce/gain" in m³/day and l/s). V1 shows deficits and EWR shortfalls but not the recommended cut. This is the answer the client actually sells. **Done:** `RunSummary.curtailment` over `settings.reportStart…reportEnd` (model.md §2.11; the audit removed the workbook's rounding, closing Q14/Q15), shown by `CurtailmentTable` in the Runs tab, with the reporting window in Settings. Open: the policy questions Q11–Q13 (hydrologist). | | M |
| ✅ **EWR compliance heat map** | Month × year grid of % days EWR not met, like the workbook's EWR pivot. The standard way to see *when* the river fails. — **Done:** engine grid `RunSummary.ewrCompliance` (outlet + per farm; model.md §2.9) shown by `EwrHeatmap` in the Runs tab. | | S |
| 🚧 **Run comparison** | Pick two runs (e.g. baseline vs dam raise) → per-farm delta table and overlaid hydrographs. Without it, every what-if needs screenshots side by side. **Built:** `/compare` page (same project or across a copy), "what changed" input diff, headline + per-farm deltas, overlaid catchment series ([run-comparison.md](./run-comparison.md)). The Runs tab links to it ("Compare runs"), and a per-series content hash catches values corrected inside the same dates. Left: per-node series overlay, copies that remember their source nodes. | M |
| ✅ **Calibration window + more metrics** | The workbook calibrates on 2010–2018 only; V1 scores the whole record (hence NSE −0.70 on the client catchment). Let the user pick the window; add KGE, R², log-NSE (low-flow fit), volume error per year. — **Done:** window, KGE, R², log-NSE and annual volumes in the engine, importer and Settings; `CalibrationPanel` in the Runs tab shows which simulated series was scored (Pitman → natural flow, audit C1). Which observed record the client catchment uses is issue #1. | | S |
| 🚧 **Export** | CSV/Excel download of any table or series, and a run's full daily output. Hydrologists will want to check numbers in Excel. — API done ([api.md § Export](./api.md#export)); `DownloadMenu` is in the Runs, Data and Overview tabs; summary CSV writes percentages. Left: `.xlsx` (library choice) and a path for exports over 5 MB. | | S |
| ✅ **Append daily data from the UI** | **Done:** upload defaults to append / update an existing series (`POST /series/merge`), and the header shows "Data up to …" with a staleness flag. | | S |
| ✅ **Help & glossary** | The workbook ships a 200-row Help sheet. Port it as contextual help (ⓘ next to fields) and a glossary page: EWR, MAP, A-pan, crop factor, flow share, NSE… — **Done:** `/help` glossary (searchable, anchor per term, sticky contents) and ⓘ `HelpTip`s next to the form fields, from `frontend/src/lib/help/content.ts`. Open: a hydrologist read-through. | | S |
| ✅ **Password reset + email verification** | Required before real users. **Done:** API (hashed single-use tokens, session revocation, sign-in lockout, `logout-everywhere`), pages, the verify banner and "Forgot password?" link, Mailpit locally, SES in Terraform (not applied). The header's account menu offers "Sign out everywhere". Left: the sign-in / sign-up policy questions. | | M |
| ✅ **Invite people who don't have an account yet** | **Done:** pending invites (7 days) for unknown *and* unverified addresses, members-panel UI (invitation sent, pending list, revoke), and `/register?invite=` for signed-out and signed-in visitors. | | S |

## Next — make it a working tool, not a demo

### Scenarios and what-ifs
| Feature | Why | Effort |
| --- | --- | --- |
| ⬜ **Scenarios within a project** | The workbook had a placeholder Scenario sheet. A scenario = a named set of overrides on the base model (raise dam X by 20 %, replace crop, remove a farm, add a transfer, scale rainfall −10 %), run and compared without copying the whole project. Copy-project works today but diverges from the base. | L |
| ⬜ **Instant in-browser preview** | The engine already runs in the browser (~0.2 s for 44 years). Change a parameter → see the effect before saving. Makes calibration interactive. | M |
| ⬜ **Automatic calibration** | Fit a, b, thresholds, seasonal factors to observed flow by maximising NSE/KGE (Nelder–Mead or DE in TypeScript, in a Web Worker). The workbook is tuned by hand. | M |
| ⬜ **Climate / stochastic scenarios** | Scale or shift rainfall, replay the worst drought years, or generate stochastic sequences to get reliability of supply rather than one historical answer. | L |

### Model completeness
| Feature | Why | Effort |
| --- | --- | --- |
| ⬜ **Water-use licences / allocations** | Registered volumes per farm (National Water Act, WARMS) vs modelled use → over/under-use and compliance. Central to catchment management agencies. | M |
| ⬜ **Assurance of supply & yield** | Reliability (% of time demand met), firm yield of each dam, storage–yield curves. Standard planning outputs. | M |
| ⬜ **Dam evaporation, seepage, area–volume curves** | b023 ignores dam losses; material for small farm dams in summer. | M |
| ⬜ **Operating rules** | Pump scenarios from the node-based design (dam-first, river-first, trigger-based, run-of-river) and drought restrictions (curtail when storage < x %). | L |
| ⬜ **Groundwater abstraction** | Placeholder in the node-based model; many farms supplement from boreholes, and pumping near the river lowers dry-season base flow. Roadmap WP-1.34. | M |
| ⬜ **Other water users** | Towns, industry and unlisted irrigators take river water the model currently hands to the listed farms. Roadmap WP-1.33. | S |
| ⬜ **Land-cover streamflow reductions** | Invasive alien trees and forestry use more water than natural vegetation; needed for "clear the invasives" scenarios. Roadmap WP-1.35. | M |
| ⬜ **Full EWR tables** | Import Desktop Version 2 percentile tables, high-flow components, EWR at more than one site (not only the outlet). | M |
| ⬜ **Stress classes & water account** | Port the node-based System/Monthly stress classes (Low → Critical) and the catchment water account (runoff − irrigation − outflow) as results views. | S |
| ⬜ **Runoff module as an alternative flow generator** | The AI bucket model (soil store, quickflow/baseflow) with multiple rain gauges per hydrological unit — after fixing its unaccounted 56 % of rainfall. | L |

### Data
| Feature | Why | Effort |
| --- | --- | --- |
| ⬜ **In-browser workbook import** | Upload a b023 `.xlsm` from the UI (SheetJS from its CDN tarball, parsed in a Web Worker) instead of the Python CLI. Lets the client onboard their other catchments themselves. | M |
| ⬜ **Data feeds** | Per-project API keys (hashed, `series:write`, revocable) for logger gateways; scheduled fetchers for CHIRPS rainfall and DWS gauge records; auto re-run after new data. See plan.md §1e. | L |
| 🚧 **Data quality tools** | Flag outliers and flat-lines, fill gaps (interpolate or from a neighbouring gauge), per-value flags (observed / estimated / forecast), source and unit provenance. — **First check built:** every run compares the gauge and logger records per water year and warns when they disagree (model.md §2.10a; caught the client catchment's 2014–2017 gauge problem). Since then: the agreement table on the Data tab with per-project thresholds (Settings → Data quality), plus negative / outlier / flat-line checks per series and the area-mismatch warning. Left: gap filling, per-value flags and provenance. | M |
| ⬜ **Forecast mode** | Run with 7–14-day forecast rainfall appended, show forecast days distinctly, early warning of EWR failure or low dams. | M |
| ⬜ **Spreadsheet templates** | Download a CSV/Excel template for farms, crops and series, fill it in, upload — faster than typing 12 monthly values × 20 farms. | S |

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
| ⬜ **Report generation** | One-click PDF/Word catchment report: network, inputs, calibration, shortfalls, EWR compliance, charts. The deliverable consultants hand over today by copy-pasting from Excel. | M |
| ⬜ **Portfolio dashboard** | Across all catchments a team manages: traffic-light EWR status, latest data date, last run, farms in deficit. Fits "a group has many catchments". | M |
| ⬜ **Alerts** | Email when a dam drops below a threshold, the EWR is forecast to fail, or data stops arriving. | M |

## Later — platform and product

| Feature | Why | Effort |
| --- | --- | --- |
| ⬜ **SSO / MFA** | Agencies and larger consultancies use Microsoft Entra ID; MFA for admins. | M |
| ⬜ **Background jobs** | Queue (SQS) for batch runs, stochastic ensembles, report rendering — anything beyond the 30 s Lambda budget. | M |
| ⬜ **Run storage in S3** | A full client catchment run is ~11 MB of output; move per-series arrays to compressed S3 objects once runs accumulate (DB keeps summaries). | M |
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
