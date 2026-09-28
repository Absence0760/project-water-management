# International: making the app usable outside South Africa

A cross-cutting plan, not a fifth step ([README](./README.md)). Each work
package names the step it lands in. Cheap pieces land early, such as string
extraction with Afrikaans in Step 2. Everything tenant- or region-shaped sits
on seams that [Step 4](./step-4-platform.md) owns: multi-tenancy, billing, SSO
and multi-region deployment. This plan names what it needs from Step 4 rather
than designing it again.

Research date: September 2026. Every regulatory, dataset and market claim
links to its source. Items marked **(verify)** had conflicting or secondary
sources only. A lawyer or the partner confirms them before anyone relies on
them. Per org policy, anything touching data residency, transfers or hosting
compliance goes to the **CISO / Security Analyst** before it is acted on.

---

## 1. Summary

Today the app is a South African tool in every layer:

- **Engine:** an October–September water year, A-pan evaporation, a season switch
  tuned to one rainfall regime (the b023 defaults), and a single "pragmatic" monthly EWR.
- **Allocation:** proportional-sharing curtailment.
- **Formatting:** en-US numbers and DD/MM CSV dates.
- **Content:** English-only UI, emails and help, which cite WR90, DWS and
  quaternary catchments.
- **Hosting:** one af-south-1 stack.

This plan makes each of those a per-project or per-tenant choice, so the same
engine can serve a Kenyan Water Resource Users Association, a Chilean basin
consultant or an Australian irrigator. It also recommends where to go first:

- **First market: Kenya.** It is English-speaking, its statutory Reserve is the
  South African concept, and it has hundreds of WRUAs with a duty to plan
  sub-catchments.
- **Pilot:** one sub-catchment, run with a Kenyan hydrology consultancy as the
  partner.
- **Near-home extensions:** eSwatini and Namibia can be served from the home
  stack with only a country preset.

## 2. Users and jobs to be done

| User | Job to be done | What they use today | What would make them switch |
| --- | --- | --- | --- |
| **Local consulting hydrologist** (partner firm, e.g. Nairobi or Santiago) | Build and calibrate a daily catchment balance for a client or regulator. Defend it in a permit or plan review. | WEAP (Kenya Upper Tana allocation plan: [GWC report](https://www.weap21.org/downloads/GWC_Report_4.pdf); Chile DGA basin plans: [SEI](https://www.sei.org/projects/supporting-strategic-watershed-planning-in-chile-through-weap/)); eWater Source in Australia ([eWater](https://ewater.org.au/resources/supporting-the-management-of-the-murray-darling-basin/)); Aquatool in Spain ([UPV](https://aquatool.webs.upv.es/aqt/en/home/)); spreadsheets | Daily farm-scale balance with dams, EWR and curtailment in the browser. Global data prefilled. Their own evaporation and e-flow method. A reproducible, signed report. |
| **Water users' association / irrigation board** (Kenya WRUA, eSwatini WUA/irrigation district, Spanish *comunidad de regantes*) | See who is short, apply restrictions fairly, report to the regulator | Paper, spreadsheets, the regulator's figures | Plain-language farm views in their own language, on a phone |
| **Regulator / basin authority** (Kenya WRA, eSwatini River Basin Authorities, Chile DGA, Spanish Confederaciones) | Check allocations against the Reserve / ecological flow and review applications | National models, consultant reports | Transparent assumptions, the method named in their own statute, and an audit trail. This is Step 3's job, localised. |
| **Donor-funded programme** (GIZ, World Bank CIWA, GEF basin projects) | Tools for a basin organisation that outlive the project | Bespoke consultancy models that die with the contract | Hosted, maintained, and multilingual. Data stays in region. |
| **Farmer** (outside SA) | Know what water they'll get | Word of mouth | Their language, their units (ML, acre-feet), their currency on invoices |

## 3. Scope

**In scope**

- Engine generalisation:
  - water year and seasons;
  - A-pan or ET0 evaporation;
  - pluggable flow generators;
  - EWR rule sets;
  - allocation rule sets;
  - display units.
- Country presets.
- Global and national data fetchers, with licence and provenance tracking.
- i18n infrastructure, languages, locale-aware formatting and parsing.
- Privacy and residency per country, sub-processors, liability wording.
- A second (and later) AWS region stack.
- Go-to-market: partner model, pilot, validation and sign-off.

**Out of scope (and who owns it)**

- The tenant/organisation model, billing, SSO, and the multi-region routing
  mechanism → **Step 4**. This plan lists its needs in §4.
- Scheduled fetcher framework, CHIRPS/DWS fetchers, alerts → **Step 2**. This
  plan adds sources to that framework.
- Desktop Reserve table import, full EWR tables, water-use licences → **Step 3**.
  This plan's rule-set interfaces are where those plug in.
- The bucket runoff module → **Step 4**. This plan adds GR4J/AWBM
  behind the same generator interface.
- GovRAMP / US federal hosting. It is not processed here (org policy), and a
  US federal customer is not in scope.

## 4. Prerequisites

- **Step 1 exit:** the model is signed off in South Africa. No foreign
  hydrologist should be asked to trust an engine the home hydrologist hasn't
  accepted. In particular, audit **H1** (the rain model doesn't conserve water
  at event scale) must be decided before a new climate regime is calibrated on
  it ([engine-audit.md](../engine-audit.md)). *Done 2026-09-26: engine 1.0.0
  removed that model; GR4J is the only one.*
- **Commercial model abroad.** Who sells outside South Africa (the operator
  directly, local partners, a joint venture). See Open decision D1.
- **What this plan needs from Step 4** (named seams, not designed here):
  1. An `organisation` (tenant) row that carries:
     - `home_region` (immutable after data exists, or moved only by a runbook);
     - `country_code` (ISO 3166-1);
     - `default_locale`;
     - `billing_currency` (ISO 4217).
  2. Region routing: sign-up picks or infers a region, and every request for a
     tenant is served by that region's stack.
  3. Terraform that instantiates the whole stack per region from one module.
     `infra/` already takes `aws_region` as a variable.
  4. Billing that prices in integer minor units plus a currency code, per
     tenant.
  5. A versioned public API. Rule-set and generator ids become part of the
     contract.
  6. The flow-generator interface (WP-I.6). Whichever of Step 4's runoff
     module and this plan lands first defines it. The other conforms.
- **Open hydrologist answers that change this plan:**
  - N3: are the crop factors A-pan based? That sets the ET0 conversion.
  - Q11 / Q17: the allocation and attribution policy that allocation rule
    sets generalise.

## 5. Architecture changes

### 5.1 South African assumptions in the code today

| Assumption | Where (file · function) | Change |
| --- | --- | --- |
| Water year is Oct–Sep | `packages/engine/src/calendar.ts` · `waterYearIndex()` (`(m + 2) % 12`); `calendar.ts` · `waterYearOf()` (doc: "South African water year"); `network/ewr.ts` · `ewrCompliance()` rows; `quality.ts` ("Water year starting 1 October"); `compare.ts` · `WY_MONTHS`; `frontend/src/lib/format/months.ts` · `WATER_YEAR_MONTHS`, `WATER_YEAR_CALENDAR`, `describeMonths()`; `components/ewr/EwrHeatmap.svelte` ("water years October to September") | `settings.waterYearStartMonth` (WP-I.4) |
| Monthly tables stored Oct-first | `calendar.ts` · `Monthly`; `project.ts` · `apanMm`, `ewrPragmaticM3PerDay`, `CropDef.cropFactor`; `run.ts:158` and `:585` index them with `waterYearIndex` | Storage order stays (Decision D4). Display rotates. |
| ~~SA seasons~~ | Removed with the legacy runoff model in engine 1.0.0 (issue #16): the summer months and winter thresholds of `flow.ts` · `seasonFlag()` (b023's season logic) are gone; GR4J has no season switch | – |
| A-pan is the only evaporation input | `demand.ts` · `grossCropMm()` ("WR90 A-pan × crop factor"); `project.ts` · `ProjectSettings.apanMm`; `run.ts:610` warning | `settings.evaporation` union (WP-I.5) |
| ~~Rain → flow is the b023 recession~~ | GR4J only since engine 1.0.0 (issue #16), behind the `RunoffModel` interface (`runoff/types.ts`) | Another generator (WP-I.6) |
| Rain priority is catchment → CHIRPS → forecast | `runoff/simulate.ts` · `runoffForcing()` (`flow.ts` · `rainUsed()` until engine 1.0.0); `run.ts:575-580`; `project.ts` · `SERIES_KINDS` (`rain_chirps_mm`) | `settings.rainPriority` plus series provenance (WP-I.10) |
| ~~Pitman is the modelled-flow fallback~~ | Removed in engine 0.10.0 (engine-audit P1): no fallback, no `flow_pitman_m3s` | A "modelled natural flow" kind with a source (GloFAS, WRSM, …) would be a new, comparison-only kind (WP-I.10) |
| EWR is 12 pragmatic m³/day values | `project.ts` · `ewrPragmaticM3PerDay`; `run.ts:156-158` | EWR rule sets (WP-I.7) |
| Allocation is proportional sharing | `network/curtailment.ts` · `computeCurtailment()` (equitable fraction ΣI/ΣH) | Allocation rule sets (WP-I.8) |
| Units fixed to m³/day, l/s, Mm³ | `curtailment.ts` · `M3_PER_DAY_PER_LS`; run series `unit` strings; UI | Display-unit layer (WP-I.9). The engine stays SI. |
| English strings leave the engine | `RunSummary.warnings: string[]`; `RunSeries.label`; `runoff/simulate.ts` series labels; `compare.ts` labels | Warning codes plus params (WP-I.3) |
| en-US number format | `frontend/src/lib/format/number.ts` · `fmtNum()` (`'en-US'` on purpose, to match the workbook), `fmtDate()`; `series/csv.ts:88` and `network/fields.ts:147` `toLocaleString('en-US')`; `projects/grouping.ts:45` `Intl.Collator('en')` | Locale-aware (WP-I.2) |
| **Fixed:** `parseNum` stripped commas | A comma-decimal `1,5` used to store **15**. Now a comma is a thousands separator only in a valid grouping (`1,500`); a lone non-grouping comma is a decimal comma; ambiguous input is rejected (commit 44308a8). | Locale-driven parsing still in WP-I.2 |
| **Fixed:** CSV dates assumed DD/MM | The order is now detected for the whole file (any part above 12); a mixed file is rejected; an undecidable file assumes day/month and the upload summary says so (commit 44308a8). | A user-chosen order and locale default still in WP-I.2 |
| CSV export is comma-only | `backend/src/export/csv.ts` · `csvRow()`; Excel in comma-decimal locales expects `;` | Export option (WP-I.2) |
| English markup | `frontend/src/app.html` `lang="en"`; `backend/src/mail/templates.ts` `lang="en"`, English bodies | Per-user locale (WP-I.1) |
| SA help content | `frontend/src/lib/help/content.ts`: water year "the South African hydrological year", A-pan "WR90 or WR2012 quaternary data", EWR "In South Africa the legal term is the ecological Reserve", Desktop Reserve Model, quaternary catchment, DWS gauge | Country-tagged entries plus translations (WP-I.12) |
| One region | `docs/deployment.md` § Region recommendation (af-south-1); `infra/` single stack | Stack per region (WP-I.14) |
| **Fixed:** CloudFront price class | The Terraform default was `PriceClass_200`, which AWS's price-class table excludes South Africa, Kenya, Nigeria, Egypt and the Middle East from ([CloudFront pay-as-you-go pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/)). | Now `PriceClass_All` (`infra/variables.tf`, commit 1f767df). |

### 5.2 Target shape

```
packages/engine/src/
  calendar.ts          waterYearIndex(m, start), daysPerMonth unchanged
  presets/             pure data: country presets (defaults only, versioned)
  evaporation.ts       A-pan ↔ ET0 conversion, FAO-56 Penman–Monteith (pure)
  generators/          gr4j.ts, awbm.ts  → FlowGenerator (b023.ts dropped: flow.ts went in engine 1.0.0)
  ewr/                 pragmatic.ts, tennant.ts, fdc.ts, series.ts   → EwrRule
  allocation/          proportional.ts (today), entitlement.ts, priority.ts
  warnings.ts          WarningCode + params, English renderer
backend/
  src/fetchers/<source>/   CHIRPS v3, ERA5-Land, IMERG, GloFAS, USGS, BoM/SILO, …
                           each with fixtures/ and a licence/attribution record
  migrations/NNN_*.sql     time_series provenance; app_user.locale
frontend/src/lib/
  i18n/                    messages/<locale>.ts, t(), plural(), locale state
  format/                  number/date/units by locale
  help/                    content.ts (en) + content.<locale>.ts, country tags
infra/                     one module, N regional instantiations (Step 4 seam)
```

Two principles run through all of it:

- **Presets are defaults, not behaviour.** Creating a project in country X
  copies that preset's defaults into `project.settings`. Runs snapshot
  settings, so a later preset revision never changes an existing project or an
  old run.
- **Rule sets are named and versioned.** Every run records
  `engineVersion` plus the generator, EWR and allocation rule ids and versions,
  so a report can say "EWR: Chile DS 14/2012-style Q95, v1".

## 6. Work packages

Build order. Step tags say where each lands. S ≤ 3 days, M ≤ 2 weeks, L > 2 weeks.

### WP-I.1 i18n foundation and Afrikaans (Step 2)

- **Goal:** every user-visible string comes from a message catalogue. Afrikaans
  ships as the second locale, for farmers (planned-work "Localisation" row).
- **Changes:**
  - **frontend:**
    - `src/lib/i18n/`:
      - `messages/en.ts` is the source of truth: a typed `const` object with
        nested keys (as built, since issue #9, there is no English catalogue:
        each message is its English at the call and `af.ts` is keyed by a
        hash of it; [ui.md § Language](../ui.md#language));
      - `messages/af.ts` is typed as `Messages`, so a missing key is a type
        error;
      - `t(key, params)` interpolates;
      - `plural(n, forms)` uses `Intl.PluralRules`;
      - a runes-based `locale` state.
    - Extract the ~400 literal strings from the 62 Svelte components.
    - Set `<html lang>` at runtime; `app.html` keeps `lang="en"` as the
      pre-hydration default.
    - Locale switcher in the account menu.
  - **backend:**
    - email templates take a locale: `templates.ts` gains `messages/<locale>`
      and `lang` in the HTML;
    - API error `code`s stay English machine codes, and the UI translates
      them.
- **Data model:**
  - `app_user.locale text null` (BCP 47, CHECK against a supported list).
  - The user reads and updates their own row under the existing self policy.
    No new visibility scope.
- **API:** `PATCH /me { locale }`. `GET /me` returns `locale`. Add both to
  api.md.
- **UI:**
  - The switcher shows each language's name in that language ("Afrikaans").
  - Help-page fallback: if an entry isn't translated, show English with a
    "not yet translated" note (`lang="en"` on that block).
- **Local-first equivalent:** none needed. Catalogues are files in the repo.
- **Tests:**
  - unit: `t()` interpolation and plurals;
  - a catalogue guard: every locale has every key, no unused keys, and no
    placeholder mismatch between locales;
  - a lint guard: no bare text nodes in `.svelte` outside `t()`, with an
    allowlist for units and symbols;
  - e2e: switch to Afrikaans, reload, it persists;
  - axe on the main pages in `af`;
  - an email template test per locale.
- **Docs:** ui.md (switcher), api.md, STACK.md (i18n convention),
  security.md (none).
- **Acceptance:**
  - With `af` selected, no English appears outside the allowlist on the
    project workspace.
  - Emails arrive in the user's locale.
  - The type check fails if `af.ts` misses a key.
- **Size:** M.
- **Depends on:** WP-I.3 (engine warning codes), so run warnings translate too.

**Library choice.** Build it in-house (about 100 lines on `Intl.PluralRules`)
rather than add a dependency:

- `Intl.MessageFormat` does not exist in browsers. The TC39 proposal is stuck
  at Stage 2 ([tc39 issue](https://github.com/tc39/proposal-intl-messageformat/issues/49)).
- `svelte-i18n` is store-based and was last published in October 2024
  ([issue](https://github.com/kaisermann/svelte-i18n/issues/248)).
- `typesafe-i18n` is unmaintained ([issue](https://github.com/codingcommons/typesafe-i18n/issues/739)).
- **The fallback is Paraglide JS** (MIT, compiled and tree-shakable, with an
  official `sv add paraglide` add-on: [repo](https://github.com/opral/paraglide-js),
  [Svelte docs](https://svelte.dev/docs/cli/paraglide)). Adopt it if a third
  locale makes the hand-rolled version strain. That follows the repo rule of
  extracting on the third use. See D5.

### WP-I.2 Locale-aware formatting and parsing (Step 2; the `parseNum` fix earlier)

- **Goal:** numbers, dates and CSVs read and write correctly in any locale, and
  never silently mis-parse.
- **Changes (frontend):**
  - `format/number.ts`: `fmtNum`, `fmtPct` and `fmtDate` take the active
    locale. `fmtDate` uses `Intl.DateTimeFormat` with `dateStyle: 'medium'`
    for display, and ISO stays available.
  - **`parseNum(input, locale)`:**
    - reads the locale's group and decimal symbols from
      `Intl.NumberFormat(...).formatToParts(1234.5)`;
    - accepts that locale's form and plain `1234.5`;
    - **rejects** ambiguous input such as `1,234` in a comma-decimal locale
      with a clear message, instead of guessing.
  - `NumberInput.svelte` passes the locale.
  - `series/csv.ts`:
    - the upload form asks for the date order (YYYY-MM-DD / DD/MM/YYYY /
      MM/DD/YYYY), defaulting from the locale;
    - it detects contradictions (a "13" in the month slot) and refuses
      ambiguity;
    - it accepts a decimal comma when the delimiter is `;`.
  - Replace the `toLocaleString('en-US')` calls (`csv.ts:88`,
    `network/fields.ts:147`) and `Intl.Collator('en')` (`grouping.ts:45`)
    with the active locale.
- **Changes (backend):** `export/csv.ts` takes `?sep=semicolon&decimal=comma`.
  The default stays RFC 4180 comma.
- **Data model:** a per-user number-format preference is folded into `locale`.
  No separate column unless users ask for one (for example English UI with
  comma decimals).
- **API:** export query parameters (api.md § Export).
- **UI:**
  - The upload preview shows the first three parsed dates spelled out
    ("3 April 2026") before anything is sent.
  - Number fields show their placeholder in the locale's format.
- **Local-first:** n/a.
- **Tests:**
  - unit, `parseNum` over `en`, `af`, `es-CL`, `pt-MZ`: `1,5` → 1.5 in `af`
    and **error** in `en`;
  - unit: `1 234,5` with a no-break space;
  - CSV: DD/MM vs MM/DD with and without disambiguating days, `;` plus decimal
    comma, a BOM;
  - TZ-skew runs (`Pacific/Kiritimati`, `Pacific/Pago_Pago`, as in
    `number.test.ts` and `freshness.test.ts`) for `fmtDate`;
  - e2e: upload an MM/DD file with the order chosen and check the preview.
- **Docs:** ui.md (upload), api.md (export).
- **Acceptance:**
  - No input path turns `1,5` into 15.
  - No CSV path turns an MM/DD file into different dates without the user
    having chosen the order.
- **Size:** S.
- **Depends on:** none. The `parseNum` and CSV date-order bug fixes already
  landed (commit 44308a8); this WP adds the locale-driven behaviour on top.

### WP-I.3 Structured engine warnings (Step 2)

- **Goal:** the engine returns codes plus parameters, not English sentences, so
  the UI can translate them. Stored runs stay readable.
- **Changes (engine):**
  - `warnings.ts` defines `type WarningCode = 'noRainfall' | 'runoffCoefficientAbove1' | …`
    and `renderWarningEn(code, params)`.
  - `RunSummary` gains `warningDetails?: { code; params }[]` alongside
    `warnings: string[]`, which is still produced in English for older
    consumers and exports.
  - Series get a stable `key`, which they already have. The UI labels them by
    key, not by `label`.
  - `ENGINE_VERSION` gets a patch bump. The output shape is additive and the
    numbers are identical.
- **Frontend:** translate by code, and fall back to the stored English text for
  runs saved before this version.
- **Tests:** a guard that every `warnings.push` in `run.ts` and `quality.ts`
  goes through a code; the renderer's English output equals today's strings,
  as a snapshot of the current set; the invariant suite unchanged.
- **Docs:** model.md §2.4 "Checks on every run"; api.md run summary.
- **Acceptance:**
  - Every warning has a code.
  - The Afrikaans UI shows translated warnings on new runs and English on old
    ones, without errors.
- **Size:** S.
- **Depends on:** none.

### WP-I.4 Configurable water year, and country presets (lands with Step 4 onboarding; engine part can land any time)

- **Goal:** a project picks its hydrological year and gets sensible
  country-specific defaults.
- **Changes (engine):**
  - `ProjectSettings.waterYearStartMonth: number` (1–12, default 10, validated
    in `run.ts` settings merging with a warning on bad values).
  - `waterYearIndex(calendarMonth, start = 10)`,
    `waterYearOf(epochDay, start = 10)`, `ewrCompliance(…, start)`,
    `observedAgreement`, `calibrationStats().annualVolumes` and `compare.ts`
    month labels all take the start.
  - **Storage order of `Monthly` arrays stays Oct-first**, a fixed storage
    convention renamed `MONTHLY_STORAGE_START = 10` (D4). A pure
    `rotateForDisplay(monthly, start)` serves the UI.
  - `presets/`: `za` (today's defaults), `sz`, `na`, `ke`, `au`, `cl`, `es`.
    Each holds `waterYearStartMonth`, `summerMonths`, `februaryDays`, units
    default, EWR rule default, evaporation kind, rain priority and glossary
    tags.
  - Preset values must each cite a source in a code comment or be marked "set
    by partner". Example: the Australian water year runs July–June
    ([BoM National Water Account FAQ](https://www.bom.gov.au/water/nwa/faq.shtml)).
  - `ENGINE_VERSION` minor bump. The default behaviour is identical, but the
    summary records the start month.
- **Backend:**
  - `project.settings` validation accepts the field.
  - Project creation accepts `presetId`, applies the defaults, and stores
    `settings.presetId` and `presetVersion` for provenance.
- **Frontend:**
  - `format/months.ts` becomes functions of `start`.
  - `EwrHeatmap`, `MonthlyBars`, `CropsTab`, `MonthPicker` and
    `crops/demand.ts` use it.
  - Settings shows a "Hydrological year starts in" select.
  - The new-project flow picks a country (default from the tenant, Step 4).
- **Data model:** none. It is JSONB settings.
- **API:** `POST /projects { presetId? }`; `GET /presets` (public list, on the
  allowlist, static data).
- **UI:**
  - Changing the start month shows a confirm dialog that explains what moves:
    reports and heat-map rows. Daily results don't change.
  - Viewers see the setting read-only.
- **Local-first:** presets are code.
- **Invariants (new):**
  - `checkWaterYearInvariance`: rotating `waterYearStartMonth` over 1–12
    leaves every daily series and every whole-run total identical. The EWR grid
    totals, days and volumes still sum to the run for every start. Grid rows
    have ≤ 366 days.
  - It is added to `checkAll` with a random start per fuzz case, then a
    `FUZZ_CASES=20000` soak.
- **Tests:**
  - unit: `waterYearOf` for every start, including leap days and January
    (calendar year);
  - the client catchment regression with the default start stays unchanged;
  - e2e: create a `ke` project and see the heat map columns start at the
    preset month;
  - axe on the Settings select.
- **Docs:**
  - model.md (new §2.12 "Water year and presets", glossary "Water year");
  - help `content.ts` "water-year" entry (country-neutral wording);
  - data-model.md settings.
- **Acceptance:**
  - A project with start 7 shows Jul…Jun everywhere.
  - Results for the same inputs are identical to start 10 except for
    period-grouped outputs.
  - The invariant holds on 20 000 cases.
- **Size:** M.
- **Depends on:** Step 4's tenant `country_code` for the default (it works
  without: the user picks).

### WP-I.5 Evaporation: A-pan or reference ET0 (Step 4 era; start after hydrologist N3)

- **Goal:** accept FAO-56 reference evapotranspiration (ET0) with FAO crop
  coefficients (Kc), which is what most of the world uses. Keep A-pan and
  convert correctly between the two.
- **Background:**
  - FAO-56 relates the two by ET0 = Kp × Epan (Eq. 55).
  - For a Class A pan, Kp is 0.4–0.85 depending on wind, humidity and fetch
    (Table 5) ([FAO-56 ch. 3](https://www.fao.org/4/x0490e/x0490e08.htm)).
  - The Penman–Monteith method is in [FAO-56](https://www.fao.org/4/x0490e/x0490e00.htm).
  - Hargreaves (Eq. 52) is the fallback when only temperature exists.
  - Audit N3 already asks whether the b023 crop factors are A-pan based
    ([engine-audit.md](../engine-audit.md)).
  - GR4J already has its own PE input (`settings.pe`, engine 0.31.0, issue
    #39: pan coefficient × A-pan, or a monthly row such as an ET0). This
    package is about the demand and dam side, which still read A-pan.
- **Changes (engine):**
  - `ProjectSettings.evaporation` is a union:
    - `{ kind: 'apan', apanMm: Monthly, kp?: Monthly }` (today; `apanMm` stays
      readable as an alias during expand/contract);
    - `{ kind: 'et0', et0Mm: Monthly }`;
    - `{ kind: 'et0Series' }`, which uses a daily `et0_mm` series.
  - `CropDef.coefficientBasis: 'apan' | 'et0'` (default `'apan'`, so today is
    unchanged).
  - `evaporation.ts`:
    - `cropWaterMm()` applies `Kc × ET0` or `cropFactor × Epan`, converting
      with Kp when the basis and the input differ;
    - `fao56Et0Daily(tmin, tmax, rh/dewpoint, u2, Rs, lat, elev, doy)` and
      `hargreavesEt0()`, both pure, for fetchers and for users with station
      data;
    - a warning when Kp is outside 0.4–0.85 or a crop's basis doesn't match
      the input with no Kp given.
  - `demand.ts` · `grossCropMm()` calls `cropWaterMm()`.
  - The planned dam-evaporation work (N2) reads the same evaporation source,
    with an open-water factor.
  - `ENGINE_VERSION` minor bump.
- **Backend:** series kind `et0_mm`. Settings validation.
- **Frontend:**
  - Crops tab: a "coefficient basis" select.
  - Settings: an evaporation source radio with the monthly table, or a pick of
    the ET0 series.
  - The help entries "A-pan", "Crop factor (Kc)" and "ET0" are rewritten to be
    method-neutral.
- **Invariants:**
  - with Kp = 1 and matching bases, demand is identical to today;
  - demand is linear in the evaporation input (doubling ET0 doubles gross
    demand);
  - conversion round-trips (A-pan → ET0 → A-pan) within 1e-12.
- **Tests:**
  - `fao56Et0Daily` against the FAO-56 worked examples in chapter 4, to 0.1 mm;
  - the client catchment regression is unchanged under the default;
  - e2e: switch a synthetic project to ET0 and see demand change as expected.
- **Docs:**
  - model.md §2.3, rewritten with both paths;
  - glossary (ET0, Kc, Kp);
  - data-model.md.
- **Acceptance:**
  - An ET0-based project with FAO Kc values runs.
  - An A-pan project gives today's numbers.
  - The UI never mixes bases without a stated Kp.
- **Size:** M.
- **Depends on:** WP-I.4 (presets choose the default kind); hydrologist answer
  N3.

### WP-I.6 Pluggable flow generators: GR4J first, AWBM second (Step 4, coordinated with the runoff module)

- **Goal:** natural flow from rain comes from a named generator, not only the
  b023 recession. The b023 recession's defaults assume one rainfall
  regime (other regions need their own), and audit H1 says it doesn't conserve event volume.
- **Status:** the GR4J half has landed through issue #4, under other names:
  the `RunoffModel` interface in `packages/engine/src/runoff/types.ts`, with
  `runoff/gr4j.ts`, recorded in `settings.runoffModel`. `runoff/legacy.ts`
  (the b023 recession) was the other model until engine 1.0.0 removed it
  (issue #16, audit H1 closed), so GR4J is the only one. AWBM still to come; it fits that interface rather than the
  `generators/` layout below.
- **Changes (engine):**
  - `generators/types.ts`:
    `interface FlowGenerator<P> { id; version; defaults(): P; validate(p): string[]; run(p, { rainMm, petMm?, areaKm2, startDate, days }): { naturalFlowM3Day; stores?; series; warnings } }`.
  - ~~`generators/b023.ts` wraps today's `flow.ts`~~: engine 1.0.0 removed
    `flow.ts` (issue #16), so there is no b023 generator to wrap.
  - `generators/gr4j.ts` is a daily 4-parameter model ([Perrin et al. 2003](https://doi.org/10.1016/S0022-1694(03)00225-7)).
    **Implement it from the paper, not from airGR, which is GPL-2**
    ([CRAN](https://cran.r-project.org/package=airGR)). airGR outputs can be
    used as a numerical test oracle offline, but no code is copied.
  - `generators/awbm.ts` ([Boughton 2004](https://doi.org/10.1016/j.envsoft.2003.10.007))
    is for the Australian market, where AWBM is familiar.
  - Sacramento (SAC-SMA) only when a customer requires it
    ([NOAA-OWP](https://github.com/NOAA-OWP/sac-sma); licence **(verify)**).
  - `ProjectSettings.flowGenerator: { id: 'b023' | 'gr4j' | 'awbm'; params }`.
    `settings.calibration` stays the b023 params (expand/contract).
  - GR4J needs PET: `settings.pe` today (pan coefficient × A-pan, or a
    monthly row, engine 0.31.0), or WP-I.5's evaporation input once it lands.
  - `ENGINE_VERSION` minor bump.
- **Relation to Step 4:** Step 4 owns the bucket module (model.md §5).
  One interface serves both. The first to land writes `types.ts`, and the other
  must fit it without changing it (flag in review).
- **Backend/Frontend:**
  - Settings shows a generator select with per-generator parameter forms,
    generated from a small per-generator field list (three generators justify
    it).
  - Calibration panel unchanged: stats are generator-agnostic.
- **Invariants (new, per generator):**
  - non-negative, finite flow and stores;
  - **mass balance per day**: rain − actual ET − flow − groundwater exchange
    = Δstorage (GR4J's exchange term F appears explicitly);
  - over a run, Σ flow ≤ Σ rain + initial storage + Σ exchange;
  - the runoff coefficient < 1 on a closed catchment with no exchange;
  - determinism;
  - the fuzz generator draws the generator id too. Soak.
- **Tests:**
  - GR4J against published or airGR outputs on a synthetic series, to 1e-9;
  - b023 wrapper identical to today's `computeNaturalFlow`;
  - e2e: switch the generator on an example catchment and run it.
- **Docs:**
  - model.md new §8 "Flow generators", with a formula table per generator;
  - glossary;
  - engine-audit.md H1 cross-reference.
- **Acceptance:**
  - A project runs end to end on GR4J.
  - Its mass balance closes to float noise.
  - b023 results are unchanged.
- **Size:** L.
- **Depends on:** WP-I.5; the Step 1 H1 decision; the Step 4 runoff-module
  timing.

### WP-I.7 EWR rule sets per jurisdiction (Step 3 interface; foreign methods Step 4 era)

- **Goal:** the environmental flow requirement comes from a named method, not
  only 12 typed numbers.
- **Methods, each a pure `EwrRule` that returns a daily EWR series from natural
  flow and settings:**

| Rule id | Method | Source |
| --- | --- | --- |
| `pragmatic` | Today's 12 monthly m³/day values | model.md §2.2, Q10 |
| `desktopReserve` | SA Desktop Reserve tables (percentiles by ecological category). **Step 3 builds the importer.** | [Hughes & Hannart 2003](https://www.sciencedirect.com/science/article/abs/pii/S0022169402002901) |
| `tennant` | Share of mean annual natural flow by season | [Tennant 1976](https://doi.org/10.1577/1548-8446(1976)001%3C0006:IFRFFW%3E2.0.CO;2) |
| `fdcPercentile` | Qp of the natural-flow duration curve, monthly or annual, optional cap as a share of mean annual flow. Covers Chile's caudal ecológico mínimo: monthly Q95, capped at 20 % of mean annual flow (40 % in qualified cases) | [DS 14/2012](https://mma.gob.cl/transparencia/mma/doc/DS_14_CaudalEcologicoMinimo.pdf) |
| `gefc` | IWMI Global Environmental Flow Calculator: monthly FDC at fixed points by environmental management class | [Smakhtin & Eriyagama 2008](https://doi.org/10.1016/j.envsoft.2008.04.002) |
| `regime` | User-entered minimum-flow regime per month, with optional ramp limits. Spain's *caudales ecológicos* in the basin plans set minimum and maximum flows, flood flows and rates of change ([IPH, Orden ARM/2656/2008](https://www.boe.es/buscar/doc.php?id=BOE-A-2008-15340)); the EU reference is [CIS Guidance No. 31](https://op.europa.eu/en/publication-detail/-/publication/b2369e0f-d154-11e5-a4b5-01aa75ed71a1) | as cited |
| `series` | A daily EWR series supplied by the user (e.g. an environmental watering plan). Australia's held environmental water is an **entitlement** managed by the CEWH ([DCCEEW](https://www.dcceew.gov.au/cewh)), better modelled as a user in WP-I.8 than as a flow floor | — |

- **Changes (engine):**
  - `ewr/` holds one file per rule.
  - `ProjectSettings.ewr: { rule, params, referencePeriod? }`.
    `ewrPragmaticM3PerDay` is kept and read as `{ rule: 'pragmatic' }`.
  - `run.ts:156-158` calls the rule instead of indexing the monthly table.
  - FDC-based rules compute percentiles on **natural flow over a reference
    period**, never on simulated flow.
  - `ENGINE_VERSION` minor bump.
- **Invariants:**
  - EWR finite and ≥ 0;
  - `fdcPercentile`: over the reference period, the share of days natural
    flow < EWR is 1 − p within 1/n;
  - `tennant`: annual EWR volume = fraction × natural volume;
  - the cap holds;
  - `pragmatic` is byte-identical to today;
  - the existing EWR checks in `checkBalance` are unchanged.
- **Tests:** a unit test per rule on synthetic flows; the client catchment regression
  unchanged; e2e on the Settings EWR method picker; axe.
- **Docs:** model.md new §9 "EWR rule sets", with each rule's legal source and
  "what it is not" (e.g. `fdcPercentile` is DS 14-*style*, not the DGA's own
  calculation, until validated: see §7).
- **Acceptance:**
  - A Chilean pilot project gets a monthly Q95 EWR from its natural flow.
  - Reports name the rule and version.
- **Size:** M.
- **Depends on:** WP-I.6 for natural flow on non-b023 generators; Step 3's
  Desktop Reserve importer for `desktopReserve`.

### WP-I.8 Allocation rule sets (Step 3 licences first; foreign regimes Step 4 era)

- **Goal:** curtailment follows the local legal regime, not only proportional
  sharing.
- **Regimes:**
  - **`proportional`** is today's equitable fraction ΣI/ΣH
    (`computeCurtailment`). It fits South Africa's current b023 practice and
    Kenya's permit system, subject to the Kenya WRA allocation plan
    ([WRA](https://wra.go.ke/water-use-allocation/)).
  - **`entitlement`**: each farm holds an entitlement volume. A season or
    year allocation % (the announced share) caps its take. This is the
    Murray–Darling pattern of entitlements under Sustainable Diversion Limits
    ([MDBA Water Act](https://www.mdba.gov.au/about-us/what-we-do/water-act)).
    It is the natural home for Step 3's water-use licence volumes.
  - **`priority`** is prior appropriation (western US):
    - rights ranked by priority date;
    - a senior call curtails upstream juniors;
    - Colorado's instream-flow rights are themselves priority-dated rights
      held by the state ([CWCB](https://cwcb.colorado.gov/focus-areas/ecosystem-health/instream-flow-program)).
- **Key design point:** `proportional` and `entitlement` can be post-run
  reports, as today. **`priority` cannot.** It must act *inside* the daily farm
  balance (`network/simulate.ts`), because a senior downstream call changes
  what upstream farms may take that day. So `priority` is L, and it waits for a
  US customer (D3).
- **Changes (engine):**
  - `allocation/` holds the files.
  - `ProjectSettings.allocation: { rule, params }`.
  - Node fields `entitlementM3PerYear?` and `priorityDate?`, which need a
    backend migration: new `node` columns with CHECK constraints. RLS is
    inherited, as they are columns on an existing table.
  - `ENGINE_VERSION` minor bump.
- **Invariants:**
  - `entitlement`: take ≤ entitlement × allocation % over the season;
    Σ reductions and gains still redistribute only water that exists
    (extends `checkReportTotals`);
  - `priority`: no junior diverts on a day a senior upstream of the call is
    short; the balance closes;
  - `checkOrderInvariance` holds, except that ties in priority date are
    broken by node id, documented.
- **Tests:** unit per rule; DB test for the new columns (CHECKs, a positive
  control that an editor can set them and a viewer can read them); e2e for
  the curtailment table under `entitlement`.
- **Docs:** model.md §2.11, generalised; data-model.md node columns; api.md.
- **Acceptance:** an MDB-style project with entitlements and a 60 % allocation
  shows each farm's cap and cut.
- **Size:** M (`entitlement`), L (`priority`).
- **Depends on:** Step 3 licences; hydrologist Q11/Q17.

### WP-I.9 Display units (Step 2 or 4; "Unit preferences" in planned-work)

- **Goal:** users see and type their units. The engine and DB stay SI.
- **Changes (frontend):**
  - `format/units.ts` defines unit systems:
    - `si-za`: m³/day, l/s, Mm³ (today);
    - `si-au`: ML/day, GL;
    - `si-eu`: m³/s, hm³;
    - `us`: cfs, acre-feet, inches, acres.
  - Conversions are definitional constants, unit-tested, e.g.
    1 ML = 1 000 m³ and 1 cfs = 0.028316846592 m³/s.
  - `NumberInput` converts on edit; the stored value is SI.
  - Charts and exports label the chosen unit. Exports offer SI always.
- **Data model:**
  - `app_user.unit_system` (user preference);
  - `project.settings.unitSystem` default from the preset. The user
    preference wins for display.
- **Invariants:** display → parse → store round-trips to 1e-12 relative.
- **Tests:** unit conversions; e2e on entering a dam capacity in acre-feet
  (it stores m³ and shows acre-feet back).
- **Docs:** ui.md, help "Units".
- **Acceptance:**
  - No engine change.
  - Every numeric field and chart honours the unit system.
- **Size:** S–M.
- **Depends on:** WP-I.2.

### WP-I.10 Global data fetchers, provenance and licences (on Step 2's fetcher framework)

- **Goal:** a new catchment anywhere gets rain, ET0 inputs and modelled flow
  prefilled. Every series carries its source, version and licence.
- **Sources** (all behind Step 2's scheduled-fetcher interface, each with
  synthetic fixtures):

| Source | Gives | Licence / terms | Notes |
| --- | --- | --- | --- |
| **CHIRPS v3** | Rain, 0.05°, 1981→, pentad and monthly; daily versions disaggregated with ERA5 or IMERG | CC BY 4.0 ([CHC](https://www.chc.ucsb.edu/data/chirps3)) | **v2 production continues only through 2026.** Step 2's CHIRPS fetcher should target v3 from day one. |
| **ERA5-Land** | Hourly 0.1°, 1950→: rain, 2 m temperature and dewpoint, wind, radiation (FAO-56 inputs) | CC BY 4.0 for Climate Data Store data since 2 July 2025 ([ECMWF forum](https://forum.ecmwf.int/t/cc-by-licence-to-replace-licence-to-use-copernicus-products-on-02-july-2025/13464)); CDS API account ([dataset](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land)) | Its "potential evaporation" is open-water, not FAO-56 ET0 ([ECMWF docs](https://confluence.ecmwf.int/display/CKB/ERA5-Land:+data+documentation)). Compute ET0 with `fao56Et0Daily` (WP-I.5). |
| **GPM IMERG** (Early/Late) | Near-real-time rain, 0.1°, about 4 h / 14 h latency | NASA open data; on [AWS Open Data](https://registry.opendata.aws/nasa-gpm3imergdf/) | V07 → V08 transition in 2026 ([NASA](https://gpm.nasa.gov/data/news/update-imerg-v08-transition-schedule-aug-2026)). Pin the version in provenance. |
| **GloFAS reanalysis v5** | Modelled daily discharge 1980–2025 | CEMS data store under CC BY 4.0 (above); [v5 release](https://global-flood.emergency.copernicus.eu/news/252-The%20new%20Copernicus%20GloFAS%20v5.0%20hydrological%20reanalysis%20has%20been%20released/) **(verify licence on the dataset page)** | The generalised "Pitman" slot: a modelled natural-ish flow for ungauged catchments. Coarse; label as modelled. |
| **GRDC** | Observed discharge, global | **Non-commercial only; no redistribution** ([policy](https://grdc.bafg.de/about/data_policy/)) | **Not a product data source.** Validation only, offline, with written permission. |
| **USGS Water Data OGC API** | US gauges, daily values | Mostly public domain ([docs](https://api.waterdata.usgs.gov/docs/ogcapi)) | Legacy WaterServices shut down in Q1 2027 ([USGS](https://waterdata.usgs.gov/blog/api-waterservices-decom/)). Target the OGC API only. |
| **BoM Water Data Online** | Australian gauges | Per data owner; most lead agencies CC BY 4.0 ([BoM](http://www.bom.gov.au/water/regulations/dataLicensing/index.shtml)) | API via the KiWIS service **(verify)**; see [bomWater](https://github.com/buzacott/bomWater) |
| **SILO** | Australian daily climate, 1889→ | CC BY 4.0, API key ([SILO](https://www.longpaddock.qld.gov.au/silo/)) | ET0 inputs for Australia |
| **Chile DGA** | 1,330 real-time stations; daily downloads capped at 4 years per request ([DGA](https://dga.mop.gob.cl/sistema-hidrometrico-en-linea/)) | Terms **(verify)** | Chunked fetch; CAMELS-CL for validation ([Alvarez-Garreton et al. 2018](https://hess.copernicus.org/articles/22/5817/2018/)) |
| **Spain Anuario de Aforos** | Gauges, reservoirs, evaporation stations; CSV per basin ([CEDEX](https://ceh.cedex.es/anuarioaforos/)) | **(verify)** | Bulk CSV import, not a live fetcher |
| **Kenya WRA** | Surface-water records, available for a prescribed fee, no public API ([WRA](https://wra.go.ke/surface-water-assesment-monitoring/)) | Per agreement | CSV upload through the existing merge path. The partner obtains the data. |

- **Maps and catchment data** (for Step 2's map work):
  - **Copernicus DEM GLO-30**: free, commercial use allowed, with a fixed
    attribution string ([licence](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf)).
  - **SRTM**: no restrictions ([NASA](https://www.earthdata.nasa.gov/data/catalog/lpcloud-srtmgl1-003)).
  - **HydroSHEDS** v2 is CC BY 4.0, and v1 allows commercial use with
    attribution. It covers basin and river delineation ([FAQ](https://www.hydrosheds.org/faq)).
  - **ESA WorldCover**: CC BY 4.0 ([ESA](https://esa-worldcover.org/en/data-access)).
  - **SoilGrids**: CC BY 4.0 ([ISRIC](https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs.html)).
    **Not HWSD v2**, which is CC BY-NC-SA ([FAO](https://openknowledge.fao.org/handle/20.500.14283/cc3823en)).
- **Changes:**
  - **backend:**
    - `src/fetchers/<source>/`, each with `fetch()`, `fixtures/*.json`
      (synthetic, tiny) and `meta.ts` (licence id, attribution text,
      commercial-use flag);
    - `FETCH_MODE=fixture` is the default in `.env.development`;
    - a registry refuses a source whose `commercialUse` is false in a
      production build (guard test);
    - credentials (CDS key, Earthdata, SILO key) live in SOPS
      (`infra-secrets/water-management/`), never in the repo.
  - **engine:**
    - `settings.rainPriority: SeriesKind[]`, default
      `['rain_catchment_mm','rain_chirps_mm','rain_forecast_mm']`, used by
      `runoff/simulate.ts` · `runoffForcing()` (formerly `flow.ts` ·
      `rainUsed()`) and `run.ts:575`;
    - new kinds `et0_mm` and `rain_gridded_mm`;
    - a new comparison-only `flow_modelled_m3s` ("modelled natural flow",
      with its source), never a driver or a fallback (`flow_pitman_m3s` was
      removed in engine 0.10.0, engine-audit P1).
  - **scripts:** `dev:fetch:<source>` per source, runnable against fixtures.
    It joins the root `//-- data --` group.
- **Data model:**
  - `time_series.source text`, `source_version text`, `licence text` and
    `attribution text` (nullable; NULL = user upload);
  - the migration adds the columns only. RLS is inherited from
    `time_series`, and the existing policies cover them.
  - **Run snapshots copy provenance**, so a report lists its data licences.
- **API:** series metadata returns provenance; the fetch-trigger routes are
  Step 2's.
- **UI:**
  - The Data tab shows the source badge and attribution.
  - Reports and exports append an attribution block (required by CC BY and
    the Copernicus DEM licence).
- **Local-first:** fixtures plus `FETCH_MODE=fixture`; no account needed for
  dev.
- **Tests:**
  - unit: each fetcher parses its fixture;
  - a guard that every source has `meta.ts` with a licence and that non-commercial
    sources are blocked in production;
  - DB test for the provenance columns (positive control: a member sees
    provenance on their series; a non-member sees nothing);
  - e2e: a fixture fetch fills a series and the badge shows.
- **Docs:** a new docs/data-sources.md; api.md; run-locally.md (fetch
  scripts); security.md (new outbound hosts, which are sub-processors only if
  personal data is sent: see §7).
- **Acceptance:**
  - A new `ke` project can pull CHIRPS v3 and ERA5-Land ET0 for its bounding
    box in dev from fixtures, and in prod from the live APIs.
  - Every series shows where it came from and under what licence.
- **Size:** M for the global three (CHIRPS v3, ERA5-Land, IMERG); S per
  national adapter.
- **Depends on:** Step 2 fetcher framework; WP-I.5 for ET0.

### WP-I.11 First-market language: Swahili, and the glossary workflow (Step 4 era, when Kenya is committed)

- **Goal:** the Kenyan WRUA-facing screens and help exist in Swahili,
  reviewed by a hydrologist.
- **Languages by market:**

| Market | Languages | Priority |
| --- | --- | --- |
| South Africa | English, Afrikaans (Step 2), isiZulu, isiXhosa (farmer-facing, on demand) | af now |
| Kenya | English, Swahili | sw with the pilot |
| eSwatini / Namibia / Lesotho | English (+ siSwati / Afrikaans / Sesotho on demand) | none needed to start |
| Mozambique | Portuguese (pt-MZ) | if Mozambique is chosen |
| Chile / Spain | Spanish (es-CL, es-ES: terminology differs, e.g. *caudal ecológico*, *regantes*) | with the LatAm/EU market |
| Arabic-speaking markets | Arabic, RTL | **not on the shortlist.** Only make CSS RTL-safe now (logical properties) |
| Francophone Africa | French | not on the shortlist |

- **CLDR coverage** is Modern for af, zu, sw, pt, es and ar, but **isiXhosa
  (xh) is only Moderate**. Expect gaps in month names and number patterns.
  Check browser support with `Intl.NumberFormat.supportedLocalesOf` in Chrome,
  Safari and Firefox before promising xh or zu, because browsers ship trimmed
  ICU data **(verify)**
  ([CLDR 47 coverage](https://unicode.org/cldr/charts/47/supplemental/locale_coverage.html)).
- **Translation workflow:**
  1. English strings change only at their `t()` calls (read by
     `scripts/guards/i18n_extract.mjs`) and in `help/content.ts`.
     CI lists new and changed messages per PR.
  2. A translation platform syncs with the repo:
     - Weblate is GPLv3 and self-hostable, and its Libre hosted plan is free
       for public projects ([Weblate](https://weblate.org/en/hosting/)). This
       repo is public, so it qualifies.
     - Crowdin has a free open-source plan ([Crowdin](https://crowdin.com/product/for-open-source)).
     - The platform receives **strings only**, never user data, so it is not a
       personal-data sub-processor.
  3. **The hydrology glossary is translated first and locked.** The source is
     the WMO/UNESCO *International Glossary of Hydrology* (WMO-No. 385: over
     1,500 terms in English, French, Russian and Spanish;
     [WMO](https://library.wmo.int/records/item/35589-international-glossary-of-hydrology),
     [UNESCO](https://unesdoc.unesco.org/ark:/48223/pf0000221862)). Swahili,
     Afrikaans and Portuguese terms are set by the partner hydrologist.
  4. Help `long` texts are translated by the partner. A native-speaker
     hydrologist reviews them, and every entry records its reviewer and date.
  5. Legal texts (privacy notice, terms) are translated by counsel, never by
     machine.
- **Help content restructure:**
  - `HelpEntry.countries?: string[]` tags SA-only entries (WR90/WR2012,
    quaternary catchment, Desktop Reserve, DWS gauge, Pitman). They show only
    for projects with that preset, or under "Other countries". **The field
    landed (issue #76):** six entries carry `ZA` and the glossary says
    "Applies in South Africa"; the filtering needs the presets (WP-I.4).
  - Neutral entries are reworded ("Water year: the 12-month hydrological year
    this project uses; in South Africa October–September").
  - Country entries are added, such as "Reserve (Kenya Water Act 2016)" and
    "Caudal ecológico (Chile)".
  - Translations live in `help/content.<locale>.ts` keyed by entry id.
    `content.test.ts` guards ids and fields.
- **Accessibility across scripts:**
  - `lang` goes on `<html>` and on any fallback block in another language, so
    screen readers switch voice.
  - Font stack: `system-ui` covers Latin. Arabic needs a system or Noto
    fallback declared before any Arabic ship.
  - Text expansion: Portuguese and Spanish often run longer than English. The
    Playwright layout smoke checks for no overflow on the workspace tabs, the
    curtailment table and the heat map at 360 px in the longest locale.
  - RTL: CSS logical properties (`margin-inline-start`) from WP-I.1 onward.
    Charts keep LTR time axes and Western digits unless a market asks.
  - axe runs per shipped locale.
- **Size:** M (Swahili UI + glossary + farmer-facing help); S per further
  locale once the pipeline exists.
- **Depends on:** WP-I.1, WP-I.3, partner in place.

### WP-I.12 Legal, privacy and liability package per country (with each market; non-code heavy)

- **Goal:** a tenant in country X has a lawful basis, transfer mechanism,
  registration, notices and liability wording before real data arrives. See §7
  for the per-country matrix.
- **Changes:**
  - Privacy notice per jurisdiction (template plus country annex), in the
    tenant's language.
  - Sub-processor list per region.
  - A breach runbook with per-country clocks (§7).
  - DPA/SCC templates.
  - **Report provenance block**, in every PDF, CSV or JSON export and the
    run page:
    - engine version, generator, EWR and allocation rule ids and versions;
    - preset id and version;
    - input snapshot hash;
    - data licences;
    - calibration stats;
    - the sign-off record (WP-I.14);
    - the "decision support, not a determination" wording.
- **Tests:** unit on the provenance block (every run field present); e2e that
  the notice shows in the tenant's language.
- **Docs:** security.md (per-country table), deployment.md (sub-processors per
  region).
- **Acceptance:** counsel's checklist is signed per country, and the CISO /
  Security Analyst has reviewed it.
- **Size:** M per first market, S after.
- **Depends on:** Step 4 tenant model; WP-I.13 for the region.

### WP-I.13 Region pinning and a second regional stack (on Step 4's multi-region seam)

- **Goal:** a tenant's data lives in its home region. A second region runs
  from the same Terraform module.
- **Changes:**
  - **infra:**
    - instantiate the Step 4 module per region;
    - per-region SES identity and configuration set (a sending reputation
      starts fresh per region, as deployment.md notes);
    - a per-region KMS key and SOPS slot;
    - `PriceClass_All` wherever users are in Africa, South America or
      Australia.
  - **backend:**
    - a start-up guard: the stack refuses a request for a tenant whose
      `home_region` ≠ its own region;
    - a unit test and a DB test with a positive control: a same-region tenant
      is served.
- **Region choice per market:** see §8.
- **Size:** L (mostly Step 4's). This plan adds the guard, the per-region SES
  runbook and the sub-processor table.
- **Depends on:** Step 4.

### WP-I.14 Kenya pilot and hydrologist sign-off (go-to-market; see §9)

- **Goal:** one Kenyan sub-catchment modelled, validated against local tools,
  and signed off by a local hydrologist.
- **Changes:**
  - **app:**
    - a `model_acceptance` record per project: who, their registration body
      and number, engine version, rule-set ids and versions, preset version,
      the run id validated, a validation summary, and known limitations
      (engine-audit open questions);
    - it is attached to reports (WP-I.12).
  - **data model:**
    - a new table `model_acceptance` (project-scoped);
    - RLS: members read, owners write;
    - same-project trigger on `run_id`;
    - covering index on `project_id` and `run_id`;
    - `GRANT … TO water_app` (`/safe-migration`);
    - it may reuse Step 1's sign-off mechanism if that already exists (check
      first; don't build twice).
- **Tests:** DB/RLS with a positive control (a member sees it; a non-member
  doesn't; a viewer can't write); e2e for recording and showing acceptance.
- **Size:** M of engineering; the pilot itself is calendar time (§9).
- **Depends on:** WP-I.4, I.5, I.7, I.10 (Kenya data), I.11 (sw), I.12 (Kenya
  legal).

### Build order at a glance

| Order | WP | Step | Size |
| --- | --- | --- | --- |
| 0 | `parseNum` fix (part of I.2) | 1 | S |
| 1 | I.3 structured warnings | 2 | S |
| 2 | I.1 i18n + Afrikaans | 2 | M |
| 3 | I.2 locale formatting and parsing | 2 | S |
| 4 | I.9 display units | 2/4 | S–M |
| 5 | I.4 water year + presets | 4 (engine part any time) | M |
| 6 | I.5 A-pan / ET0 | 4 | M |
| 7 | I.10 global fetchers + provenance | 2 framework, 4 sources | M |
| 8 | I.7 EWR rule sets | 3 interface, 4 methods | M |
| 9 | I.6 flow generators (GR4J) | 4 | L |
| 10 | I.12 legal package (Kenya) | 4 | M |
| 11 | I.11 Swahili + glossary | 4 | M |
| 12 | I.14 Kenya pilot + sign-off | 4 | M + calendar |
| 13 | I.8 allocation (`entitlement`; `priority` only for a US deal) | 3/4 | M / L |
| 14 | I.13 second region | 4 | L |

The Kenya pilot needs only rows 0–12, hosted in af-south-1 (§8). A second
region waits for the first non-African contract.

---

## 7. Security, privacy and compliance

**Loop in the CISO / Security Analyst** before choosing a region for a foreign
tenant, signing a DPA, or accepting government data. GovRAMP-scoped workloads
never go into this app (org policy).

### Per-country data protection

| Country | Law | Localisation? | Transfer mechanism | Breach clock | Registration |
| --- | --- | --- | --- | --- | --- |
| South Africa | POPIA ([s72](https://popia.co.za/section-72-transfers-of-personal-information-outside-republic/)) | No | Binding agreement / BCR / consent / contract | As soon as reasonably possible, via the Regulator's eServices portal since 1 April 2025 ([Covington](https://www.insideprivacy.com/data-security/data-breaches/south-africa-introduces-mandatory-e-portal-reporting-for-data-breaches/)) | Information Officer **(verify)** |
| Kenya | Data Protection Act 2019 | Only for "strategic interests of the state" processing (reg 26: civil registration, elections, public finance, protected systems) ([regs](https://new.kenyalaw.org/akn/ke/act/ln/2021/263/eng@2022-12-31)) | Proof of safeguards to the Data Commissioner before transfer (s48) | 72 h ([DLA Piper](https://www.dlapiperdataprotection.com/?t=breach-notification&c=KE)) | **Mandatory ODPC registration** unless both turnover < KES 5M and < 10 staff ([ODPC](https://www.odpc.go.ke/faqs/)) |
| eSwatini | Data Protection Act 5 of 2022 ([ESCCOM](https://www.esccom.org.sz/legislation/DATA%20PROTECTION%20ACT.pdf)) | No | s32 SADC countries; s33 adequacy for others | **(verify)** | Mandatory |
| Namibia | No law in force; bill tabled 2025 ([The Brief](https://thebrief.com.na/2025/08/namibias-data-protection-bill-to-be-tabled-in-september/)) | — | Contract | — | — |
| Botswana | Data Protection Act 18 of 2024 ([text](https://botswanalaws.com/bulletin/principal-legislation/bulletin-2024/act-18-of-2024---data-protection-act)) | **Conflicting:** one source says a copy must stay in Botswana ([CIPIT](https://cipit.strathmore.edu/understanding-botswanas-2018-and-2024-data-protection-acts/)); DLA Piper says no ([DLA Piper](https://www.dlapiperdataprotection.com/index.html?t=law&c=BW)) **(verify)** | Gazetted adequacy list (includes SA) | 72 h | Notify the Commissioner |
| Zimbabwe | Cyber and Data Protection Act 2021; SI 155/2024 ([DLA Piper Africa](https://www.dlapiperafrica.com/en/zimbabwe/insights/2024/A-Quick-Start-Guide-to-Zimbabwes-Data-Protection-Regulations)) | No, but POTRAZ may ban transfers | Adequacy or POTRAZ authorisation | **24 h** | Licence + DPO |
| Mozambique | No general law; draft bill Nov 2025 ([DataGuidance](https://www.dataguidance.com/jurisdiction/mozambique)) | — | Contract | — | — |
| EU / Spain | GDPR Chapter V; 2021 SCCs; EU–US DPF upheld by the General Court in Sept 2025, appeal pending ([IAPP](https://iapp.org/news/a/european-general-court-dismisses-latombe-challenge-upholds-eu-us-data-privacy-framework)) | No | Adequacy (South Africa is not on the EU adequacy list: [European Commission](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en)), so SCCs + TIA for af-south-1 hosting | 72 h | — |
| Australia | Privacy Act 1988, APP 8; 2024 amendments ([OAIC](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-8-app-8-cross-border-disclosure-of-personal-information), [POLA 2024](https://www.legislation.gov.au/C2024A00128/asmade)) | No for private buyers. **Commonwealth agencies must use Hosting Certification Framework providers** ([HCF](https://www.hostingcertification.gov.au/framework)) | The discloser stays accountable (s16C) | NDB scheme **(verify)** | — |
| Chile | Ley 21.719 (2024); in force 1 Dec 2026, a bill would delay it to 2027 ([FPF](https://fpf.org/blog/chiles-new-data-protection-law-context-overview-and-key-takeaways/), [CERCAI](https://cercai.cl/postergacion-ley-21719-2027-que-cambia/)) | No | Adequacy / model clauses / BCR | Without undue delay | — |
| Brazil (if pt-BR follows Mozambique) | LGPD; ANPD Res. 19/2024 SCCs mandatory since Aug 2025 ([Mayer Brown](https://www.mayerbrown.com/en/insights/publications/2025/08/end-of-grace-period-implementation-of-brazils-standard-contractual-clauses-in-international-transfers-of-personal-data)) | No | ANPD SCCs | 3 working days ([Mattos Filho](https://www.mattosfilho.com.br/en/unico/resolution-security-incident/)) | — |
| India (not recommended) | DPDP Act 2023 + Rules Nov 2025 ([India Briefing](https://www.india-briefing.com/news/dpdp-rules-2025-india-data-protection-law-compliance-40769.html/)) | Possible for Significant Data Fiduciaries **(verify)** | Allowed except to blacklisted countries | 72 h + CERT-In 6 h | — |

**What counts as personal data here.** Accounts are personal data: email,
name, sessions. Farm names can identify a natural person, and so can a farm's
water use, deficits and curtailment. That makes a per-farm result personal
data wherever the farm is a sole trader. Treat project data as personal data by
default. That is the conservative reading, and it matches the per-farm privacy
concern Step 2 already has.

**Region pinning (needs Step 4).**

- A tenant's `home_region` decides where its RDS, S3 and SES live.
- Nothing personal is replicated across regions.
- A cross-region support login is audited.
- Backups stay in-region.
- A move between regions is a documented runbook with the customer's written
  instruction, not a self-service button.

**Sub-processors per region:**

| Sub-processor | Role | Notes |
| --- | --- | --- |
| AWS | RDS, Lambda, S3, CloudFront, SES in that region | [DPA](https://d1.awsstatic.com/legal/aws-gdpr/aws-gdpr-dpa-online.pdf); [AWS sub-processors](https://aws.amazon.com/compliance/sub-processors/) |
| Stripe or local processor | Billing | Step 4 |
| Translation platform | Strings only | Not a personal-data sub-processor |
| Data APIs (Copernicus CDS, NASA Earthdata, USGS, BoM, SILO) | Receive bounding boxes and dates | Not personal data. A catchment's location can be **client-confidential**, so disclose it in the terms. |

**New trust boundaries:**

- **Outbound fetchers** with third-party credentials. Keys go in SOPS, an
  egress allowlist applies per source, and responses are parsed as untrusted
  input with size limits.
- **Public `/presets`** (static, no data). It goes on the allowlist and
  through `/audit/auth`.
- **Translated strings** can carry HTML. Keep `{@html}` out of translated
  text, and run `/audit/xss` on the i18n layer and the help renderer.

**Liability when results are used abroad.** Courts and regulators rely on the
**registered professional**, not the software:

- In South Africa, consulting natural scientists must be SACNASP-registered
  (Natural Scientific Professions Act 27 of 2003, s20;
  [SAFLII](https://www.saflii.org/za/legis/num_act/nspa2003332.pdf)).
- Experts must give objective, reasoned opinions (*Schneider NO v AA* 2010 (5)
  SA 203 (WCC); [summary](https://www.gilesfiles.co.za/expert-evidence-considered/)).
- Australia's Federal Court Expert Evidence Practice Note requires experts to
  disclose their assumptions and methods
  ([GPN-EXPT](https://www.fedcourt.gov.au/law-and-practice/practice-documents/practice-notes/gpn-expt)).

So:

- Terms state that outputs are decision support for review by a qualified
  professional, with governing law and a liability cap. Local counsel reviews
  them per country.
- Every report carries the provenance block (WP-I.12), so an expert can
  reproduce and explain it.
- **A rule set is never called "the official method"** until it has been
  validated against the regulator's own calculation. Until then it is "DS
  14/2012-style" and the report says so.
- The partner's professional-indemnity insurance covers their sign-off. Ours
  covers the software, not the hydrology.

**Retention.** Per-country retention can differ. Default to the tenant
contract. Account deletion and export work per region (the existing
`/audit/account-deletion-completeness` and `/audit/data-export-completeness`
run per regional stack).

## 8. Cost and operations

### Hosting options

| | Single global stack (af-south-1) | Stack per region (recommended once a non-African contract exists) |
| --- | --- | --- |
| Residency | Every foreign tenant is a cross-border transfer: SCCs for EU customers; fails Australian Commonwealth buyers (HCF) and possibly Botswana | Data stays in-region |
| Latency | Fine for SADC. Kenya has no AWS region: the Nairobi Local Zone is only "announced", with Cape Town as parent ([AWS Local Zones](https://aws.amazon.com/about-aws/global-infrastructure/localzones/locations/)). Poor for Sydney and Santiago on every API call and run. | Local |
| Blast radius | One | Per cell, which matches AWS's cell-based guidance ([Well-Architected](https://docs.aws.amazon.com/wellarchitected/latest/reducing-scope-of-impact-with-cell-based-architecture/)) |
| Ops | One deploy, one SES reputation | N deploys (one pipeline, matrix per region, each through the `production` environment), N SES warm-ups, N alarm sets |
| Idle cost | ≈ $48–52/month today (deployment.md) | ≈ that per region, adjusted by the regional premium |

### Region per market

| Market | Region | Opt-in | SES | RDS t4g.micro vs us-east-1 |
| --- | --- | --- | --- | --- |
| SA, SADC, Kenya | af-south-1 | Yes | Yes (API only, no SMTP) | ≈ +30 % |
| Spain / EU | eu-south-2 (Spain) or eu-west-1 | eu-south-2 yes | **No SES in eu-south-2**, so send via eu-west-1 (still EU) | ≈ +10 % / ≈ 0 % |
| Australia | ap-southeast-2 | No | Yes | ≈ +55 % |
| Chile | sa-east-1 now; a Chile region is announced for end-2026 ([Amazon](https://press.aboutamazon.com/aws/2025/5/amazon-to-invest-more-than-4-billion-to-launch-infrastructure-region-in-chile)) | No | Yes | ≈ +110 % (sa-east-1) |
| Western US | us-west-2 / us-east-1 | No | Yes | baseline |

Sources:

- Regions and opt-in: [AWS regions](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html).
- SES endpoints: [AWS SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html).
- Price ratios are derived from [RDS PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/)
  via [a third-party table](https://www.bytebase.com/dbcost/rds/instance/db.t4g.micro/)
  **(verify against the AWS page before budgeting)**.
- Lambda in af-south-1 is about +33 % per GB-second ([Lambda pricing](https://aws.amazon.com/lambda/pricing/)).

### Cost deltas and operations

- **CloudFront:**
  - Serving Africa, South America or Australia needs **PriceClass_All**
    ([pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/)).
  - Transfer out costs $0.110/GB to South Africa/Kenya and $0.114/GB to
    Australia/NZ, against $0.085/GB for the US and Europe.
  - Traffic is small (a SPA plus JSON), so the delta is a few dollars a month.
- **Rough budget:**
  - Each added region: ≈ $45–75/month idle, plus alarms and a budget.
  - Four regions: ≈ $200–300/month idle before usage.
  - Data API usage is free (CHIRPS, ERA5, IMERG, USGS) apart from compute and
    egress in the fetcher Lambdas.
- **Alarms per region:** the existing set (SES bounce/complaint, Lambda
  errors, RDS), plus per-fetcher staleness (Step 2).
- **Support load:**
  - Time zones: Kenya is UTC+3, near SA's UTC+2. Australia and Chile need an
    on-call arrangement or partner-first support.
  - Partners handle first-line support in the local language.
- **Runbooks:**
  - regional stack bootstrap;
  - SES sandbox exit per region;
  - tenant region move;
  - per-country breach notification (clocks from §7: Zimbabwe 24 h, Brazil 3
    working days, GDPR/Kenya 72 h);
  - ODPC registration renewal.

## 9. Validation

### Country and market shortlist (ranked)

Fit = how much of the engine works as-is × buyer need × ability to pay ×
incumbent weakness × our operational reach.

| Rank | Market | Water rights / licensing | E-flow requirement and method | Regulator / buyer | Language | Data | Data residency | Competition | Fit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **1** | **Kenya** | Water Act 2016: water is vested in the state, and every use needs a WRA permit ([Act](https://new.kenyalaw.org/akn/ke/act/2016/43/eng@2024-12-24); [WRA allocation](https://wra.go.ke/water-use-allocation/)) | The statutory **Reserve** (basic human needs + ecosystem): the SA concept ([Act PDF](http://kenyalaw.org/kl/fileadmin/pdfdownloads/Acts/WaterAct_No43of2016.pdf)) | WRA (six basin areas) and **756+ WRUAs** that deliver Sub-Catchment Management Plans ([WRA list](https://wra.go.ke/download/national-list-of-registered-wruas/); [KENAWRUA](https://kenawrua.org/)) | English, Swahili | Weak gauges, fee-based WRA records ([WRA](https://wra.go.ke/surface-water-assesment-monitoring/)); CHIRPS/ERA5 fill the gap | DPA 2019, no localisation for this use; ODPC registration | WEAP in allocation plans ([GWC](https://www.weap21.org/downloads/GWC_Report_4.pdf)) | **High**: the Reserve and a WUA-like structure map directly. Needs ET0, a non-winter generator and Swahili. |
| 2 | **eSwatini** | Water Act 2003: National Water Authority, five River Basin Authorities, irrigation districts, WUAs ([Act](https://faolex.fao.org/docs/pdf/swa45031.pdf); [JRBA](https://www.jointrbas.org/)) | National Water Policy 2018; method **(verify)** ([policy](https://www.gov.sz/images/MNRE_PICS/National-Water-policy----Final--Document-Aug-2018-1.pdf)) | RBAs, WUAs, irrigation districts: the closest structure to SA | English, siSwati | Shared rivers with SA (Komati, Usutu) | DPA 2022, SADC transfers allowed (s32) | Few | **High fit, small market.** Almost no engine change: SA preset + country tag. A near-home extension. |
| 3 | **Namibia** | Water Resources Management Act 11 of 2013, in force 29 Aug 2023; abstraction licence regs 2023/2025 ([Act](https://www.lac.org.na/laws/annoSTAT/Water%20Resources%20Management%20Act%2011%20of%202013.pdf); [GN 269/2023](https://namiblii.org/akn/na/act/gn/2023/269/eng@2023-08-29)) | Ecosystem principles, no quantified method found ([UNEP LEAP](https://leap.unep.org/en/countries/na/national-legislation/water-resources-management-act-2013-no-11-2013)) | Ministry (MAFWLR), NamWater | English, Afrikaans | HYDSTRA internally; no public API ([World Bank](https://documents1.worldbank.org/curated/en/910341625221179355/pdf/Assessment-of-Hydrometeorological-Services-in-Namibia-Final-Report-Executive-Summary.pdf)) | No DP law yet | Few | Medium: a new licensing regime creates demand. Afrikaans reuses Step 2. Small and arid. |
| 4 | **SADC basin commissions** (ORASECOM, LIMCOM, ZAMCOM) | SADC Revised Protocol on Shared Watercourses 2000 ([SADC](https://www.sadc.int/document/revised-protocol-shared-watercourses-2000-english)) | LIMCOM's first Joint Basin Survey (2024) set the ecological state and EWR ([LIMCOM](https://limpopocommission.org/article/1st-limpopo-joint-basin-survey-marks-acceleration-in-transboundary-water-cooperation/)); ZAMCOM GEF grant for e-flow rules ([AfDB](https://www.afdb.org/en/news-and-events/press-releases/gef-approves-945-million-grant-strengthen-climate-resilient-water-governance-zambezi-basin-90637)) | Commissions plus donors: GIZ ([GIZ](https://www.giz.de/en/projects/transboundary-water-management-sadc)), World Bank CIWA ([CIWA](https://www.ciwaprogram.org/about/)) | English, Portuguese | ORASECOM WIS uses DWS WRPM/WRYM ([WIS](https://wis.orasecom.org/tag/wrpm/)); ZAMWIS ([ZAMCOM](https://zambezicommission.org/zamwis)) | Multi-country | WRPM/WRYM, Pitman/SPATSIM ([Rhodes IWR](https://www.ru.ac.za/iwr/resources/software/spatsimoverview/)) | Medium: large basins exceed farm-scale design. Better as a tributary-scale channel through donors. |
| 5 | **Chile** | Código de Aguas, reformed by Ley 21.435 (2022): new rights up to 30 years ([BCN](https://www.bcn.cl/leychile/navegar?idNorma=1174443)) | DS 14/2012 caudal ecológico mínimo: monthly Q95, cap 20 % of mean annual flow ([DS 14](https://mma.gob.cl/transparencia/mma/doc/DS_14_CaudalEcologicoMinimo.pdf)) | DGA, water user organisations, mining and agribusiness; DGA strategic basin plans ([DGA](https://dga.mop.gob.cl/inicio-planes-de-gestion-estrategicos-de-cuencas/)) | Spanish | DGA network, 4-year download cap; CAMELS-CL | Ley 21.719 from 2026/27 | **WEAP backed by the DGA** ([SEI](https://www.sei.org/projects/supporting-strategic-watershed-planning-in-chile-through-weap/)) | Medium: a clean e-flow rule and good data, but a strong incumbent. AWS Chile region coming. |
| 6 | **Australia (MDB)** | Water Act 2007 + Basin Plan 2012 with SDLs ([MDBA](https://www.mdba.gov.au/about-us/what-we-do/water-act)) | Held environmental water (CEWH) ([DCCEEW](https://www.dcceew.gov.au/cewh)) | MDBA, states, irrigation operators, consultancies; markets turned over > A$4B in 2021–22 ([DCCEEW](https://www.dcceew.gov.au/water/policy/markets/introduction-water-markets)) | English | Excellent: BoM WDO, SILO | Privacy Act; HCF for Commonwealth buyers | **eWater Source is the national platform** ([eWater](https://ewater.org.au/resources/supporting-the-management-of-the-murray-darling-basin/)) | Low–medium: rich but saturated. A niche in unregulated catchments or farm-dam studies only. Needs `entitlement`. |
| 7 | **Spain / EU** | TRLA (RDL 1/2001); six-year basin plans ([BOE](https://www.boe.es/buscar/act.php?id=BOE-A-2001-14276)) | Caudales ecológicos per IPH ([Orden ARM/2656/2008](https://www.boe.es/buscar/doc.php?id=BOE-A-2008-15340)); CIS Guidance 31 | Confederaciones Hidrográficas; about 7,200 comunidades de regantes (FENACORE, > 80 % of irrigation) ([FENACORE](https://fenacore.org/fenacore/)) | Spanish (+ regional) | Anuario de Aforos CSV ([CEDEX](https://ceh.cedex.es/anuarioaforos/)) | GDPR, in-EU hosting expected | Aquatool, standard at the Júcar basin since 1995 ([UPV](https://aquatool.webs.upv.es/aqt/en/home/)) | Low–medium: a big irrigator base, but the incumbent and GDPR mean an EU region from day one. |
| 8 | **Mozambique** | Lei de Águas 16/91, administered by the ARAs ([DNGRH](https://dngrh.gov.mz/index.php/publicacoes/legislacao-dngrh/compendios/lei-de-aguas)) | Ecological-balance principle only | DNGRH, ARAs, LIMCOM/ZAMCOM ([ARA Centro](https://aracentroip.gov.mz/)) | Portuguese | Poor | No DP law yet | Few | Low now: donor-driven, Portuguese needed. Enter via basin commissions. |
| — | Western US | Prior appropriation; Colorado water courts and CWCB instream flows ([CWCB](https://cwcb.colorado.gov/focus-areas/ecosystem-health/instream-flow-program)) | Instream flow rights | State engineers, districts | English | Excellent (USGS) | No federal law | StateMod ([CDSS](https://cdss.colorado.gov/software/statemod)) | **Not now**: needs in-simulation `priority` (L) and faces entrenched state models |
| — | India | No national rights law ([NWP 2012](https://nwm.gov.in/sites/default/files/national%20water%20policy%202012_0.pdf)); Ganga e-flow notification 2018 ([Drishti](https://www.drishtiias.com/daily-updates/daily-news-analysis/government-notifies-e-flow-for-ganga)) | Percent of monthly flow | Government only | Many | Major basins classified ([NWDP](https://nwdp.nwic.gov.in/dataset/river-discharge-manual-dailly-central-water-commission-cwc)) | DPDP | — | **Not now** |
| — | Botswana, Lesotho, Zimbabwe | Water Act 1968 ([FAOLEX](https://faolex.fao.org/docs/pdf/bot42103.pdf)); Water Act 2008 ([LesLII](https://lesotholii.org/akn/ls/act/2008/15/eng@2008-12-30)); Water Act 1998 permits ([ZimLII](https://zimlii.org/akn/zw/act/1998/31/eng@2016-12-31)) | Lesotho LHWP IFR policy; others none statutory | DWS Botswana; DWA Lesotho; ZINWA + 7 catchment councils | English (+ Sesotho) | Thin | Botswana copy rule **(verify)**; Zimbabwe 24 h breach + licence | — | Opportunistic via ORASECOM/LIMCOM; Zimbabwe has payment and compliance friction |

### Recommendation

- **First expansion market: Kenya.**
  - The legal concept the app is built around, a statutory Reserve checked at
    a gauge, exists in Kenyan law.
  - Hundreds of WRUAs must produce sub-catchment plans.
  - The incumbent is general-purpose (WEAP), not farm-scale.
  - It is English-first.
  - It can be hosted from af-south-1 without localisation.
  - It is reachable in the same working hours.
- **Serve eSwatini and Namibia as near-home extensions:** SA preset, country
  tag, English/Afrikaans. They need no new WP beyond WP-I.4's preset and
  WP-I.12's notice.

### Pilot approach (Kenya)

1. **Partner.** Sign a Kenyan hydrology consultancy already doing SCMP or
   allocation work. The partner owns the client relationship, data purchase
   from WRA, Swahili review, first-line support and sign-off.
   - Commercial: a revenue share or a reseller licence (D6).
   - The partner holds professional-indemnity cover for its sign-off.
2. **Pilot catchment.** One WRUA sub-catchment with:
   - ≥ 10 years of daily gauge record at or near the outlet;
   - several permitted abstractors and at least one farm dam;
   - a WRUA willing to be the user.
   - The partner and WRA choose it.
   - **Nothing about it is committed to this repo** (public-repo rule).
     Synthetic fixtures mirror its shape.
3. **Parallel run.** The partner runs the pilot in its current tool (WEAP or a
   spreadsheet) and in the app on the same inputs for one full hydrological
   year of hindcast plus one live season.
4. **Validation protocol.** It is recorded in the `model_acceptance` record,
   WP-I.14.
   - Natural flow against the gauge: NSE, KGE, log-NSE and PBIAS over a stated
     window, judged against the mean-flow benchmark rather than Moriasi's
     monthly pass marks (model.md §2.10, calibration research CR-6).
   - Annual volumes within the partner's tolerance.
   - Irrigation demand against WRA permit volumes and metered or estimated
     use.
   - EWR series against the Reserve figures the WRA or the SCMP uses.
   - A differences log: every material difference from the partner's tool,
     explained (in the style of the engine-audit deviation list).
5. **Sign-off.** A registered Kenyan hydrologist signs the acceptance record.
   It names the engine version, generator, EWR and allocation rules, the
   preset version, the validated run, the known limitations (open
   engine-audit questions) and the scope ("sub-catchment planning; not a
   permit determination").
   - A new engine version or rule-set version needs re-acceptance, or a
     documented delta review.
6. **Go/no-go** after the live season: WRUA usage, the partner's willingness
   to sell, and at least one paying organisation (the Step 3 → 4 gate
   applied).

### Personas

Run the existing ones first:

- **`persona-international-user`** now, as a baseline. Expected defects:
  - `parseNum` comma stripping;
  - DD/MM CSV assumption;
  - en-US formats;
  - `lang="en"`;
  - English engine warnings;
  - SA-only help.
  - It must conclude "defects fixed; gaps are listed WPs".
- **`persona-hydrologist`** with the prompt "you are a hydrologist in Kenya,
  or in Australia, who works in ET0 and GR4J/AWBM". It must conclude that the
  app can represent their method without workarounds.
- **`persona-environmentalist`** on the EWR rule sets. Each rule must be
  honest about what it is and isn't.
- **`persona-licensing-authority`** with a WRA lens: reproducibility and the
  provenance block.

Personas to add (`.claude/agents/personas/persona-*.md`, following
`.claude/personas/README.md`) once a market is committed:

- **`persona-kenya-wrua`**: a WRUA officer, Swahili/English, phone-first,
  writing an SCMP and resolving upstream/downstream disputes.
- **`persona-kenya-wra-officer`**: a basin-area permit officer checking the
  Reserve and permit volumes.
- **International-user country packs**: specialise
  `persona-international-user` into `ke` (KES, Swahili, UTC+3, +254 phone),
  and later `es-CL` / `es-ES` (comma decimals, Spanish hydrology terms) and
  `au` (ML/GL, July–June year).
- **`persona-mdb-irrigator`**: only if Australia moves up the ranking.

**Need verdicts to record here:** each persona's "would adopt / would not,
and why".

### Questions for the client and operator

1. Does the client want the app offered outside South Africa, and through
   whom (D1)?
2. Do the client's hydrologists have partners or projects in Kenya, eSwatini
   or Namibia already?
3. Can the client's hydrologist review the ET0 and GR4J changes, or does the
   partner do it?
4. Which consultancy in Kenya? Any existing SADC donor project to attach to?

## 10. Exit criteria

For the international track (first market live):

- WP-I.1–I.3 shipped in Step 2. Afrikaans live, with no English leaks on the
  workspace.
- The Kenya preset exists (water year, seasons, ET0 default, EWR rule),
  documented in model.md with sources.
- GR4J (or another volume-conserving generator) passes the mass-balance
  invariant on a 20 000-case soak.
- The pilot catchment runs on CHIRPS v3 + ERA5-Land ET0 + partner-supplied WRA
  gauge data, with provenance and licences shown.
- Swahili UI for WRUA-facing screens and glossary, reviewed by a hydrologist.
- The Kenya legal package is done:
  - ODPC registration;
  - s48 safeguards documented;
  - privacy notice in English and Swahili;
  - terms reviewed by Kenyan counsel;
  - the CISO / Security Analyst has signed off.
- A signed `model_acceptance` record by a registered Kenyan hydrologist.
- At least one paying Kenyan organisation, or a signed partner agreement.
- The CloudFront price-class fix is live.

## 11. Open decisions

| # | Decision | Options | Recommendation | Who decides |
| --- | --- | --- | --- | --- |
| D1 | Commercial model abroad | Operator sells directly; through local partner consultancies; joint venture with the client | Agree in writing **before** any partner talks | Client + operator |
| D2 | First market | Kenya; eSwatini/Namibia first; Chile | **Kenya.** eSwatini and Namibia as near-home extensions in parallel | Operator + client |
| D3 | Build `priority` (prior appropriation) allocation? | Now; with a US deal; never | **Only with a signed US customer**: it is L and reaches into `simulate.ts` | Operator |
| D4 | `Monthly` storage order | Keep Oct-first storage and rotate for display; migrate to calendar order (Jan-first) | **Keep Oct-first** internally (no data migration, no regression risk). Expose calendar-keyed objects (`{ "jan": … }`) in Step 4's public API. | Engineering |
| D5 | i18n library | In-house on `Intl.PluralRules`; Paraglide JS | **In-house** for en + af. Re-evaluate at the third locale. | Engineering |
| D6 | Partner model | Reseller (partner bills); referral (we bill, partner fee); white-label | **Reseller** for the pilot: the partner already owns the relationship and the data purchase | Operator |
| D7 | Hosting topology | Single stack; stack per region with no global DB; stack per region plus a global directory | **Single af-south-1 stack until the first non-African contract**, then per region with region subdomains and **no global directory** until cross-region SSO is needed (Step 4) | Operator + CISO |
| D8 | Kenya hosting | af-south-1; eu-west-1 | **af-south-1**: nearest region, no localisation duty for this use, and one stack | Operator + CISO |
| D9 | Default number format for SA users | Keep en-US (matches the workbook); follow the browser locale | **Follow the user's chosen locale, default en-ZA-as-today**, so nobody's numbers change without a choice | Client |
| D10 | CloudFront price class | — | **Done:** the default is now `PriceClass_All` (commit 1f767df). Per-region stacks keep it unless a region serves only Europe/North America. | — |
| D11 | GRDC data | Use under agreement; exclude | **Exclude from the product.** Validation only, offline, with permission | Engineering |

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| The b023 recession (H1) doesn't transfer to bimodal East African rainfall | High | High | GR4J (WP-I.6) before the pilot calibrates. H1 closed at Step 1: engine 1.0.0 removed the b023 recession, GR4J is the only model. |
| Rule sets are read as "the official method" in a permit or court case | Medium | High | "-style" naming until validated, the provenance block, partner sign-off, terms |
| Ability to pay in donor-funded markets | High | Medium | Attach to donor programmes (GIZ, CIWA, GEF). Price per basin or programme, not per seat. |
| Incumbents (WEAP, Source, Aquatool, StateMod) | High in AU/ES/CL/US | Medium | Lead where the farm-scale daily balance plus Reserve is the job (Kenya, SADC). Don't compete head-on in the MDB. |
| Data licence breach (GRDC non-commercial; HWSD NC) | Medium | High | `meta.ts` licence registry with a production guard; attribution in reports |
| Upstream data changes (CHIRPS v2 ends 2026; USGS WaterServices off Q1 2027; IMERG V08) | High | Medium | Target v3 and the OGC API now; pin source versions in provenance; staleness alarms |
| Legal moving targets (Chile 2026→27, Namibia and Mozambique bills, Botswana copy rule, DPF appeal) | High | Medium | Per-country checklist re-reviewed at each tenant signing; counsel and CISO |
| Translation quality of hydrology terms | Medium | Medium | Glossary first, WMO-385 as the anchor, partner-hydrologist review recorded per entry |
| Operational spread (N regions, time zones, SES reputations) | Medium | Medium | Stay single-region until a contract pays for a second; partner first-line support |
| Client confidentiality leaks into the public repo (pilot names, gauge data) | Low | High | Synthetic fixtures only; `data/` stays gitignored; gitleaks + review |
| Scope creep into a general basin model | Medium | Medium | The generator, EWR and allocation interfaces are bounded. Large-basin routing stays out (use basin commissions via tributary-scale projects). |
