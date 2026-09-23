# Planned work — features beyond V1

A backlog of features that the initial design missed or deferred, gathered
from the workbooks (what the Excel tool does or was reaching for), from how
hydrologists actually work, and from what a team running many catchments
needs. [plan.md](./plan.md) holds the phased delivery plan; this doc is the
*what and why*. Items move into plan.md phases once the client prioritises
them (see "Questions for the client" there).

Effort: **S** ≈ a day or two · **M** ≈ a week · **L** ≈ several weeks.
Status: ⬜ not started · 🚧 partly there.

---

## Now — close the gaps a hydrologist will notice in the V1 demo

| Feature | Why | Effort |
| --- | --- | --- |
| ⬜ **Curtailment targets per farm** | The b023 Shortfalls sheet's key output is *how much each farm must reduce (or may gain) so irrigation balances and the EWR is met* ("target volume", "reduce/gain" in m³/day and l/s). V1 shows deficits and EWR shortfalls but not the recommended cut. This is the answer the client actually sells. | M |
| 🚧 **EWR compliance heat map** | Month × year grid of % days EWR not met, like the workbook's EWR pivot. The standard way to see *when* the river fails. — Engine grid in `RunSummary.ewrCompliance` (outlet + per farm; semantics in model.md §2.9) and `components/ewr/EwrHeatmap.svelte` are done; not yet mounted in the Runs tab. | S |
| ⬜ **Run comparison** | Pick two runs (e.g. baseline vs dam raise) → per-farm delta table and overlaid hydrographs. Without it, every what-if needs screenshots side by side. | M |
| 🚧 **Calibration window + more metrics** | The workbook calibrates on 2010–2018 only; V1 scores the whole record (hence NSE −0.70 on Client Catchment). Let the user pick the window; add KGE, R², log-NSE (low-flow fit), volume error per year. — Engine, importer and settings validation done (Client Catchment on the workbook's window and logger: NSE 0.29, KGE 0.57; model.md §2.10); `components/calibration/CalibrationPanel.svelte` and `CalibrationWindowFields.svelte` built, not yet mounted. | S |
| ⬜ **Export** | CSV/Excel download of any table or series, and a run's full daily output. Hydrologists will want to check numbers in Excel. | S |
| 🚧 **Append daily data from the UI** | Merge endpoint exists (`POST /series/merge`); upload "append" mode and "data up to …" staleness indicator are in progress. | S |
| ⬜ **Help & glossary** | The workbook ships a 200-row Help sheet. Port it as contextual help (ⓘ next to fields) and a glossary page: EWR, MAP, A-pan, crop factor, flow share, NSE… | S |
| ⬜ **Password reset + email verification** | Required before real users. Needs email: SES in prod, Mailpit locally (estate pattern from project-flakey). | M |
| ⬜ **Invite people who don't have an account yet** | Today a member must register before they can be added. Email invite with a signup link. Depends on email. | S |

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
| ⬜ **Groundwater abstraction** | Placeholder in the node-based model; many farms supplement from boreholes. | M |
| ⬜ **Full EWR tables** | Import Desktop Version 2 percentile tables, high-flow components, EWR at more than one site (not only the outlet). | M |
| ⬜ **Stress classes & water account** | Port the node-based System/Monthly stress classes (Low → Critical) and the catchment water account (runoff − irrigation − outflow) as results views. | S |
| ⬜ **Runoff module as an alternative flow generator** | The AI bucket model (soil store, quickflow/baseflow) with multiple rain gauges per hydrological unit — after fixing its unaccounted 56 % of rainfall. | L |

### Data
| Feature | Why | Effort |
| --- | --- | --- |
| ⬜ **In-browser workbook import** | Upload a b023 `.xlsm` from the UI (SheetJS from its CDN tarball, parsed in a Web Worker) instead of the Python CLI. Lets the client onboard their other catchments themselves. | M |
| ⬜ **Data feeds** | Per-project API keys (hashed, `series:write`, revocable) for logger gateways; scheduled fetchers for CHIRPS rainfall and DWS gauge records; auto re-run after new data. See plan.md §1e. | L |
| ⬜ **Data quality tools** | Flag outliers and flat-lines, fill gaps (interpolate or from a neighbouring gauge), per-value flags (observed / estimated / forecast), source and unit provenance. | M |
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
| ⬜ **Run storage in S3** | A full Client Catchment run is ~11 MB of output; move per-series arrays to compressed S3 objects once runs accumulate (DB keeps summaries). | M |
| ⬜ **Unit preferences** | m³/day vs ML/day vs l/s vs m³/s; Mm³/a for annual volumes. | S |
| ⬜ **Public API docs** | OpenAPI spec for integrators (data feeds, other models). | S |
| ⬜ **Onboarding tour** | Guided first project using an example catchment. | S |
| ⬜ **Localisation** | Afrikaans UI if farmers become users (ask the client). | M |
| ⬜ **Excel round-trip** | Export a project back to a b023-compatible workbook for users who still need Excel. | L |
| ⬜ **Commercial model** | If the client offers this to others: organisations as tenants, plans, billing (Stripe is already on the workstation). | L |
| ⬜ **POPIA / data governance** | Data-processing terms, retention, export and deletion of an organisation's data, hosting region (af-south-1). | M |

---

## Suggested order

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
