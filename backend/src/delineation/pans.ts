// Pans: the part of a delineated catchment that drains into a closed
// depression (docs/design/delineation.md § Pans; the research behind the
// thresholds, docs/design/pans-research.md). Priority-Flood fills every
// depression so that D8 can route it to the outlet (flow.ts); in South
// Africa's interior many of those depressions are pans, endorheic wetlands
// whose runoff evaporates instead of reaching the river, and WR2012 counts
// their catchments as non-contributing ("endoreic areas"). This module reads
// the fill's output (the elevations before and after it) and reports that
// area beside the routed catchment. It never changes the routing: the
// catchment proposed stays the gross one, and the non-contributing figure
// is the hydrologist's to use or not (the PFRA's gross and effective
// drainage areas, both reported).
//
// A closed depression counts as a pan when all three hold:
//  * it is at least PAN_MIN_DEPTH_M deep below its spill;
//  * its floor (the cells the fill raised) covers at least PAN_MIN_FLOOR_M2;
//  * it holds at least PAN_MIN_STORAGE_MM of its own catchment's runoff
//    below its spill, so an average year's runoff can't fill it: a dam on a
//    river drawn down below its spillway, or the pond behind a road
//    embankment, holds a few millimetres over its catchment and is not a pan.
// A depression holding a point (the outlet, or a unit's point), or spilling
// to one within the snap radius, is that point's own (a dam's basin behind
// the clicked wall), never a pan.
//
// Pure: typed arrays in, a mask and figures out.
import type { Position } from '../geo/geojson.js';
import { DX, DY, OUT } from './flow.js';

/** Shallowest depression counted (m below its spill): about GLO-30's height error over flat land (§ Pans). */
export const PAN_MIN_DEPTH_M = 1;
/** Smallest floor counted (m²): about 90 GLO-30 cells, past which a 1 m hollow is no longer the DEM's noise. */
export const PAN_MIN_FLOOR_M2 = 100_000;
/** Least storage below the spill, as runoff over the depression's own catchment (mm): over twice South Africa's mean annual runoff. */
export const PAN_MIN_STORAGE_MM = 100;
/** Pans listed on a proposal, the largest catchments first. */
export const PANS_LISTED = 5;
/**
 * A raise above this (m) is a filled depression; below it, the fill's ε gradient across a flat (flow.ts nextUp: far under a
 * micrometre even over millions of cells). Terrarium stores heights in 1/256 m steps, so any real filling is at least 0.0039 m.
 */
const RAISED_M = 0.001;
/**
 * A depression is every cell the fill raised (by any amount, its flat margin's ε too) within this (m) of its level: it is
 * filled flat to its spill, plus the ε gradient. Two that touch at different levels (one spilling into the other) stay two,
 * the upper one's water an inflow of the lower. Terrarium's 1/256 m step keeps distinct spill levels further apart than this.
 */
const LEVEL_M = 0.001;

/** The method, as a proposal stores it with the figure. */
export const PAN_METHOD =
	`Non-contributing (pans): the cells draining into a closed depression of the DEM at least ${PAN_MIN_DEPTH_M} m deep below its spill, ` +
	`with a floor of at least ${PAN_MIN_FLOOR_M2 / 1e6} km², holding at least ${PAN_MIN_STORAGE_MM} mm of its own catchment's runoff below the spill ` +
	`(WR2012's endoreic areas; the PFRA's effective drainage area), a depression at the outlet or a unit's point excepted. ` +
	`Reported only: the catchment is routed through the pans, as filled.`;

/** One pan: where its floor is deepest, its floor's area, its depth below the spill, what drains into it and what it holds over that. */
export interface Pan {
	at: Position;
	floorM2: number;
	depthM: number;
	drainsM2: number;
	storageMm: number;
}

/** What a proposal stores: the non-contributing area, the pans' count, the largest few and the method. */
export interface PanReport {
	/** The catchment's area that drains into a pan, the pans' floors included (m²). */
	nonContributingM2: number;
	count: number;
	largest: Pan[];
	method: string;
}

export interface PanGrid {
	nx: number;
	ny: number;
	/** Elevations before the fill (Float32 is plenty: GLO-30's own heights are float32). */
	before: Float32Array;
	/** Elevations after it (flow.ts fill's output). */
	after: Float64Array;
	dir: Uint8Array;
	/** Upstream cells of every cell, itself included (flow.ts accumulate). */
	acc: Int32Array;
	/** The catchment: only its cells are looked at. */
	mask: Uint8Array;
	/** Each row's cell area (m²). */
	rowM2: Float64Array;
	/** A cell's centre on the map. */
	toPos: (cell: number) => Position;
}

/** A growable list of cell indices (typed, so a depression of a million cells costs 4 MB, not a JS array's churn). */
class Cells {
	a = new Int32Array(1024);
	length = 0;
	push(c: number) {
		if (this.length === this.a.length) {
			const b = new Int32Array(this.a.length * 2);
			b.set(this.a);
			this.a = b;
		}
		this.a[this.length++] = c;
	}
}

/**
 * The catchment's pans: `nc` marks every cell that drains into one (1),
 * `pans` lists them, the largest catchment first. `points` are the outlet's
 * and the units' cells; a depression at one, or spilling to one within
 * `nearCells` steps, is never a pan. One pass over the catchment's filled
 * cells, then one flood up from the pans: linear in the catchment.
 */
export function findPans(g: PanGrid, points: readonly number[], nearCells: number): { nc: Uint8Array; pans: Pan[] } {
	const { nx, ny, before, after, dir, acc, mask, rowM2 } = g;
	const n = nx * ny;
	// Bit 1: a filled cell already put in a depression; bit 2: drains into a pan.
	const state = new Uint8Array(n);
	const isPoint = new Set(points);
	/** A depression's seed: raised past the ε. */
	const raised = (i: number) => mask[i] === 1 && after[i]! - before[i]! > RAISED_M;
	/** In the depression at level `L`. */
	const member = (i: number, L: number) => mask[i] === 1 && after[i]! > before[i]! && Math.abs(after[i]! - L) < LEVEL_M;
	const down = (i: number) => {
		const d = dir[i]!;
		return d === OUT ? -1 : i + DY[d]! * nx + DX[d]!;
	};
	const pans: (Pan & { cells: Int32Array })[] = [];
	const list = new Cells();
	for (let i = 0; i < n; i++) {
		if (state[i]! & 1 || !raised(i)) continue;
		// One depression: its filled cells at one level, 8-connected (the list is the breadth-first queue).
		list.length = 0;
		let floorM2 = 0;
		let volumeM3 = 0;
		let depthM = 0;
		let deepest = i;
		let atPoint = false;
		// What drains into it: its own cells, and every cell upstream of a cell outside it that drains into it. Water that
		// reaches a filled cell stays below the spill until it leaves by the spill, so those upstream sets never overlap.
		let drainsM2 = 0;
		const level = after[i]!;
		state[i]! |= 1;
		list.push(i);
		for (let h = 0; h < list.length; h++) {
			const c = list.a[h]!;
			const cx = c % nx;
			const cy = (c - cx) / nx;
			const m2 = rowM2[cy]!;
			const d = after[c]! - before[c]!;
			// The floor: what the fill raised past the ε (a flat margin at the level holds no water).
			if (d > RAISED_M) floorM2 += m2;
			volumeM3 += d * m2;
			drainsM2 += m2;
			if (d > depthM) (depthM = d), (deepest = c);
			if (isPoint.has(c)) atPoint = true;
			for (let k = 0; k < 8; k++) {
				const x = cx + DX[k]!;
				const y = cy + DY[k]!;
				if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
				const j = y * nx + x;
				if (member(j, level)) {
					if (state[j]! & 1) continue;
					state[j]! |= 1;
					list.push(j);
				} else if (dir[j] === (k + 4) % 8) drainsM2 += acc[j]! * rowM2[y]!;
			}
		}
		if (depthM < PAN_MIN_DEPTH_M || floorM2 < PAN_MIN_FLOOR_M2) continue;
		// Its spill: down from the deepest cell to the first cell off its level.
		let spill = deepest;
		while (spill >= 0 && member(spill, level)) spill = down(spill);
		// Spilling into a point close by: the point's own basin (a dam's, behind the wall clicked).
		for (let k = spill, s = 0; !atPoint && k >= 0 && s <= nearCells; k = down(k), s++) if (isPoint.has(k)) atPoint = true;
		if (atPoint) continue;
		const storageMm = (volumeM3 / drainsM2) * 1000;
		if (storageMm < PAN_MIN_STORAGE_MM) continue;
		pans.push({ at: g.toPos(deepest), floorM2, depthM, drainsM2, storageMm, cells: list.a.slice(0, list.length) });
	}
	// Everything upstream of a pan's cells drains into it.
	list.length = 0;
	for (const p of pans) {
		for (const c of p.cells) {
			if (state[c]! & 2) continue;
			state[c]! |= 2;
			list.push(c);
		}
	}
	for (let h = 0; h < list.length; h++) {
		const c = list.a[h]!;
		const cx = c % nx;
		const cy = (c - cx) / nx;
		for (let k = 0; k < 8; k++) {
			const x = cx + DX[k]!;
			const y = cy + DY[k]!;
			if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
			const j = y * nx + x;
			if (state[j]! & 2 || dir[j] !== (k + 4) % 8) continue;
			state[j]! |= 2;
			list.push(j);
		}
	}
	for (let i = 0; i < n; i++) state[i] = (state[i]! >> 1) & 1;
	pans.sort((a, b) => b.drainsM2 - a.drainsM2);
	return { nc: state, pans: pans.map(({ cells: _, ...p }) => p) };
}

/** The non-contributing area (m²) of the cells `of` marks (1), from `nc`. */
export function ncAreaM2(nx: number, nc: Uint8Array, rowM2: Float64Array, of?: (cell: number) => boolean): number {
	let m2 = 0;
	for (let i = 0; i < nc.length; i++) if (nc[i] && (!of || of(i))) m2 += rowM2[(i - (i % nx)) / nx]!;
	return m2;
}

/** The report a proposal stores (the figures rounded to what they're worth). */
export function panReport(nonContributingM2: number, pans: readonly Pan[]): PanReport {
	return {
		nonContributingM2: Math.round(nonContributingM2),
		count: pans.length,
		largest: pans.slice(0, PANS_LISTED).map((p) => ({
			at: p.at,
			floorM2: Math.round(p.floorM2),
			depthM: Math.round(p.depthM * 10) / 10,
			drainsM2: Math.round(p.drainsM2),
			storageMm: Math.round(p.storageMm)
		})),
		method: PAN_METHOD
	};
}

const km2Text = (m2: number) => {
	const v = m2 / 1e6;
	return v < 10 ? `${v.toFixed(2)} km²` : `${Math.round(v).toLocaleString('en-ZA')} km²`;
};
const place = ([lon, lat]: Position) => `${Math.abs(lat).toFixed(3)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(3)}° ${lon < 0 ? 'W' : 'E'}`;

/**
 * The sentence a Start or Divide proposal shows when part of its catchment drains into pans: how much, where the largest is,
 * and which pieces hold it (`pieces`: each with any, by name). Null when none does.
 */
export function panWarning(report: PanReport, catchmentM2: number, pieces: readonly { name: string; ncM2: number }[]): string | null {
	if (!report.count || !(report.nonContributingM2 > 0)) return null;
	const big = report.largest[0]!;
	const share = catchmentM2 > 0 ? ` (${Math.round((100 * report.nonContributingM2) / catchmentM2)} %)` : '';
	const held = pieces.filter((p) => p.ncM2 >= 0.005e6).map((p) => `${km2Text(p.ncM2)} in ${p.name}’s`);
	return (
		`${km2Text(report.nonContributingM2)} of the catchment above the outlet${share} drains into ` +
		(report.count === 1
			? `a pan (a closed depression on the elevation model, at ${place(big.at)}, ${km2Text(big.drainsM2)} draining into it). `
			: `${report.count} pans (closed depressions on the elevation model; the largest at ${place(big.at)}, ${km2Text(big.drainsM2)} draining into it). `) +
		`WR2012 counts such endoreic areas as non-contributing; the areas here still include them${held.length ? `: ${held.join(', ')} own area` : ''}. Use the effective area if you model them as non-contributing.`
	);
}
