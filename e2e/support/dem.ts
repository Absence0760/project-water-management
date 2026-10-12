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
/** On the river between the dam and the outlet: a gauge there measures the dam's catchment and the land below it. [lon, lat] */
export const FIXTURE_MID_GAUGE: [number, number] = [20.7428741, -33.4938799];
/** Far up the river above the dam: an abstraction point there owns the valley's head. [lon, lat] */
export const FIXTURE_UPPER: [number, number] = [20.7428741, -33.3104464];
/** On the valley's side three cells (about 380 m) east of the mid gauge, as a displaced river line puts a click: on a small terrain channel beside a much larger one. [lon, lat] */
export const FIXTURE_OFF_CHANNEL: [number, number] = [20.746994, -33.4938799];
/** Just past the valley's western ridge, where nothing drains a square kilometre: no terrain channel within 150 m, so a click is refused (issue #472). [lon, lat] */
export const FIXTURE_OFF_TERRAIN: [number, number] = [20.6179047, -33.4022115];
/**
 * Two units drawn as their boundaries (start-16, #523 C1): the valley above the dam (to five rows below its wall, so the dam
 * point is inside it), and below it to the outlet (taking in the outlet's cell), each the ridge grown by two cells, coarsely.
 * fixture.ts valleyUnitRing(0, DAM_CELL.y + 5, 2, 10) and (DAM_CELL.y + 5, 400, 2, 10). [lon, lat] rings
 */
export const FIXTURE_UPPER_UNIT: [number, number][] = [[20.7428741,-33.2616568],[20.7929696,-33.2731391],[20.8121895,-33.28462],[20.8258512,-33.2960993],[20.8364224,-33.3075771],[20.8448686,-33.3190534],[20.8516857,-33.3305282],[20.8571657,-33.3420015],[20.861494,-33.3534733],[20.8647934,-33.3649436],[20.8671457,-33.3764124],[20.8686043,-33.3878796],[20.8691999,-33.3993453],[20.868945,-33.4108096],[20.8678342,-33.4222723],[20.8665358,-33.4302953],[20.6192125,-33.4302953],[20.6179141,-33.4222723],[20.6168033,-33.4108096],[20.6165484,-33.3993453],[20.617144,-33.3878796],[20.6186026,-33.3764124],[20.6209549,-33.3649436],[20.6242543,-33.3534733],[20.6285826,-33.3420015],[20.6340626,-33.3305282],[20.6408797,-33.3190534],[20.6493259,-33.3075771],[20.6598971,-33.2960993],[20.6735588,-33.28462],[20.6927787,-33.2731391],[20.7428741,-33.2616568]];
export const FIXTURE_LOWER_UNIT: [number, number][] = [[20.8665358,-33.4302953],[20.8639061,-33.4417554],[20.8603082,-33.453214],[20.8556496,-33.4646711],[20.8497916,-33.4761267],[20.8425231,-33.4875808],[20.8335051,-33.4990334],[20.822143,-33.5104844],[20.8072063,-33.5219339],[20.7850548,-33.533382],[20.7428741,-33.5413947],[20.7006934,-33.533382],[20.678542,-33.5219339],[20.6636053,-33.5104844],[20.6522432,-33.4990334],[20.6432252,-33.4875808],[20.6359566,-33.4761267],[20.6300987,-33.4646711],[20.6254401,-33.453214],[20.6218422,-33.4417554],[20.6192125,-33.4302953],[20.8665358,-33.4302953]];
