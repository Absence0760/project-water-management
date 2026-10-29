// What a WaPOR v3 L2-AETI-D file is, and one unit's mean actual ET from it
// (issue #623 step 4; docs/architecture.md § Observed actual ET,
// docs/data-sources.md wapor-aeti).
//
// The file (FAO's public bucket, upstream.ts WAPOR_BASE): one BigTIFF COG
// per dekad, `WAPOR-3.L2-AETI-D.<YYYY-MM>-D<n>.tif`, n 1–3 (the 1st–10th,
// 11th–20th, 21st to the month's end), EPSG:4326 at 1/1024°, 512-pixel
// tiles, LZW, one int16 band, nodata −9999, the values × 0.1 mm/day (GDAL's
// band scale, which the reader must find: a file without it, or with another
// scale or an offset, is refused, since its samples would not be what we
// think). raster/cog.ts reads it (WAPOR_ACCEPT): the header, then the slice
// of the tile tables and the tiles under a unit's parcels, never the file.
//
// A unit's mean (unitMean): the pixels whose centres fall inside its parcels
// (raster/mask.ts, the parcels as one MultiPolygon, so a pixel two parcels
// share counts once), each weighted by the cropland share of the land-cover
// cell its centre is in, when the worker handed the land cover over
// (`mask: 'cropland'`: the parcels ∩ cropland, assuming the cropland is
// spread evenly within each ~250 m cell, as geo/cropland.ts does). Where no
// land cover is loaded, or it maps no cropland under the parcels, every
// pixel weighs 1 (`mask: 'parcel'`: the whole parcels, veld and buildings
// included, and labelled so). Then
//
//   area_m2      = Σ weights × the pixel's ground area (mask.ts, on the ellipsoid)
//   valid_share  = Σ weights of valid pixels ÷ Σ weights
//   eta_mm_day   = Σ weight × ETa over valid pixels ÷ Σ weights of valid pixels (0 when none is valid)
//
// A valid pixel is one that isn't nodata and whose value is 0 to 50 mm/day:
// anything else isn't a plausible actual ET and isn't averaged in.
import type { CogAccept, CogInfo, PixelWindow } from '../../raster/cog.js';
import { isNodata } from '../../raster/cog.js';
import type { OutlineMask } from '../../raster/mask.js';
import type { WantedCropland } from './handover.js';
import { WAPOR_AETI_D_PATH, WAPOR_BASE } from './upstream.js';

/** The product version stored with each row (et_observation.upstream_version). */
export const WAPOR_VERSION = 'WAPOR-3';
/** WaPOR v3's dekadal record starts here. */
export const WAPOR_FIRST_DEKAD = '2018-01-01';
/** The band scale the files carry: a sample × 0.1 is mm/day. */
export const WAPOR_SCALE = 0.1;
/** What a WaPOR v3 dekad is (raster/cog.ts's header): one int16 band on EPSG:4326, with GDAL's band scale. */
export const WAPOR_ACCEPT: CogAccept = { sampleTypes: ['int16'], crs: ['geographic'], scaleOffset: true };
/** The highest plausible actual ET, mm/day (277's bound on a mean). */
export const MAX_ETA_MM_DAY = 50;

// --- Dekads ---------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0');
/** The first day of the dekad `iso` falls in. */
export function dekadOf(iso: string): string {
	const d = Number(iso.slice(8, 10));
	return `${iso.slice(0, 8)}${d <= 10 ? '01' : d <= 20 ? '11' : '21'}`;
}
/** The dekad after `dekad` (a first day). */
export function nextDekad(dekad: string): string {
	const d = dekad.slice(8);
	if (d === '01') return `${dekad.slice(0, 8)}11`;
	if (d === '11') return `${dekad.slice(0, 8)}21`;
	const y = Number(dekad.slice(0, 4));
	const m = Number(dekad.slice(5, 7));
	return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}
/** The dekad before `dekad` (a first day). */
export function previousDekad(dekad: string): string {
	const d = dekad.slice(8);
	if (d === '21') return `${dekad.slice(0, 8)}11`;
	if (d === '11') return `${dekad.slice(0, 8)}01`;
	return dekadOf(new Date(Date.parse(`${dekad}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10));
}
/** The dekad's last day. */
export function dekadEnd(dekad: string): string {
	const d = dekad.slice(8);
	if (d !== '21') return `${dekad.slice(0, 8)}${d === '01' ? '10' : '20'}`;
	return new Date(Date.parse(`${nextDekad(dekad)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}
/** Every dekad from `first` to the last one that has ended before `today`, newest first. */
export function endedDekads(first: string, today: string): string[] {
	const out: string[] = [];
	for (let d = dekadOf(first); dekadEnd(d) < today; d = nextDekad(d)) out.push(d);
	return out.reverse();
}

/** The file's name for a dekad: WAPOR-3.L2-AETI-D.2024-01-D2.tif for 2024-01-11. */
export function waporFileName(dekad: string): string {
	const n = dekad.slice(8) === '01' ? 1 : dekad.slice(8) === '11' ? 2 : 3;
	return `WAPOR-3.L2-AETI-D.${dekad.slice(0, 7)}-D${n}.tif`;
}
export const waporUrl = (dekad: string) => `${WAPOR_BASE}${WAPOR_AETI_D_PATH}${waporFileName(dekad)}`;
/** The dekad a file name is for, or null. */
export function dekadOfFileName(name: string): string | null {
	const m = /^WAPOR-3\.L2-AETI-D\.(\d{4})-(\d{2})-D([123])\.tif$/.exec(name);
	if (!m) return null;
	return `${m[1]}-${m[2]}-${m[3] === '1' ? '01' : m[3] === '2' ? '11' : '21'}`;
}

// --- One unit's mean ------------------------------------------------------------------
/** A unit's pixel weights on one grid: the mask's pixels, each weighted (1, or its cell's cropland share). */
export interface UnitWeights {
	mask: OutlineMask;
	/** Per mask pixel (row-major over the mask's window), 0 outside. */
	weights: Float64Array;
	total: number;
	label: 'cropland' | 'parcel';
}

/** The weights of a unit's mask on a grid (see the header). */
export function unitWeights(mask: OutlineMask, grid: Pick<CogInfo, 'originX' | 'originY' | 'pixelSizeX' | 'pixelSizeY'>, cropland: WantedCropland | undefined): UnitWeights {
	const n = mask.width * mask.height;
	const weights = new Float64Array(n);
	let total = 0;
	if (cropland && cropland.cells.length) {
		const share = new Map<string, number>(cropland.cells.map(([r, c, f]) => [`${r}:${c}`, f]));
		for (let r = 0; r < mask.height; r++) {
			const lat = grid.originY - (mask.row0 + r + 0.5) * grid.pixelSizeY;
			const row = Math.floor(lat / cropland.cellDeg);
			for (let c = 0; c < mask.width; c++) {
				const i = r * mask.width + c;
				if (!mask.mask[i]) continue;
				const lon = grid.originX + (mask.col0 + c + 0.5) * grid.pixelSizeX;
				const w = share.get(`${row}:${Math.floor(lon / cropland.cellDeg)}`) ?? 0;
				weights[i] = w;
				total += w;
			}
		}
		if (total > 0) return { mask, weights, total, label: 'cropland' };
		// The land cover maps no cropland under the parcels: the whole parcels, labelled.
		weights.fill(0);
		total = 0;
	}
	for (let i = 0; i < n; i++) {
		if (mask.mask[i]) {
			weights[i] = 1;
			total++;
		}
	}
	return { mask, weights, total, label: 'parcel' };
}

export interface UnitMean {
	etaMmDay: number;
	validShare: number;
	areaM2: number;
}

/**
 * The unit's mean from the samples over `win` (readWindow's, inside the
 * file), or null when no weighted pixel is inside (a parcel smaller than a
 * pixel, or cropland too thin to have an area). Pixels of the mask off the file count as not valid.
 */
export function unitMean(u: UnitWeights, win: PixelWindow | null, samples: ArrayLike<number> | null, cog: Pick<CogInfo, 'nodata' | 'scale' | 'offset'>): UnitMean | null {
	if (u.total <= 0) return null;
	const { mask } = u;
	let valid = 0;
	let sum = 0;
	if (win && samples) {
		const w = win.col1 - win.col0 + 1;
		for (let r = win.row0; r <= win.row1; r++) {
			const mr = r - mask.row0;
			for (let c = win.col0; c <= win.col1; c++) {
				const wt = u.weights[mr * mask.width + (c - mask.col0)]!;
				if (wt === 0) continue;
				const s = samples[(r - win.row0) * w + (c - win.col0)]!;
				if (isNodata(cog, s)) continue;
				const v = s * cog.scale + cog.offset;
				if (!(v >= 0 && v <= MAX_ETA_MM_DAY)) continue;
				valid += wt;
				sum += wt * v;
			}
		}
	}
	const eta = valid > 0 ? sum / valid : 0;
	const areaM2 = Math.round(u.total * mask.pixelAreaM2 * 100) / 100;
	if (!(areaM2 > 0)) return null;
	return {
		etaMmDay: Math.round(Math.min(MAX_ETA_MM_DAY, eta) * 1000) / 1000,
		validShare: Math.round(Math.min(1, valid / u.total) * 10_000) / 10_000,
		areaM2
	};
}
