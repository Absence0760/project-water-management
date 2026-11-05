// The Allocations map's run-free shading (docs/allocations.md § The map,
// "What is registered"): each hydrological unit's area shaded by what its
// registered users in force today register, for the measure picked (water use,
// irrigated area or dam capacity), on a five-step sequential scale with a key.
// It needs no run: the figures are the Registered users table's unit
// subtotals (registeredUsers.ts), so the map can't disagree with the table.
// Pure, unit-tested in registeredMap.test.ts; AllocationMap.svelte draws it
// through the scheme this module builds (the same component draws the
// compared-to-run shading of useMap.ts).
import type { MapFeature } from '#lib/api/types.js';
import { fmtNum } from '#lib/format/number.js';
import { interiorPoint } from '#lib/components/map/pieces.js';
import type { RegisteredFigures } from './registeredUsers';
import type { DrawnUnit, MapMeasure, MapScheme } from './useMap';

/** A step of the scale, lightest (s1) to darkest (s5); `none`: nothing registered, outline only. */
export type RegisteredStep = 's1' | 's2' | 's3' | 's4' | 's5' | 'none';
export const REGISTERED_STEPS: readonly Exclude<RegisteredStep, 'none'>[] = ['s1', 's2', 's3', 's4', 's5'];

/** The figure each measure reads from a unit's subtotal. */
export const registeredValue = (f: RegisteredFigures | undefined, measure: MapMeasure): number | null =>
	!f ? null : measure === 'use' ? f.volumeM3 : measure === 'area' ? f.areaHa : f.storageM3;

/** A figure with its unit, as the map's labels and key show it. */
export const registeredFigure = (measure: MapMeasure, v: number): string =>
	measure === 'area' ? `${fmtNum(v, 1, true)} ha` : measure === 'use' ? `${fmtNum(v)} m³/a` : `${fmtNum(v)} m³`;

/** What the key's heading says each measure is. */
export const REGISTERED_TITLE: Record<MapMeasure, string> = {
	use: 'registered water use, m³ a year',
	area: 'registered irrigated area, ha',
	storage: 'registered farm dam capacity, m³'
};

/** The smallest of 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10ⁿ that is at least `v` (a step the key reads easily, close enough that the largest unit lands in the darkest step or near it). */
export function niceCeil(v: number): number {
	if (!(v > 0)) return 1;
	const p = 10 ** Math.floor(Math.log10(v));
	for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v * (1 - 1e-12)) return m * p;
	return 10 * p;
}

/** The scale's upper edges: five equal steps from 0 to a round number at or above the largest figure. */
export function registeredBreaks(values: readonly number[]): number[] {
	const max = Math.max(0, ...values.filter((v) => Number.isFinite(v)));
	const step = niceCeil(max / 5);
	return REGISTERED_STEPS.map((_, i) => step * (i + 1));
}

/** A figure's step: the first whose upper edge holds it (edges inclusive); none for nothing registered. */
export function registeredStep(v: number | null, breaks: readonly number[]): RegisteredStep {
	if (v === null || !(v > 0)) return 'none';
	const i = breaks.findIndex((b) => v <= b * (1 + 1e-12));
	return REGISTERED_STEPS[i < 0 ? REGISTERED_STEPS.length - 1 : i]!;
}

/** Each step's range in words, for the key: "0–50 000 m³/a", "50 000–100 000 m³/a" … */
export function stepLabel(step: Exclude<RegisteredStep, 'none'>, breaks: readonly number[], measure: MapMeasure): string {
	const i = REGISTERED_STEPS.indexOf(step);
	const lo = i === 0 ? 0 : breaks[i - 1]!;
	const hi = breaks[i]!;
	const num = (v: number) => (measure === 'area' ? fmtNum(v, 1, true) : fmtNum(v));
	const unit = measure === 'area' ? 'ha' : measure === 'use' ? 'm³/a' : 'm³';
	return `${i === 0 ? 'Up to' : `More than ${num(lo)}, up to`} ${num(hi)} ${unit}`;
}

/**
 * The scale's colours, a sequential blue apart from the run bands' greens and
 * reds so the two maps don't read alike; `text` is a label's colour on its
 * step, at least 4.5:1 (registeredMap.test.ts). `none` has no fill.
 */
export function registeredColours(dark: boolean): Record<RegisteredStep, { fill: string; text: string }> {
	return dark
		? {
				s1: { fill: '#c6dbef', text: '#000000' },
				s2: { fill: '#9ecae1', text: '#000000' },
				s3: { fill: '#6baed6', text: '#000000' },
				s4: { fill: '#4292c6', text: '#000000' },
				s5: { fill: '#2171b5', text: '#ffffff' },
				none: { fill: '#1d211e', text: '#eef0ec' }
			}
		: {
				s1: { fill: '#deebf7', text: '#000000' },
				s2: { fill: '#9ecae1', text: '#000000' },
				s3: { fill: '#6baed6', text: '#000000' },
				s4: { fill: '#3182bd', text: '#000000' },
				s5: { fill: '#08519c', text: '#ffffff' },
				none: { fill: '#ffffff', text: '#1f2320' }
			};
}

/** One unit on the run-free map. */
export interface RegisteredUnit extends DrawnUnit {
	value: number | null;
	band: RegisteredStep;
}

export interface RegisteredShading {
	drawn: RegisteredUnit[];
	/** Units with no area on the Map tab: listed under the map with their figure. */
	unplaced: RegisteredUnit[];
	/** The run-free map has no run, so no unit is "not in it". */
	notInRun: [];
	breaks: number[];
}

type Polygonal = DrawnUnit['polygons'][number]['geometry'];
const isPolygonal = (g: MapFeature['geometry']): g is Polygonal => g.type === 'Polygon' || g.type === 'MultiPolygon';

/**
 * Every unit of the project (`units`: the farms and water users) with its
 * registered figure for the measure (`subtotals`, the table's) and its step,
 * and its polygons from the Map tab's features (a farm_parcel linked to it),
 * its label inside the largest. The unplaced list goes largest figure first,
 * then by name.
 */
export function registeredShading(units: readonly { id: string; name: string }[], subtotals: ReadonlyMap<string, RegisteredFigures>, features: readonly MapFeature[], measure: MapMeasure): RegisteredShading {
	const byNode = new Map<string, { featureId: string; geometry: Polygonal; area: number }[]>();
	for (const f of features) {
		if (f.kind !== 'farm_parcel' || !f.nodeId || !isPolygonal(f.geometry)) continue;
		const list = byNode.get(f.nodeId) ?? [];
		list.push({ featureId: f.id, geometry: f.geometry, area: f.areaM2 ?? 0 });
		byNode.set(f.nodeId, list);
	}
	const values = units.map((u) => registeredValue(subtotals.get(u.id), measure));
	const breaks = registeredBreaks(values.filter((v): v is number => v !== null));
	const drawn: RegisteredUnit[] = [];
	const unplaced: RegisteredUnit[] = [];
	units.forEach((u, i) => {
		const value = values[i]!;
		const ps = (byNode.get(u.id) ?? []).slice().sort((a, b) => b.area - a.area);
		const unit: RegisteredUnit = {
			nodeId: u.id,
			name: u.name,
			value,
			band: registeredStep(value, breaks),
			label: value !== null && value > 0 ? registeredFigure(measure, value) : 'None registered',
			polygons: ps.map(({ featureId, geometry }) => ({ featureId, geometry })),
			at: ps[0] ? interiorPoint(ps[0].geometry) : null
		};
		(unit.polygons.length ? drawn : unplaced).push(unit);
	});
	unplaced.sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.name.localeCompare(b.name));
	return { drawn, unplaced, notInRun: [], breaks };
}

/** A unit's figure in one sentence, for its label's accessible name: it holds the label's words (WCAG 2.5.3). */
export function registeredSentence(u: Pick<RegisteredUnit, 'name' | 'value' | 'label'>, measure: MapMeasure): string {
	if (u.value === null || !(u.value > 0)) return `${u.name}: None registered (${REGISTERED_TITLE[measure].split(',')[0]}, in force today).`;
	return `${u.name}: ${u.label} ${REGISTERED_TITLE[measure].split(',')[0]}, in force today.`;
}

type Layer = Record<string, unknown> & { id: string; type: string };

/** The run-free map's layers over the same source as the run's (useMap USE_SOURCE_ID): each step's fill, a casing and a stroke. */
export function registeredLayers(dark: boolean, source: string): Layer[] {
	const c = registeredColours(dark);
	const src = { source };
	return [
		{
			id: 'use-fill',
			type: 'fill',
			...src,
			filter: ['in', ['get', 'band'], ['literal', [...REGISTERED_STEPS]]],
			paint: { 'fill-color': ['match', ['get', 'band'], 's1', c.s1.fill, 's2', c.s2.fill, 's3', c.s3.fill, 's4', c.s4.fill, c.s5.fill], 'fill-opacity': 0.75 }
		},
		{ id: 'use-casing', type: 'line', ...src, paint: { 'line-color': dark ? '#000000' : '#ffffff', 'line-width': 5, 'line-opacity': 0.85 } },
		{ id: 'use-line', type: 'line', ...src, paint: { 'line-color': dark ? '#eef0ec' : '#1f2320', 'line-width': 2 } }
	];
}

/** The scheme AllocationMap draws the run-free shading with. */
export function registeredScheme(measure: MapMeasure, source: string): MapScheme {
	return {
		id: 'registered',
		layers: (dark) => registeredLayers(dark, source),
		colours: (dark) => registeredColours(dark),
		sentence: (u) => registeredSentence(u as RegisteredUnit, measure),
		ariaLabel: `Hydrological units shaded by ${REGISTERED_TITLE[measure].split(',')[0]}`
	};
}
