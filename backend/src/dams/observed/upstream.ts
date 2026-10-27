// Digital Earth Africa's public bucket, which both dam observation sources
// read over HTTPS (issue #604 R5; docs/data-sources.md, Digital Earth Africa
// Waterbodies): the Waterbodies time series (waterbodies.ts) and the WOfS
// scenes (R5-C). Anonymous reads, CC BY 4.0. feeds/http.ts FEED_HOSTS lets a
// live fetch reach this host and no other of theirs.
export const DEAFRICA_SERVICES_BASE = 'https://deafrica-services.s3.af-south-1.amazonaws.com/';

/** The attribution shown wherever their values show (CC BY 4.0). */
export const DEAFRICA_ATTRIBUTION = 'Digital Earth Africa, CC BY 4.0';
