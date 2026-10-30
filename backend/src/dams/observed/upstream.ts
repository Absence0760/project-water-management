// Digital Earth Africa's hosts the dam observations read over HTTPS (issue
// #604 R5; docs/data-sources.md): their public bucket, for the WOfS scenes
// (R5-C), and for Waterbodies (waterbodies.ts) their Waterbodies API (the
// per-waterbody series, by integer wb_id) and their GeoServer's WFS (a uid's
// wb_id). Anonymous, CC BY 4.0. Sentinel-2 and Sentinel-1 (issue #624) come
// from their own buckets and carry Copernicus's credit too. feeds/http.ts
// FEED_HOSTS lets a live fetch reach these hosts and no other of theirs, and
// FEED_HOST_PATHS keeps the API and GeoServer hosts to the paths below.
export const DEAFRICA_SERVICES_BASE = 'https://deafrica-services.s3.af-south-1.amazonaws.com/';
/** The Waterbodies API (v0.0.3; DE Africa's supported way to the series since v0.0.3, kept current within about a week). */
export const DEAFRICA_WATERBODIES_API = 'https://api.digitalearth.africa/waterbodies/';
/** DE Africa's GeoServer WFS endpoint: the v0.0.3 polygons' uid → wb_id. */
export const DEAFRICA_GEOSERVER_WFS = 'https://geoserver.digitalearth.africa/geoserver/wfs';

/** The attribution shown wherever their values show (CC BY 4.0). */
export const DEAFRICA_ATTRIBUTION = 'Digital Earth Africa, CC BY 4.0';

/**
 * The Copernicus credit for Sentinel-2 and Sentinel-1 values (issue #624; docs/data-sources.md
 * deafrica-sentinel-2-c1), and the credit for views on given dates: the engine's, the one definition the evidence
 * report's § 7 prints too. Its leaf module has no imports, so the fetcher's bundle carries those few lines and none
 * of the engine.
 */
export { SENTINEL_CITATION as SENTINEL_ATTRIBUTION, sentinelCitation as sentinelCredit } from '@water-management/engine/sentinel-credit';

/** Whether a source's values are Copernicus Sentinel data, and carry SENTINEL_ATTRIBUTION. */
export const isSentinel = (source: string) => source === 's2' || source === 's1';
