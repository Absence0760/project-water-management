// The committed synthetic water occurrence raster tracing a dam runs against
// in e2e (WATER_URL in playwright.config.ts; the water is
// backend/src/delineation/waterFixture.ts): the points to click, as that
// module computes them. Kept in step by backend/src/delineation/damTrace.test.ts.
import { fileURLToPath } from 'node:url';

export const WATER_FIXTURE = fileURLToPath(new URL('../../backend/fixtures/water/synthetic-water.pmtiles', import.meta.url));
/** Inside the invented dam (in the e2e boundary, Upper farm's parcel). [lon, lat] */
export const WATER_DAM: [number, number] = [21.3191414, -33.6724971];
/** Dry land, away from any water. [lon, lat] */
export const WATER_DRY: [number, number] = [21.2903023, -33.595318];
