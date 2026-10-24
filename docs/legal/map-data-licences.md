# Map data licences: the Terms clause and the farm map credits

> **Not legal advice.** Pre-counsel research by the legal research agent (issue #90, 2026-10-11), for the operator and a South African attorney to review. Counsel's review is tracked in #92; the credit fix is #523 C6.
>
> **Status (2026-10-12): item (b) is built** (#523 C6, as § 5.3 recommends). The facts in § 2 and § 4.2 describe the code before it. A traced dam is now credited on the farm map and on the Map tab: "Dam outline: traced from JRC Global Surface Water (Source: EC JRC/Google), modified", linking to `/data-sources#jrc-water`. The farm map's credits are one line under the map, not over it. Where each credit shows is listed in [maps.md § Credits on the map](../maps.md#credits-on-the-map). The Terms wording (§ 5.1) and the questions for counsel are still open.

## 1. Question and short answer

**Question.** Do the Terms and map credits meet the licences of the third-party map data the app shows (HydroSHEDS/HydroRIVERS, and the JRC Global Surface Water credit)? If not, what wording or credit change fixes it? (Issue #90, "Map counsel items".)

**Short answer.**

- **(a) Terms §9 "Map data licensed to us" against HydroSHEDS §2.1.2 / §2.1.3.** It covers both things those sections expressly ask for: no distribution as a stand-alone product, and no decompiling, reverse engineering or disassembly. But it is **not clearly "at least as protective" as the licence as a whole**:
  - it doesn't say the data is for the user's own use and "not for redistribution" (§1.2);
  - it allows the GeoJSON export of HydroRIVERS geometry without saying so;
  - it gives a thinner disclaimer than §4 and §6;
  - it has no back-to-back indemnity for the operator's own §5.2 exposure to WWF.

  **Confidence: medium** on the two named sections, **low-medium** on "at least as protective" overall. Tightened wording and a short written confirmation from WWF/HydroSHEDS would settle it.
- **(b) The farm map credits.** Both reported gaps are still in the code.
  - **HydroSHEDS: no breach (medium-high confidence).** Exhibit B requires its statement in the product's "documentation or metadata", and the public `/data-sources` page carries it. The on-map credit is extra. That it covers about a fifth of the phone map is a usability problem, not a licence one.
  - **JRC: a real but small shortfall (medium confidence).** A dam traced from JRC GSW shows on the farm map with no "Source: EC JRC/Google" and no note that it was modified. JRC's terms ask for that credit on a published map, and Copernicus Delegated Regulation 1159/2013 Art. 8 asks users to name the source and say when data was modified.
  - **The premise is wrong on one point:** JRC GSW is **not CC BY 4.0**. It is Copernicus "free of charge, without restriction of use".

  This is a code fix, not wording for counsel.

## 2. Facts relied on

| Fact | Where confirmed |
| --- | --- |
| Operator is a sole proprietor in Virginia, USA. The service is free today. | `frontend/src/routes/terms/+page.svelte` §1, §8 |
| The clause text (quoted in §3.1 below) is part of Terms §9 and survives termination (§11 lists 9). | `frontend/src/routes/terms/+page.svelte` lines 154-164, 178 |
| The current `LEGAL_VERSION` is `2026-10-09`. The clause has not changed since 2026-10-03. | `packages/engine/src/legal.ts:12`; `git log` on the Terms page; `docs/legal-status.md` § Change log 2026-10-03 |
| The Terms' indemnity (§14) protects only "Jared Howard and our contractors and agents", not data licensors. | Terms §14 |
| Terms §12 disclaims warranties "as is". §13 caps liability. §17 has an export/sanctions line. §9 says third-party sources are "also subject to their own terms". | Terms §9, §12, §13, §17 |
| Accepting an invitation counts as accepting the Terms. The Terms are English only, and binding Afrikaans-reading farmers is already an open counsel item. | Terms §1; `docs/legal-status.md` (Phase list, "Whether English-only Terms bind Afrikaans-reading farmers") |
| HydroRIVERS geometry reaches users in three ways: the River network layer, rivers added to a project, and the **GeoJSON export**. The export carries a `credit` on HydroRIVERS rivers and JRC-traced dams. | `docs/maps.md` § Download GeoJSON (~l.555-570); `frontend/src/lib/components/map/mapExport.ts` (`featureCredit`) |
| Share links and the report route don't render map geometry, so recipients who accepted no Terms never receive HydroRIVERS geometry. | grep of `frontend/src/routes/share/+page.svelte` and `projects/[id]/report/+page.svelte`: no map features |
| The map's attribution control is always expanded (`compact: false`, "the basemap's licence must stay visible"). It adds the HydroRIVERS credit while credited reaches or features are drawn. | `frontend/src/lib/components/map/CatchmentMap.svelte` l.409-423, 482 |
| The farm map is fixed at 280 px high, using the same `CatchmentMap`. | `frontend/src/lib/components/farm/FarmMapCanvas.svelte` (style `.farm-map :global(.map) { height: 280px }`) |
| The farm map route sends `credit: 'hydrorivers'` only. A traced dam's description, which holds the JRC credit, is never sent. | `backend/src/farms/view.ts` (`FarmMapFeature.credit?: 'hydrorivers'`, `farmMap()` SELECT has no description); `frontend/src/lib/components/farm/farmMap.ts` `asMapFeatures` |
| The JRC credit appears only in a traced feature's description (Map tab side panel), in the GeoJSON export and on `/data-sources#jrc-water`. It never appears in the attribution control. | `docs/maps.md` l.477-480, 519-523; `grep JRC_WATER_STATEMENT` hits only `mapExport.ts` and `dataCredits.ts` |
| The "fifth of the phone map" finding comes from the round-4 persona review. I didn't measure it myself. | PR #369 body, "Judgement calls for the operator": "Farm map attribution box covers about a fifth of the 280 px phone map, and the farm map has no JRC credit for a traced dam" |
| Dam tracing is off by default in production (`dam_trace_water`). I couldn't confirm whether production has it or the HydroRIVERS load on: the tfvars live outside the repo. | `infra/lambda.tf:203`, `infra/map_data.tf:236` |

## 3. Law (the licence terms)

### 3.1 HydroSHEDS version 1 License Agreement

Source: HydroSHEDS Technical Documentation v1.4, Appendix A, fetched as PDF from `data.hydrosheds.org` and read in full. The HydroRIVERS product page says its data "are distributed under the same license agreement as the HydroSHEDS core products". The licence is governed by District of Columbia law (§10.1).

The Terms clause it is measured against reads:

> "You may use it within the service, and as part of your projects and the results, reports and maps you make with it. You may not copy, extract or distribute that data on its own, as a stand-alone dataset, and you may not decompile, reverse engineer or disassemble it. It remains the property of its licensors, who provide it as it is, without any warranty, and are not liable for your use of it."

What the licence says:

- **§1.2 End Users:** parties licensed "pursuant to a written license agreement for such party's use and not for redistribution."
- **§2.1.2:** the licensee may distribute the Licensed Materials incorporated into Derivative Works to End Users, "subject to the terms and conditions of an end user license agreement with terms that are at least as protective of the Licensed Materials as are the terms of this License … In no event shall Licensee license or distribute the Licensed Materials as a stand-alone product."
- **§2.1.3:** "Licensee shall not decompile, reverse engineer, or disassemble the Licensed Materials … except as expressly authorized by this License or by prior written consent of WWF, and shall include such restrictions in its license agreement with End Users. Licensee shall protect against unauthorized copying and/or distribution of Licensed Materials … with the same degree of care that it protects its Licensee confidential information."
- **§3:** WWF "shall own and retain all Intellectual Property Rights in the Licensed Materials."
- **§4.1:** "PROVIDED 'AS IS' AND WITH ALL FAULTS. THE ENTIRE RISK AS TO SATISFACTORY USE, PERFORMANCE, QUALITY AND ACCURACY … IS WITH LICENSEE." It disclaims all warranties, including fitness and non-infringement.
- **§4.2:** the licensee shall not "make any representation or warranty whatsoever on behalf of WWF."
- **§5.2:** "Licensee will defend, indemnify and hold WWF harmless from and against any Claim arising out of or relating to (i) the use by Licensee … or End Users of the Licensed Materials."
- **§6:** WWF is not liable for indirect, special, incidental or consequential damages. Its liability is capped at the royalty paid, which is zero here.
- **§7.1:** the licence terminates "automatically upon any breach … or (ii) in the sole discretion of WWF". Under **§7.2**, End User licences entered before termination continue.
- **§8.1:** no use of WWF's name or marks without consent. The required attribution is the exception.
- **§10.7:** the licensee keeps records for 2 years of its activities, including "the identity and address of each End User".
- **§10.8:** US export control.
- **Exhibit B:** a set copyright statement "must be displayed with, attached to or embodied in (in a reasonably prominent manner) the **documentation or metadata** of any Licensee Product or Program provided to an End User."

Secondary note: the hydrosheds.org website terms ("Last updated May 2026") are non-commercial, but they govern the website. They say "All data products come with specific license terms."

### 3.2 JRC Global Surface Water and the Copernicus data policy

- **JRC download page** (global-surface-water.appspot.com/download) and Google Earth Engine catalogue (GSW v1.4):
  - "All data here is produced under the Copernicus Programme and is provided free of charge, without restriction of use. For the full license information see the Copernicus Regulation."
  - "Publications, models, and data products that make use of these datasets must include proper acknowledgement, including citing datasets and the journal article."
  - "If you are using the data as a layer in a published map, please include the following attribution text: 'Source: EC JRC/Google'."
  - **Not CC BY 4.0.**
- **Commission Delegated Regulation (EU) No 1159/2013, Art. 8.** Read on legislation.gov.uk, because EUR-Lex returned an empty bot-check page. The text on legislation.gov.uk is the version as at 31 Dec 2020, the end of the Brexit transition period.
  > "1. When distributing or communicating GMES dedicated data and GMES service information to the public, users shall inform the public of the source of that data and information. 2. Users shall make sure not to convey the impression to the public that the user's activities are officially endorsed by the Union. 3. Where that data or information has been adapted or modified, the user shall clearly state this."
- **Is 1159/2013 still current?** Regulation (EU) 2021/696 repealed 377/2014, the parent regulation. Its title doesn't list 1159/2013. The Copernicus Land Service data policy page still cites 1159/2013 alongside 2021/696 (secondary). I couldn't confirm the consolidated position on EUR-Lex. **Treat Art. 8 as the operative rule, unverified.**

### 3.3 OpenStreetMap credit placement (relevant to the fix)

OSMF Attribution Guidelines (secondary-official guidance):
- Attribution "may be placed adjacent to the map".
- It may collapse "automatically on map interaction such as panning, clicking, or zooming" or after five seconds, if the licence stays findable.

### 3.3a GeoNames: the Map search's place names (added 2026-10-13)

Not part of the question above, recorded here so this page covers every licensor whose data the map serves.

- **What is used.** GeoNames' country dumps for South Africa (`ZA`) and, since 2026-10-13, its six neighbours (`BW`, `LS`, `MZ`, `NA`, `SZ`, `ZW`), a neighbour's places only inside the basemap's extent. Names, feature codes, province codes, country codes and positions, stored in `gazetteer_reference` and searched by the Map tab (`docs/maps.md` § Search, § Gazetteer).
- **The licence.** Each of the seven dumps carries the same `readme.txt`: "This work is licensed under a Creative Commons Attribution 4.0 License" and "The Data is provided "as is" without warranty or any representation of accuracy, timeliness or completeness" (read 2026-10-13). CC BY 4.0 allows commercial use and adaptation with attribution, so adding the neighbours changes no term. No share-alike, no field-of-use limit, no country carve-out.
- **The credit.** "GeoNames (geonames.org), CC BY 4.0" is stored on every place and shown under every search that lists one, linking to `/data-sources#geonames`, whose entry names the countries and links the licence. CC BY 4.0 §3(a)(1) asks for the licensor's identification, a licence link and an indication of changes, "in any reasonable manner based on the medium": the load keeps a subset (some kinds of place, a neighbour's places near the border) without changing a record; the data-sources entry says which countries, and `docs/maps.md` § Gazetteer what is kept. **Assessment: met** (medium-high confidence; it is the same licence and credit as the South Africa load, which § 2's reviewer didn't examine but which needs no Terms change, since CC BY imposes no end-user restriction to pass on).

### 3.3b The Southwestern Cape MAP surface (WAAS): the operator's decision (added 2026-10-23)

Not part of the question above, recorded here so this page covers every licensor whose data the map serves (issue #560).

- **What is used.** The mean annual rainfall surface for the Southwestern Cape (about 100 m), received from the client: the Map tab's MAP grid layer draws it, and *MAP from the grid* proposes each unit's mean annual precipitation from it (`docs/maps.md` § MAP grid, § MAP for each unit). In production it is loaded clipped to the client's area (`--bbox`), stored as dataset `WAAS-SWCape-2007` in `rain_map_cell_reference`.
- **The attribution** (the operator, 2026-10-23): "Mean annual rainfall surface for the Southwestern Cape. Prepared for the WAAS project by Beuster Clarke & Associates. March 2007, Version 1.1." It is stored as the grid's source and attribution by the production loader whatever the file says (`backend/src/geo/referenceLoad.ts`), shown with the layer, on the map's attribution control while the grid's points are drawn, and on `/data-sources#waas-map`.
- **The licence: terms not stated.** The copy received has an ESRI `metadata.xml` whose access and use constraints are still the ArcGIS template text ("REQUIRED: Restrictions and legal prerequisites…"), so no terms came with it. The operator first described the licence as "open source" (2026-10-23), which names no licence. WAAS was a Department of Water Affairs and Forestry (now DWS) study, so the rights most likely sit with the department; no written terms or permission from DWS, the consultant or the client are on record.
- **The decision.** The operator, 2026-10-23: "Don't worry about the license. Just use it." The operator accepts the licence question and its risk; this is an operator's decision, not a finding that the use is licensed. Built on it (issue #560): the production loader allows this one surface by label, with its credit; the Lynch (2004) national grid and every other surface stay blocked (`docs/maps.md` § Sources).
- **What limits the exposure.** The load is clipped to the client's area, so the service shows only the part of the surface the client's own study area needs, to signed-in users of projects (never on a public page); the credit names the authors and the study wherever the grid is drawn; a unit's MAP taken from it is a derived value that cites the grid in its source line (`docs/maps.md` § MAP for each unit). Unit MAPs typed in by hand that cite WAAS were never affected by the block.
- **If the owner objects.** Remove the label from `REFERENCE_KINDS` and the release gate's `DATASETS` (no new load), and delete the loaded dataset with a forward migration (`DELETE FROM rain_map_dataset WHERE dataset = 'WAAS-SWCape-2007'`; its cells go with it). Unit MAPs already accepted are copies in the projects and stay, citing the grid.
- **Confidence:** none to state on the licence itself: there are no terms to read. Written terms or permission from DWS (or the client's written basis for use) would settle it; record them here with the date if they arrive.

### 3.4 South African law (enforceability of the end-user terms)

- The licence needs a "written license agreement" with End Users. Click-wrap acceptance at sign-up or invitation is a contract concluded by data message. ECTA (Act 25 of 2002) s22(1) gives such agreements force, and s12 treats a data message as satisfying "writing". These are cited from memory and weren't re-read this session.
- The licence itself is governed by DC law, where click-wrap is routinely enforced (US E-SIGN/UETA). **Counsel should confirm** that a click-wrap Terms page is the "written license agreement" §1.2 contemplates.
- A clause that excludes a non-party's (WWF's) liability works under SA law, at best, as a stipulatio alteri the third party must accept, or as an acknowledgement. CPA s48/s51 fairness also applies to any widened indemnity, the same open item as `legal-status.md`'s CPA list.

## 4. Application

### 4.1 Is the clause "at least as protective"?

| Licence term | Terms §9 clause | Assessment |
| --- | --- | --- |
| §2.1.2 no stand-alone product | "may not copy, extract or distribute that data on its own, as a stand-alone dataset" | **Met.** |
| §2.1.3 no decompile / reverse engineer / disassemble, "include such restrictions" | "may not decompile, reverse engineer or disassemble it" | **Met**, word for word. |
| §1.2 "for such party's use and not for redistribution" | Use "as part of your projects and the results, reports and maps you make" | **Partly.** A map or report image is a Derivative Work, so that's fine. But the **GeoJSON export hands over HydroRIVERS vector geometry** in a portable file. The clause bans that only "on its own", which a user could argue a mixed project file isn't. |
| §3 ownership | "remains the property of its licensors" | **Met.** |
| §4.1 as is, with all faults, entire risk on the user | "as it is, without any warranty" | **Thinner.** No "with all faults", no "entire risk", no named fitness or non-infringement disclaimer. §12 of the Terms covers *our* warranties, not the licensors'. |
| §4.2 no representations on WWF's behalf | Nothing contrary. §12 disclaims. | **Met** in substance. |
| §5.2 operator indemnifies WWF for End Users' use | §14 indemnifies only Jared Howard, though it covers claims from "your breach of these terms". | **Gap in the operator's own protection**, not strictly in "protection of the Licensed Materials". The operator carries the §5.2 exposure unbacked. |
| §6 no indirect or consequential damages | "are not liable for your use of it" | **Roughly met**, but enforceability against users is uncertain (§3.4). |
| §7 termination | Terms §9 says third-party availability isn't ours to control. | **Adequate.** An explicit right to withdraw the data would help. |
| §10.8 export control | Terms §17 | **Met.** |
| §2.1.3 second sentence, protect against copying | Acceptable use §7 bans scraping. Data is served only to signed-in project members. | **Met** operationally. |
| §10.7 records of End Users' identity and address | Not a Terms point | **Operator duty, outside the question.** The app keeps accounts and emails, not addresses. Flag for counsel together with POPIA. |

**Position.** The clause does what §2.1.2 and §2.1.3 *name*. Whether it is "at least as protective … as are the terms of this License" depends on reading that phrase as the restrictions protecting the *materials* (more likely, and met apart from the export point) or as every protective term including disclaimers and indemnity (not fully met). The more likely view is the narrower one. That's because §2.1.2 speaks of protecting "the Licensed Materials", and the indemnity protects WWF, not the materials. Even on that view, the GeoJSON export is the one place where the clause's "on its own" wording leaves room for argument.

### 4.2 The credit gap

- **The gap still exists.** `farms/view.ts` sends only `credit: 'hydrorivers'`, so a JRC-traced dam on the farm map carries no credit. The on-map attribution control is expanded (`compact: false`) on a 280 px map.
- **HydroSHEDS Exhibit B: no breach.** The required statement is in "documentation or metadata". `/data-sources#hydrorivers` carries it, and the on-map credit links there. Covering a fifth of the map is a usability matter. The licence would be equally satisfied by a credit line next to the map.
- **JRC/Copernicus: a minor shortfall.**
  - The traced polygon is data adapted from GSW. It is shown to farmers and the WUA, a closed invited group. That is arguably not communication "to the public" (Art. 8(1)), and arguably not "a published map".
  - But JRC's "must include proper acknowledgement" for "data products that make use of these datasets" is broader. The farm view gives no source and no "modified" note (Art. 8(3)). The Map tab does both, but only in the selected feature's description.
  - Enforcement risk is very low: the data is free, and the EU and JRC don't enforce credits. The fix costs little and makes the question moot.

## 5. Recommendation

### 5.1 Terms §9: replace the clause

Pre-counsel draft. It needs a `LEGAL_VERSION` bump (new duties), its "what changed" line through the i18n pipeline, and the rivers load gate's text check (`scripts/release/map-data-gates.mjs`) updated to match.

> **Map data licensed to us.** Some of the map data the service shows is licensed to us by others, such as the HydroRIVERS river network from WWF's HydroSHEDS database. We let you use it only for your own use within the service, and as part of your projects and the results, reports and maps you make with it, and not for resale or redistribution. You may not copy, extract or distribute that data, in whole or in part, on its own or as a dataset or product of its own, and you may not decompile, reverse engineer or disassemble it, unless its licensor agrees in writing. A project download can include rivers or outlines you added from it, with their credit: keep that credit with them, and don't use a download to pass the data on separately. The data remains the property of its licensors. They provide it "as is" and with all faults, without any warranty, express or implied (including of accuracy, fitness for a particular purpose or non-infringement), and the whole risk of using it is yours. To the fullest extent the law allows, they are not liable to you for any loss arising from it, including indirect or consequential loss. Nothing we say is a promise made for them. We may stop offering any of it at any time, for example if our licence ends. The [data sources](/data-sources) page lists each source, its licence and its credit.

Then **§14**: add, at the end of the first sentence's list: "… or your breach of section 9's terms for map data licensed to us (including claims its licensors bring against us)."

This is narrow on purpose. A general indemnity running to WWF would draw CPA s48/s51 scrutiny for consumer farmers.

### 5.2 The durable fix for (a): ask WWF

Email the HydroSHEDS team (contact on hydrosheds.org) with three questions:
1. Does the click-wrap Terms §9 satisfy §2.1.2/§2.1.3?
2. Is a per-project GeoJSON export of the reaches a user added, with the Exhibit B credit, a permitted Derivative Work rather than redistribution?
3. Is the §10.7 record of End User "address" satisfied by account emails?

A written yes is the licensor's own "prior written consent" (§2.1.3). It makes the "at least as protective" reading academic. Keep the reply with the licence records (`docs/maps.md` § Sources).

### 5.3 Code: the credits (closes item (b))

> Built in #523 C6 (2026-10-12), with these differences. The flag is read from the description, because a traced feature stores no structured `traced` property. It goes on any feature whose description names the source, not only a dam, since a traced outline whose kind is changed later is still JRC's data. A traced dam split in two keeps the credit on both parts. `CatchmentMap` takes `attribution="outside"`. The farm card builds the line itself from `mapCredits` (`farm/farmMap.ts` `farmMapCredits`). The farm line translates only "Dam outline: traced from …, modified" and "Data sources". The HydroRIVERS and basemap credits stay as written.

1. **Backend, `backend/src/farms/view.ts`.**
   - Widen `FarmMapFeature.credit` to `'hydrorivers' | 'jrc-water'`.
   - In `farmMap()`, select `properties ->> 'description'`. Better: read the structured `traced` property if one is stored (`docs/maps.md` l.474: "saves it … with `traced`").
   - Set `credit: 'jrc-water'` on a `dam` traced from GSW.
   - Send only the flag, never the description, so nothing else leaks. Add a DB test beside the existing farm-map test.
2. **Frontend, the shared map.**
   - In `frontend/src/lib/components/map/mapLayers.ts`, add `jrcCreditedFeature` (true for `properties.credit === 'jrc-water'`, or a description containing `JRC_WATER_STATEMENT`).
   - In `CatchmentMap.svelte`, generalise `riversCreditHtml` / `syncRiversCredit` to a list of credits.
   - While a traced dam is drawn, add "Dam outline: traced from JRC Global Surface Water (Source: EC JRC/Google), modified", linking to `/data-sources#jrc-water`. This satisfies Art. 8(1) and 8(3) on the Map tab too, not just in the side panel.
3. **Farm view, phone width: credits next to the map, not over it.**
   - Give `CatchmentMap` an option to put credits outside the map (e.g. `credits="below"`: no on-map `AttributionControl`; it exposes the credit list).
   - `FarmMapCanvas.svelte` renders it as one small line under the legend: "© Protomaps © OpenStreetMap contributors · Rivers: HydroRIVERS … · Dam outline: … Source: EC JRC/Google · Data sources".
   - The OSM guidelines expressly allow adjacent placement, and Exhibit B is unaffected. This frees the fifth of the map without hiding anything.
   - Farmer-facing words ("Dam outline", "traced", "modified", "Data sources") go through `t()` and the i18n agents. The credit names themselves stay as written.
   - Alternative: `compact: true` (collapses on interaction, per OSM guidance). It's weaker because the credit hides after a pan. Prefer the line below.
4. **Tests and docs.**
   - Unit: farmMap/credits. DB: the farm-map route.
   - e2e: farm view with a traced dam shows the JRC line, and the map has no overlaid attribution at 360 px.
   - Update `docs/maps.md` § Download GeoJSON / § Sources and `docs/ui.md`.
   - Correct the issue #90 item: "not code" is wrong; this is code.

## 6. Residual risk

- **Clause sufficiency.** Without WWF's written confirmation, "at least as protective" stays an interpretation of a DC-law contract. Moderate legal ambiguity; low practical risk, since WWF is a nonprofit, the data is free and the credit is prominent.
- **The operator's §5.2 indemnity to WWF** is uncapped and can't be removed by the Terms. The §14 change only lets the operator pass it on to a user who breached §9. Consider whether E&O insurance (already on the legal-status list) covers it.
- **Afrikaans-reading farmers** see HydroRIVERS rivers on the farm map under English-only Terms. Whether §9 binds them is the existing open counsel item.
- **Copernicus 1159/2013's current status** is unverified, though the fix in §5.3 meets it either way.
- **Before a paying client goes live:** a practising South African attorney should confirm:
  - that click-wrap acceptance creates a "written license agreement" enforceable against SA users (ECTA);
  - the third-party liability exclusion's effect;
  - the §14 addition under the CPA.

  The credit fix needs no attorney.

## 7. Sources

- HydroSHEDS Technical Documentation v1.4, Appendix A (licence) and Exhibits A-B: https://data.hydrosheds.org/file/technical-documentation/HydroSHEDS_TechDoc_v1_4.pdf (read in full, 2026-10-11)
- HydroRIVERS product page (licence pointer): https://www.hydrosheds.org/products/hydrorivers
- HydroSHEDS website terms of use (website only): https://www.hydrosheds.org/terms-of-use
- JRC Global Surface Water download page: https://global-surface-water.appspot.com/download
- Google Earth Engine catalogue, JRC GSW v1.4 terms: https://developers.google.com/earth-engine/datasets/catalog/JRC_GSW1_4_GlobalSurfaceWater
- Commission Delegated Regulation (EU) 1159/2013, Arts 3, 4, 8 (legislation.gov.uk copy; EUR-Lex was unreadable): https://www.legislation.gov.uk/eur/2013/1159/article/8 ; EU version: https://eur-lex.europa.eu/eli/reg_del/2013/1159/oj/eng
- Copernicus Land data policy (secondary, currency of 1159/2013): https://land.copernicus.eu/en/data-policy
- GeoNames dump licence (`readme.txt`, identical in the ZA, BW, LS, MZ, NA, SZ and ZW dumps; read 2026-10-13): https://download.geonames.org/export/dump/readme.txt
- OSMF Licence/Attribution Guidelines: https://osmfoundation.org/wiki/Licence/Attribution_Guidelines
- ECTA, Act 25 of 2002 (s12, s22; cited from memory, not re-read): https://www.gov.za/documents/electronic-communications-and-transactions-act
- Repo: `frontend/src/routes/terms/+page.svelte`; `docs/legal-status.md`; `docs/maps.md`; `backend/src/farms/view.ts`; `frontend/src/lib/components/{map/CatchmentMap.svelte,map/mapLayers.ts,map/mapExport.ts,farm/FarmMapCanvas.svelte,farm/farmMap.ts,legal/dataCredits.ts}`; PR #369 body.
