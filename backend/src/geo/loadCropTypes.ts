// Pre-summarise a crop-type raster (SANLC) into the orchard and vine grid the
// app reads (259_crop_type_reference.sql; issue #604 R5-D, docs/maps.md
// § Orchards and vines from SANLC). The operator's tool, run as the schema
// owner (`pnpm import:crop-types`); the app never reads a raster, and this
// module is imported by backend/scripts/import-crop-types.ts and its tests
// only. The JSON form and the load are in cropTypeGrid.ts.
//
// Input: one classification GeoTIFF read by loadCropland.ts' reader (classic
// TIFF, 8-bit, one band, EPSG:4326; SANLC ships in Albers, so the operator
// warps it first: docs/maps.md gives the gdalwarp line), and optionally the
// earlier edition's, warped onto the same pixels. Each pixel is counted into
// the grid cell its centre falls in: per cell, the pixels in the orchard
// classes and in the vine classes over the pixels with data; with the
// earlier edition, the pixels in either now that were in neither then (new
// plantings). A pixel the earlier edition has no data for is never new.
import { eachBlock, gridFits, noDataOf, readTiffInfo, type Bbox, type TiffBlock, type TiffInfo } from './loadCropland.js';
import type { CropTypeCell } from './cropTypeGrid.js';

export interface CropTypeClasses {
	orchard: readonly number[];
	vine: readonly number[];
}

/** Whether two rasters cover the same pixels, block for block, or why not. */
function sameLayout(a: TiffInfo, b: TiffInfo): string | null {
	const keys = ['width', 'height', 'blockW', 'blockH'] as const;
	for (const k of keys) if (a[k] !== b[k]) return `the earlier edition's ${k} (${b[k]}) differs from the current one's (${a[k]}): warp both onto the same pixels`;
	const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;
	if (!near(a.west, b.west) || !near(a.north, b.north) || !near(a.pixelW, b.pixelW) || !near(a.pixelH, b.pixelH)) {
		return "the earlier edition's corner or pixel size differs from the current one's: warp both onto the same pixels";
	}
	return null;
}

/**
 * Count `current` (and `baseline`, the earlier edition on the same pixels)
 * into cells. Cells with neither orchard nor vine are left out, and with
 * `bbox`, cells whose centre is outside it.
 */
export function cropTypeCellsFromTiff(
	current: Buffer,
	baseline: Buffer | null,
	cellDeg: number,
	classes: CropTypeClasses,
	bbox?: Bbox
): { cells: CropTypeCell[]; pixels: number } | string {
	const info = readTiffInfo(current);
	if (typeof info === 'string') return info;
	const misfit = gridFits(info, cellDeg);
	if (misfit) return misfit;
	let baseInfo: TiffInfo | null = null;
	if (baseline) {
		const b = readTiffInfo(baseline);
		if (typeof b === 'string') return `the earlier edition: ${b}`;
		const differs = sameLayout(info, b);
		if (differs) return differs;
		baseInfo = b;
	}
	const per = Math.round(cellDeg / info.pixelW);
	const nCols = Math.ceil(info.width / per);
	const nRows = Math.ceil(info.height / per);
	const col0 = Math.round(info.west / cellDeg);
	const rowTop = Math.round(info.north / cellDeg) - 1;
	const n = nCols * nRows;
	const valid = new Uint32Array(n);
	const orchard = new Uint32Array(n);
	const vine = new Uint32Array(n);
	const newOrchard = new Uint32Array(n);
	const newVine = new Uint32Array(n);
	// 1 orchard, 2 vine, 0 neither.
	const kind = new Uint8Array(256);
	for (const c of classes.vine) if (c >= 0 && c < 256) kind[c] = 2;
	for (const c of classes.orchard) if (c >= 0 && c < 256) kind[c] = 1;
	const noData = noDataOf(info);
	const baseNoData = baseInfo ? noDataOf(baseInfo) : -1;
	const baseBlocks = baseline && baseInfo ? eachBlock(baseline, baseInfo) : null;
	let pixels = 0;
	for (const block of eachBlock(current, info)) {
		if (typeof block === 'string') return block;
		let base: TiffBlock | null = null;
		if (baseBlocks) {
			const next = baseBlocks.next();
			if (next.done) return 'the earlier edition is cut short';
			if (typeof next.value === 'string') return `the earlier edition: ${next.value}`;
			base = next.value;
		}
		const { bx, by, w, h, wIn, data } = block;
		for (let y = 0; y < h; y++) {
			const rowBase = Math.floor((by + y) / per) * nCols;
			const line = y * w;
			for (let x = 0; x < wIn; x++) {
				const v = data[line + x]!;
				if (v === noData) continue;
				const k = rowBase + Math.floor((bx + x) / per);
				valid[k]!++;
				const t = kind[v]!;
				if (!t) continue;
				if (t === 1) orchard[k]!++;
				else vine[k]!++;
				if (base) {
					const was = base.data[line + x]!;
					if (was !== baseNoData && !kind[was]) {
						if (t === 1) newOrchard[k]!++;
						else newVine[k]!++;
					}
				}
			}
		}
		pixels += wIn * h;
	}
	const cells: CropTypeCell[] = [];
	for (let r = 0; r < nRows; r++) {
		for (let c = 0; c < nCols; c++) {
			const k = r * nCols + c;
			if (!orchard[k] && !vine[k]) continue;
			const row = rowTop - r;
			const col = col0 + c;
			if (bbox) {
				const lon = (col + 0.5) * cellDeg;
				const lat = (row + 0.5) * cellDeg;
				if (lon < bbox.west || lon > bbox.east || lat < bbox.south || lat > bbox.north) continue;
			}
			const of = (x: number) => x / valid[k]!;
			cells.push({ row, col, orchard: of(orchard[k]!), vine: of(vine[k]!), newOrchard: of(newOrchard[k]!), newVine: of(newVine[k]!) });
		}
	}
	return { cells, pixels };
}
