# DWS evaporation records: the permission request

A draft for the operator to send **through the client's hydrologist**, as the
flow request was (issue #646 items 6 and 7; data-sources.md §
[dws-evaporation](../data-sources.md#dws-evaporation); followups.md,
*Decision: DWS evaporation station records*). Nothing here has been sent. The
repo is public, so the draft names no client, catchment or station: fill the
bracketed parts in from the client's records, and keep the sent letter and
DWS's reply with the client's records, not here.

## Why one request covers two items

- **Item 6, the nearest evaporation station.** The Calibration page proposes
  a nearby DWS station's pan record as the A-pan row
  ([maps.md § Evaporation stations](../maps.md#evaporation-stations)).
  Production refuses the load until DWS's permission covers evaporation
  records.
- **Item 7, the PenPan grid.** The modelled Class-A pan grid must be
  validated against measured Class-A pans before the hydrologist can sign it
  off (`ingest/apan_grid.py validate`, data-sources.md §
  [penpan-apan](../data-sources.md#penpan-apan)). Those pans are the same
  DWS records.

So the request asks for both uses: the stations near the catchment for the
A-pan, and the Class-A stations across the region for the validation.

## What the permission must cover

Word it as an extension of the flow permission recorded on 2026-10-28
(data-sources.md § [dws-flow](../data-sources.md#dws-flow)), on the same
terms:

1. **Storing** DWS's verified daily pan evaporation (Class-A and Symons pans)
   for the stations listed, in the tool's own database.
2. **Showing results derived from it** in the tool: 12 monthly means as a
   project's A-pan row, a Class-A pan's daily record as a project's daily
   A-pan series, and a Symons pan converted to A-pan with a published
   equation the user picks and the tool cites.
3. **Validating a modelled pan grid** against the Class-A records, and
   reporting the comparison's statistics (bias and error by station and
   month) to the client's hydrologist.
4. **Never selling or redistributing the raw values.** The tool shows each
   station's monthly means and record span, and cites DWS as the copyright
   owner in every revision that uses a station.

## The email

> **To:** GeoRequests@dws.gov.za
> **Subject:** Request: verified daily pan evaporation records, extension of
> data permission [DWS reference of the flow permission]
>
> Dear National Hydrological Services,
>
> On [date of the flow permission] you allowed [client organisation] to
> store DWS verified daily flow for the stations in [catchment / quaternary
> catchments], and to show results derived from it in the water balance
> tool we use for [purpose: e.g. the catchment's water-use planning]
> (your reference [reference]).
>
> We ask to extend that permission, on the same terms, to the verified daily
> **pan evaporation** of DWS weather stations:
>
> 1. For the A-pan evaporation of the catchment: the evaporation stations
>    within about 100 km of [catchment / quaternary catchments], Class-A and
>    Symons pans: [station codes from the WMA station list, or "the
>    stations you consider suitable"].
> 2. To check a modelled Class-A pan estimate against measurements: the
>    Class-A pan stations in [water management areas / drainage regions]
>    with at least 10 years of record.
>
> The records would be stored in the tool's own database, used for the
> catchment's evaporation inputs and to report how well the modelled
> estimate agrees with your stations. The raw values would not be sold or
> passed on; DWS would be cited as the copyright owner wherever a station's
> values are used.
>
> Please could you also send the current station lists for those areas
> (the `WMA*_Met.pdf` lists with each station's pan type), and the full
> daily record for each station, in the usual Hydstra export.
>
> Kind regards,
> [hydrologist's name, registration], on behalf of [client organisation]

## When DWS answers

- **Yes:** the operator records the permission (date, DWS reference, the
  terms in a sentence) in data-sources.md § dws-evaporation and the
  maps.md Sources row, keeping the letter with the client's records. Then
  follow followups.md, *Decision: DWS evaporation station records*: check
  the reader (`backend/src/geo/dwsEvaporation.ts`) against a real reply
  first, then open the gate (`scripts/release/map-data-gates.mjs`
  `LOADABLE`, `geo/referenceLoad.ts`, `load-reference.yml`). Run
  `apan_grid.py validate` on the Class-A records and send the report to the
  hydrologist for item 7's sign-off.
- **Yes, for some uses only** (for example storing but not showing): record
  exactly what is allowed, and keep blocked whatever isn't.
- **No, or no answer:** both stay blocked in production. The A-pan row is
  still typed or taken from the WR2012 tables, and step 4's "A-pan not set"
  status says so when it isn't.
