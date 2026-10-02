// Pre-summarise a land-cover raster into the cropland grid the app reads
// (173_cropland_reference.sql; issue #326 B-landcover, docs/maps.md
// § Cultivated area from land cover). The operator's tool, run as the schema
// owner (`pnpm import:land-cover`); the app only reads the result, and never
// a raster: no GeoTIFF code reaches a Lambda bundle (this module is imported
// by backend/scripts/import-land-cover.ts and its tests only). The JSON form,
// the defaults and the database load are in croplandGrid.ts, re-exported here.
//
// Two inputs:
//  * a GeoTIFF classification raster, read here without a dependency: the
//    ESA WorldCover 10 m tiles (3° × 3°, 36 000 pixels a side, 1024-pixel
//    tiles, Deflate, one 8-bit band, EPSG:4326, no-data 0). Classic TIFF,
//    tiled or striped, uncompressed or Deflate, predictor 1 or 2, 8-bit, one
//    sample; anything else is refused with the reason. Every pixel is
//    counted into the grid cell its centre falls in: per cell, the pixels
//    in a cultivated class over the pixels with data. The grid must line up
//    with the raster (the cell a whole number of pixels, the raster's corner
//    on a cell edge), so no cell straddles two tiles and each cell's share is
//    exact; WorldCover's 1/12 000° pixels and 3° tiles line up with 0.0025°.
//  * JSON: `{ "cellDeg": 0.005, "cells": [[lon, lat, fraction], …] }`, each
//    cell by its centre (the committed synthetic fixture's form).
// Only cells with some cropland are kept. A load replaces its dataset, in one
// transaction.
import { inflateSync } from 'node:zlib';
import type { CroplandCell } from './croplandGrid.js';

export {
	croplandFromJson,
	croplandToJson,
	jsonDatasetMeta,
	DEFAULT_CELL_DEG,
	mergeCells,
	methodFor,
	replaceCroplandDataset,
	WORLDCOVER_2021,
	WORLDCOVER_CROPLAND,
	type CroplandCell,
	type CroplandDatasetMeta,
	type JsonMeta
} from './croplandGrid.js';

// ---------------------------------------------------------------------------
// GeoTIFF
// ---------------------------------------------------------------------------

export interface TiffInfo {
	width: number;
	height: number;
	/** Tile (or strip) size: a strip is a tile as wide as the image. */
	blockW: number;
	blockH: number;
	offsets: number[];
	counts: number[];
	compression: number;
	predictor: number;
	/** Upper-left corner (lon, lat) and pixel size (degrees). */
	west: number;
	north: number;
	pixelW: number;
	pixelH: number;
	noData: number | null;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

/** The first image's tags a classification raster needs, or why it can't be read. */
export function readTiffInfo(buf: Buffer): TiffInfo | string {
	if (buf.length < 8) return 'not a TIFF file (too short)';
	const order = buf.toString('latin1', 0, 2);
	if (order !== 'II' && order !== 'MM') return 'not a TIFF file';
	const le = order === 'II';
	const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
	const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
	const f64 = (o: number) => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
	const magic = u16(2);
	if (magic === 43) return 'a BigTIFF file: convert it to a classic GeoTIFF first (each WorldCover tile already is one)';
	if (magic !== 42) return 'not a TIFF file';
	const ifd = u32(4);
	if (ifd + 2 > buf.length) return 'the TIFF file is cut short';
	const n = u16(ifd);
	const tags = new Map<number, number[]>();
	const ascii = new Map<number, string>();
	for (let i = 0; i < n; i++) {
		const e = ifd + 2 + i * 12;
		if (e + 12 > buf.length) return 'the TIFF file is cut short';
		const tag = u16(e);
		const type = u16(e + 2);
		const count = u32(e + 4);
		const size = TYPE_SIZE[type] ?? 1;
		const at = size * count <= 4 ? e + 8 : u32(e + 8);
		if (at + size * count > buf.length) return 'the TIFF file is cut short';
		if (type === 2) {
			ascii.set(tag, buf.toString('latin1', at, at + count).replace(/\0+$/, ''));
			continue;
		}
		// Only the tags read below: offsets and counts can run to thousands of values.
		const values: number[] = [];
		for (let k = 0; k < count; k++) {
			const o = at + k * size;
			values.push(type === 3 ? u16(o) : type === 4 ? u32(o) : type === 12 ? f64(o) : type === 1 ? buf[o]! : NaN);
		}
		tags.set(tag, values);
	}
	const one = (t: number) => tags.get(t)?.[0];
	const width = one(256);
	const height = one(257);
	if (!width || !height) return 'the TIFF has no image size';
	if ((one(258) ?? 1) !== 8) return `the raster's pixels are ${one(258)}-bit; a land-cover classification is 8-bit`;
	if ((one(277) ?? 1) !== 1) return 'the raster has several bands; give the classification band alone';
	if ((one(339) ?? 1) !== 1) return 'the raster is not unsigned integers';
	const compression = one(259) ?? 1;
	if (![1, 8, 32946].includes(compression)) return `the raster's compression (${compression}) isn't read here: save it uncompressed or with Deflate`;
	const predictor = one(317) ?? 1;
	if (predictor !== 1 && predictor !== 2) return `the raster's predictor (${predictor}) isn't read here`;
	const tiled = tags.has(322);
	const blockW = tiled ? one(322)! : width;
	const blockH = tiled ? one(323)! : (one(278) ?? height);
	const offsets = tags.get(tiled ? 324 : 273) ?? [];
	const counts = tags.get(tiled ? 325 : 279) ?? [];
	const blocks = Math.ceil(width / blockW) * Math.ceil(height / blockH);
	if (offsets.length !== blocks || counts.length !== blocks) return 'the TIFF lists the wrong number of tiles or strips';
	const scale = tags.get(33550);
	const tie = tags.get(33922);
	if (!scale || scale.length < 2 || !tie || tie.length < 6) return 'the TIFF has no georeference (ModelPixelScale and ModelTiepoint): give a GeoTIFF';
	// A GeoTIFF in another projection than plain longitude and latitude would need reprojecting first.
	const geoKeys = tags.get(34735) ?? [];
	for (let k = 4; k + 3 < geoKeys.length; k += 4) {
		if (geoKeys[k] === 1024 && geoKeys[k + 3] !== 2) return 'the raster is not in geographic coordinates: reproject it to EPSG:4326 first';
		if (geoKeys[k] === 2048 && geoKeys[k + 3] !== 4326 && geoKeys[k + 3] !== 32767) return `the raster's datum is EPSG:${geoKeys[k + 3]}, not WGS84 (EPSG:4326)`;
	}
	const nd = ascii.get(42113);
	const noData = nd !== undefined && nd.trim() !== '' && Number.isFinite(Number(nd)) ? Number(nd) : null;
	return {
		width,
		height,
		blockW,
		blockH,
		offsets,
		counts,
		compression,
		predictor,
		pixelW: scale[0]!,
		pixelH: scale[1]!,
		west: tie[3]! - tie[0]! * scale[0]!,
		north: tie[4]! + tie[1]! * scale[1]!,
		noData
	};
}

const near = (x: number, eps = 1e-6) => Math.abs(x - Math.round(x)) < eps;

/** Whether the grid of `cellDeg` lines up with the raster, or why not. */
export function gridFits(info: Pick<TiffInfo, 'west' | 'north' | 'pixelW' | 'pixelH'>, cellDeg: number): string | null {
	if (Math.abs(info.pixelW - info.pixelH) > 1e-12) return 'the raster’s pixels are not square in degrees';
	if (!near(cellDeg / info.pixelW)) return `a cell of ${cellDeg}° is not a whole number of the raster's ${info.pixelW}° pixels`;
	if (!near(info.west / cellDeg) || !near(info.north / cellDeg)) return `the raster's corner (${info.west}, ${info.north}) is not on the ${cellDeg}° grid`;
	return null;
}

export interface Bbox {
	west: number;
	south: number;
	east: number;
	north: number;
}

/**
 * Count one GeoTIFF into cropland cells: per cell, pixels in `classes` over
 * pixels with data. Cells with no cropland are left out, and with `bbox`,
 * cells whose centre is outside it.
 */
export function croplandCellsFromTiff(buf: Buffer, cellDeg: number, classes: ReadonlySet<number>, bbox?: Bbox): { cells: CroplandCell[]; pixels: number } | string {
	const info = readTiffInfo(buf);
	if (typeof info === 'string') return info;
	const misfit = gridFits(info, cellDeg);
	if (misfit) return misfit;
	const per = Math.round(cellDeg / info.pixelW);
	const nCols = Math.ceil(info.width / per);
	const nRows = Math.ceil(info.height / per);
	const col0 = Math.round(info.west / cellDeg);
	const rowTop = Math.round(info.north / cellDeg) - 1;
	const crop = new Uint32Array(nCols * nRows);
	const valid = new Uint32Array(nCols * nRows);
	const isCrop = new Uint8Array(256);
	for (const c of classes) if (c >= 0 && c < 256) isCrop[c] = 1;
	const noData = info.noData !== null && info.noData >= 0 && info.noData < 256 ? info.noData : -1;
	const across = Math.ceil(info.width / info.blockW);
	let pixels = 0;
	for (let b = 0; b < info.offsets.length; b++) {
		const bx = (b % across) * info.blockW;
		const by = Math.floor(b / across) * info.blockH;
		const raw = buf.subarray(info.offsets[b]!, info.offsets[b]! + info.counts[b]!);
		let data: Uint8Array;
		try {
			data = info.compression === 1 ? raw : inflateSync(raw);
		} catch {
			return `tile or strip ${b + 1} doesn't decompress`;
		}
		const w = info.blockW;
		const h = Math.min(info.blockH, info.height - by);
		if (data.length < w * h) return `tile or strip ${b + 1} is cut short`;
		if (info.predictor === 2) {
			data = Uint8Array.from(data);
			for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) data[y * w + x] = (data[y * w + x]! + data[y * w + x - 1]!) & 255;
		}
		const wIn = Math.min(w, info.width - bx);
		for (let y = 0; y < h; y++) {
			const rowBase = Math.floor((by + y) / per) * nCols;
			const line = y * w;
			for (let x = 0; x < wIn; x++) {
				const v = data[line + x]!;
				if (v === noData) continue;
				const k = rowBase + Math.floor((bx + x) / per);
				valid[k]!++;
				if (isCrop[v]) crop[k]!++;
			}
		}
		pixels += wIn * h;
	}
	const cells: CroplandCell[] = [];
	for (let r = 0; r < nRows; r++) {
		for (let c = 0; c < nCols; c++) {
			const k = r * nCols + c;
			if (!crop[k]) continue;
			const cell = { row: rowTop - r, col: col0 + c, fraction: crop[k]! / valid[k]! };
			if (bbox) {
				const lon = (cell.col + 0.5) * cellDeg;
				const lat = (cell.row + 0.5) * cellDeg;
				if (lon < bbox.west || lon > bbox.east || lat < bbox.south || lat > bbox.north) continue;
			}
			cells.push(cell);
		}
	}
	return { cells, pixels };
}
