// FEED_SOURCE=fixtures: FAO's WaPOR v3 dekadal actual ET answered from a
// synthetic description (backend/fixtures/feeds/wapor-sample.json), never the
// network, so the ET pass runs in dev, CI and e2e offline. The feeds' fixture
// client (feeds/fixtures.ts) hands the WaPOR URLs here.
//
// The invented world: one grid laid out like FAO's file (EPSG:4326 at
// 1/1024°, 512-pixel tiles, int16 × 0.1 mm/day, GDAL's band scale, nodata
// −9999, BigTIFF, LZW: wapor.ts), its tile tables as long as a continental
// grid's, but data only in the tiles that meet `cover` (the seeded examples'
// synthetic catchments, backend/scripts/examples/), every other tile empty
// (all nodata). A dekad is served from historyDekads back to the last one
// whose end is lagDays before today, 404 otherwise, as FAO publishes about
// three days after a dekad ends. ETa follows the seasons (highest in
// January, the southern summer) times a smooth invented field; every
// everyNthDekad a band of cloud (nodata) crosses the tiles, so a unit's
// valid share drops below 1. Files are made with raster/cogWrite.ts, so the
// fixture exercises the production reader. No real value or place.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toEpochDay } from '@water-management/engine/calendar';
import { writeCog } from '../../raster/cogWrite.js';
import { WAPOR_AETI_D_PATH, WAPOR_BASE } from './upstream.js';
import { dekadEnd, dekadOf, dekadOfFileName, previousDekad, WAPOR_SCALE } from './wapor.js';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/feeds/wapor-sample.json', import.meta.url));

export interface WaporFixtureSpec {
	grid: { originLon: number; originLat: number; widthDeg: number; heightDeg: number; pixelsPerDeg: number; tile: number };
	/** [west, south, east, north] boxes: the tiles that meet one hold data. */
	cover: [number, number, number, number][];
	schedule: { historyDekads: number; lagDays: number };
	eta: { mean: number; amplitude: number; peakDayOfYear: number; wavelengthDeg: [number, number]; spatial: number };
	cloud: { everyNthDekad: number; bandPx: number };
}

export const loadWaporFixture = (): WaporFixtureSpec => JSON.parse(readFileSync(FIXTURE, 'utf8')) as WaporFixtureSpec;

const NODATA = -9999;
const PREFIX = `${WAPOR_BASE}${WAPOR_AETI_D_PATH}`;

/** The dekads the fixture serves on `today`, oldest first. */
export function waporFixtureDekads(spec: WaporFixtureSpec, today: string): string[] {
	const out: string[] = [];
	const lastEnd = toEpochDay(today) - spec.schedule.lagDays;
	// The newest served dekad: the last one ended lagDays or more before today.
	let d = dekadOf(today);
	for (let i = 0; i < 4 && toEpochDay(dekadEnd(d)) > lastEnd; i++) d = previousDekad(d);
	for (let i = 0; i < spec.schedule.historyDekads; i++, d = previousDekad(d)) out.push(d);
	return out.reverse();
}

/** What the fixture's ETa needs of a dekad, worked out once for all its pixels: whether it is a cloudy one, and its season. */
function waporFixtureDekad(spec: WaporFixtureSpec, dekad: string): { cloudy: boolean; season: number } {
	const day = toEpochDay(dekad);
	const index = Math.round(day / 10);
	const { mean, amplitude, peakDayOfYear } = spec.eta;
	const doy = day - toEpochDay(`${dekad.slice(0, 4)}-01-01`) + 5;
	return {
		cloudy: spec.cloud.everyNthDekad > 0 && index % spec.cloud.everyNthDekad === 0,
		season: mean + amplitude * Math.cos((2 * Math.PI * (doy - peakDayOfYear)) / 365.25)
	};
}

function waporFixturePixel(spec: WaporFixtureSpec, at: { cloudy: boolean; season: number }, lon: number, lat: number, col: number): number | null {
	if (at.cloudy && col % (spec.cloud.bandPx * 4) < spec.cloud.bandPx) return null;
	const { wavelengthDeg, spatial } = spec.eta;
	const field = 1 + spatial * (0.5 * Math.sin((2 * Math.PI * lon) / wavelengthDeg[0]) + 0.5 * Math.cos((2 * Math.PI * lat) / wavelengthDeg[1]));
	return Math.max(0, at.season * field);
}

/** The fixture's ETa (mm/day) at a pixel centre on a dekad, or null for cloud (nodata). */
export function waporFixtureValue(spec: WaporFixtureSpec, dekad: string, lon: number, lat: number, col: number): number | null {
	return waporFixturePixel(spec, waporFixtureDekad(spec, dekad), lon, lat, col);
}

export function waporFixture(today: () => string, spec: WaporFixtureSpec = loadWaporFixture()) {
	const { originLon, originLat, widthDeg, heightDeg, pixelsPerDeg, tile } = spec.grid;
	const width = Math.round(widthDeg * pixelsPerDeg);
	const height = Math.round(heightDeg * pixelsPerDeg);
	const across = Math.ceil(width / tile);
	const px = 1 / pixelsPerDeg;
	const tileDeg = tile * px;
	/** The tiles (row-major indices) that hold data. */
	const covered = new Set<number>();
	for (const [w, s, e, n] of spec.cover) {
		for (let tr = Math.max(0, Math.floor((originLat - n) / tileDeg)); tr <= Math.floor((originLat - s) / tileDeg - 1e-9); tr++) {
			for (let tc = Math.max(0, Math.floor((w - originLon) / tileDeg)); tc <= Math.floor((e - originLon) / tileDeg - 1e-9); tc++) covered.add(tr * across + tc);
		}
	}
	const cache = new Map<string, Uint8Array>();

	const make = (dekad: string): Uint8Array => {
		const at = waporFixtureDekad(spec, dekad);
		return writeCog({
			width,
			height,
			sampleType: 'int16',
			tileValues: (i) => {
				if (!covered.has(i)) return null;
				const tr = Math.floor(i / across);
				const tc = i % across;
				const t = new Int16Array(tile * tile);
				for (let r = 0; r < tile; r++) {
					const lat = originLat - (tr * tile + r + 0.5) * px;
					for (let c = 0; c < tile; c++) {
						const col = tc * tile + c;
						const v = waporFixturePixel(spec, at, originLon + (col + 0.5) * px, lat, col);
						t[r * tile + c] = v === null ? NODATA : Math.min(32767, Math.round(v / WAPOR_SCALE));
					}
				}
				return t;
			},
			epsg: 4326,
			originX: originLon,
			originY: originLat,
			pixelSize: px,
			tile,
			compression: 5,
			nodata: String(NODATA),
			bigTiff: true,
			// GDAL's COG layout: the small values in the header's first read, the long tile tables after them.
			tableGap: 0,
			scaleOffset: { scale: WAPOR_SCALE, offset: 0 }
		});
	};

	return {
		/** The file at a WaPOR URL, or null (a 404) for any other URL or a dekad not served. */
		file(url: string): Uint8Array | null {
			if (!url.startsWith(PREFIX)) return null;
			const dekad = dekadOfFileName(url.slice(PREFIX.length));
			if (!dekad || !waporFixtureDekads(spec, today()).includes(dekad)) return null;
			let bytes = cache.get(dekad);
			if (!bytes) {
				bytes = make(dekad);
				if (cache.size >= 6) cache.clear();
				cache.set(dekad, bytes);
			}
			return bytes;
		}
	};
}
