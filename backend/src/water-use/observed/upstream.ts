// The two actual evapotranspiration (ETa) sources a unit's observed water use
// is checked against (issue #623; docs/data-sources.md, wapor-aeti and
// ssebop-eta). The fetcher's `et-dekadal` mode reads WaPOR (pass.ts);
// SSEBop has no pass yet (#623 step 6, only if FAO declines). feeds/http.ts
// FEED_HOSTS lets a live fetch reach their hosts, and FEED_HOST_PATHS keeps
// it to these two prefixes there.

/**
 * FAO's own public bucket of WaPOR v3, over HTTPS: the dekadal actual ET and
 * interception, `DATA/WAPOR-3/MAPSET/L2-AETI-D/WAPOR-3.L2-AETI-D.<YYYY-MM-Dn>.tif`
 * (100 m, from 2018). The host is Google Cloud Storage's, shared by every
 * bucket on it, so the live client may ask only paths under this bucket.
 */
export const WAPOR_BASE = 'https://storage.googleapis.com/fao-gismgr-wapor-3-data/';

/** The dekadal L2 AETI mapset under WAPOR_BASE. */
export const WAPOR_AETI_D_PATH = 'DATA/WAPOR-3/MAPSET/L2-AETI-D/';

/**
 * USGS FEWS NET's SSEBop v6.1 global dekadal ETa (1 km, from 2012),
 * `d<YYYYMMD>.zip` each holding one GeoTIFF. The fallback, used only if FAO
 * declines or as a second opinion; the live client may ask only this tree.
 */
export const SSEBOP_BASE = 'https://edcintl.cr.usgs.gov/downloads/sciweb1/shared/fews/web/global/dekadal/etav61/';

/** Shown wherever a WaPOR value shows (FAO's terms, Annex 1: CC BY 4.0). */
export const WAPOR_ATTRIBUTION = 'FAO WaPOR v3, CC BY 4.0';

/** Shown wherever an SSEBop value shows (CC0; credit asked, not required). */
export const SSEBOP_ATTRIBUTION = 'USGS FEWS NET SSEBop v6, CC0';
