// The committed synthetic DEM delineation runs against in e2e (DEM_URL in
// playwright.config.ts; the terrain is backend/src/delineation/fixture.ts):
// the points to click, as that module computes them. Kept in step by
// backend/src/delineation/delineate.test.ts, which reads this file.
import { fileURLToPath } from 'node:url';

export const DEM_FIXTURE = fileURLToPath(new URL('../../backend/fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
/** The valley's outlet on its southern ridge: the catchment above it is about 547 km². [lon, lat] */
export const FIXTURE_OUTLET: [number, number] = [20.7428741, -33.5396777];
/** Just below the dam wall: less, about 341 km². [lon, lat] */
export const FIXTURE_DAM: [number, number] = [20.7428741, -33.4262838];
