// A-pan evaporation per hydrological unit (engine ≥ 1.117.0, docs/model.md
// §2.3b), a choice: `settings.apanBasis` 'units' (default 'catchment').
//
// `settings.apanMm` is one 12-month A-pan row for the whole catchment. A
// gridded A-pan (the WRC Atlas's A-pan equivalent, `Atlas-Apan-2007`) gives
// each land unit its own: `settings.apanUnits` holds, for each land unit the
// grid covers, the area-weighted mean of the grid's 12 monthly means over the
// unit's parcel (the backend's geo/unitApan.ts works them out; Model settings
// → Demand's table saves them with Use). With `settings.apanBasis` 'units'
// ("Run the model on: each unit's own A-pan") the per-unit grid is the run's
// A-pan source:
//
// - each covered land unit's crop demand (§2.3), GR4J potential evaporation
//   under pan coefficient × A-pan (§2.4a) and its dam's evaporation (§2.7a)
//   read its own row;
// - everything else reads the **catchment row**, the area-weighted mean of
//   the covered land units' rows (by the model's unit areas): a land unit the
//   grid doesn't cover (it runs on the mean, with a warning naming it), a dam
//   on a farm with no land of its own, and a model's other users;
// - the daily A-pan series (`evap_apan_mm`, §2.3a) is not read at all: every
//   unit runs on its grid monthly means every day, and a run whose project
//   holds one says so;
// - the stored `settings.apanMm` (the typed row) is kept but not read, so
//   clearing the setting runs on it again.
//
// Under 'catchment' (the default, absent or null) the stored rows are kept but
// nothing here runs (`resolveApanUnits` returns null), so the run is the same
// to the bit as before 1.117.0; under 'units' with no rows stored the run
// reads the catchment row and a warning says why.
import type { Monthly } from '../calendar';
import type { NetworkNode } from '../project';

/** At most this many units in the setting (the model holds at most 500 nodes). */
export const APAN_UNITS_MAX = 500;
/** Longest `source` the setting keeps (the API's limit too). */
export const APAN_UNITS_SOURCE_MAX = 600;
/** Largest monthly A-pan a unit's row takes, mm: the scenario allowlist's bound on the catchment row, so a scaled row stays usable. */
export const APAN_UNIT_MONTH_MAX = 10_000;

/** What the model runs each unit's A-pan on (settings.apanBasis): the one catchment row (default) or each unit's own. */
export const APAN_BASES = ['catchment', 'units'] as const;
export type ApanBasis = (typeof APAN_BASES)[number];

/** Whether settings.apanBasis asks for each unit's own A-pan (anything but 'units' is the catchment row). */
export const apanBasisIsUnits = (raw: unknown): boolean => raw === 'units';

/** Why a stored apanBasis can't be used, or null (absent and null are the default). */
export function apanBasisError(raw: unknown): string | null {
	return raw === null || raw === undefined || (APAN_BASES as readonly unknown[]).includes(raw) ? null : `the A-pan basis must be one of ${APAN_BASES.join(', ')}`;
}

/** settings.apanUnits: the A-pan grid's rows for each land unit it covers. */
export interface ApanUnitsSettings {
	/** The grid's dataset label (e.g. `Atlas-Apan-2007`). */
	dataset: string;
	/** Its citation and how the rows were taken (provenance only: the model never reads it). */
	source: string;
	/** Land unit id → 12 monthly A-pan means, mm, October first. Only the units the grid covers. */
	units: Record<string, number[]>;
}

/** Why a stored apanUnits setting can't be used, or null when it can (absent and null are fine: no per-unit A-pan). */
export function apanUnitsError(raw: unknown): string | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) return 'not an A-pan per unit setting';
	const r = raw as { dataset?: unknown; source?: unknown; units?: unknown };
	if (typeof r.dataset !== 'string' || !r.dataset.trim() || r.dataset.length > 50) return 'the A-pan per unit needs its grid’s dataset label (at most 50 characters)';
	if (typeof r.source !== 'string' || !r.source.trim() || r.source.length > APAN_UNITS_SOURCE_MAX) return `the A-pan per unit needs its source (at most ${APAN_UNITS_SOURCE_MAX} characters)`;
	if (!r.units || typeof r.units !== 'object' || Array.isArray(r.units)) return 'the A-pan per unit must be a map of unit → 12 months';
	const entries = Object.entries(r.units as Record<string, unknown>);
	if (!entries.length) return 'the A-pan per unit names no unit';
	if (entries.length > APAN_UNITS_MAX) return `at most ${APAN_UNITS_MAX} units can have their own A-pan`;
	for (const [id, row] of entries) {
		if (!id || id.length > 200) return 'an A-pan row needs its unit';
		if (!Array.isArray(row) || row.length !== 12 || !row.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= APAN_UNIT_MONTH_MAX))
			return `a unit’s A-pan must be 12 months of 0–${APAN_UNIT_MONTH_MAX} mm`;
	}
	return null;
}

/** A unit as the resolution reads it. */
type Unit = Pick<NetworkNode, 'id' | 'name' | 'kind' | 'areaKm2'>;

/** What a run did with settings.apanUnits (RunSummary.apanUnits). */
export interface ApanUnitsRun {
	dataset: string;
	source: string;
	/** The catchment row: the covered land units' rows, area-weighted (mm, Oct–Sep). */
	catchmentMm: number[];
	/** Every land unit, in node-id order: the row it ran on, and whether that was its own (false: the catchment row). */
	units: { nodeId: string; name: string; areaKm2: number; apanMm: number[]; covered: boolean }[];
	/** The project held a daily A-pan series, which this source doesn't read. */
	dailyIgnored: boolean;
}

/** The setting as a run applies it. */
export interface ResolvedApanUnits {
	/** The setting kept to the land units of the model, each row as stored. */
	setting: ApanUnitsSettings;
	catchmentMm: Monthly;
	run: ApanUnitsRun;
}

/**
 * The area-weighted mean of `rows` (weights `areas`, > 0), month by month. A
 * month every row holds the same value in is that value exactly, so units all
 * given the catchment's row run on it to the bit.
 */
export function areaWeightedApan(rows: readonly (readonly number[])[], areas: readonly number[]): number[] {
	const total = areas.reduce((s, a) => s + a, 0);
	return Array.from({ length: 12 }, (_, m) => {
		const first = rows[0]![m]!;
		if (rows.every((r) => r[m] === first)) return first;
		let s = 0;
		for (let k = 0; k < rows.length; k++) s += rows[k]![m]! * areas[k]!;
		return s / total;
	});
}

const isLand = (n: Unit) => n.kind === 'farm' && n.areaKm2 > 0;
const label = (n: Unit) => `"${n.name || 'unnamed'}"`;

/**
 * settings.apanUnits as the run applies it, or null when it doesn't: the
 * basis isn't 'units', the rows are absent, null (a warning), unusable (a warning says why), or covering none of the model's land
 * units (a warning; the run then reads settings.apanMm as without it). Rows
 * for a node that is not a land unit now are left out. `dailyApan`: the
 * project holds a daily A-pan series, which this source leaves unread (a
 * warning says so).
 */
export function resolveApanUnits(
	settings: { apanBasis?: unknown; apanUnits?: unknown } | null | undefined,
	nodes: readonly Unit[],
	dailyApan: boolean,
	warnings: string[]
): ResolvedApanUnits | null {
	if (!apanBasisIsUnits(settings?.apanBasis)) return null;
	const raw = settings?.apanUnits;
	if (raw === null || raw === undefined) {
		warnings.push('each unit’s own A-pan is chosen (Model settings → Demand), but no unit has one saved: every unit runs on the A-pan row. Use the units’ A-pan from the CCWR A-pan grid first');
		return null;
	}
	const e = apanUnitsError(raw);
	if (e) {
		warnings.push(`the A-pan per hydro unit is not used (${e}); every unit runs on the A-pan row in Model settings → Demand`);
		return null;
	}
	const r = raw as ApanUnitsSettings;
	const land = nodes.filter(isLand);
	const covered = land.filter((n) => Object.hasOwn(r.units, n.id));
	if (!covered.length) {
		warnings.push(`the A-pan per hydro unit from ${r.dataset} covers none of the model’s land units, so it is not used: every unit runs on the A-pan row in Model settings → Demand. Propose it again from the grid`);
		return null;
	}
	// Node-id order, so the mean is the same to the bit however the nodes are listed.
	const byId = [...covered].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const catchmentMm = areaWeightedApan(
		byId.map((n) => r.units[n.id]!),
		byId.map((n) => n.areaKm2)
	) as unknown as Monthly;
	// Built with Object.fromEntries, so a unit id that is a prototype key ("__proto__") stays a plain entry (CodeQL js/remote-property-injection).
	const units: Record<string, number[]> = Object.fromEntries(covered.map((n) => [n.id, [...r.units[n.id]!]]));
	// Node-id order, so a run's warnings are the same however the nodes are listed.
	const sorted = [...land].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const uncovered = sorted.filter((n) => !Object.hasOwn(r.units, n.id));
	if (uncovered.length) {
		const annual = Math.round(catchmentMm.reduce((s: number, v: number) => s + v, 0));
		warnings.push(
			`A-pan per hydro unit: ${uncovered.length === 1 ? 'the unit' : `${uncovered.length} units`} ${uncovered.map(label).join(', ')} ${uncovered.length === 1 ? 'has' : 'have'} no A-pan from ${r.dataset}, so ${uncovered.length === 1 ? 'it runs' : 'they run'} on the catchment row, the covered units’ A-pan area-weighted (${annual} mm a year)`
		);
	}
	if (dailyApan) warnings.push(`the daily A-pan series is not used: the A-pan comes from ${r.dataset} per hydro unit, so every unit runs on its grid’s monthly means on every day`);
	return {
		setting: { dataset: r.dataset, source: r.source, units },
		catchmentMm,
		run: {
			dataset: r.dataset,
			source: r.source,
			catchmentMm: [...catchmentMm],
			units: sorted.map((n) => {
				const own = units[n.id];
				return { nodeId: n.id, name: n.name, areaKm2: n.areaKm2, apanMm: own ? [...own] : [...catchmentMm], covered: !!own };
			}),
			dailyIgnored: dailyApan
		}
	};
}

/**
 * The A-pan row a node runs on (mm, Oct–Sep): its own under the per-unit grid
 * (settings as prepareRun resolved them: `apanUnits` kept to the land units,
 * `apanMm` the catchment row), else the catchment's.
 */
export function apanRowOf(settings: { apanMm: readonly number[]; apanUnits?: Pick<ApanUnitsSettings, 'units'> | null }, nodeId: string): readonly number[] {
	return settings.apanUnits?.units[nodeId] ?? settings.apanMm;
}

/**
 * The A-pan row the Crops & demand preview and other catchment-level readers
 * show before a run (mm, Oct–Sep): the catchment row of the per-unit grid
 * when it applies to `nodes`, else settings.apanMm. No warnings.
 */
export function catchmentApanMm(settings: { apanMm: readonly number[]; apanBasis?: unknown; apanUnits?: unknown }, nodes: readonly Unit[]): number[] {
	const r = resolveApanUnits(settings, nodes, false, []);
	return r ? [...r.catchmentMm] : [...settings.apanMm];
}

/**
 * The A-pan rows a stored run read, from its settings snapshot and model, for readers that redo part of the run
 * (the farm projection's efficiencies): `apanMm` the catchment row it ran on (the covered units' rows area-weighted
 * under the 'units' basis, else the typed row) and `apanUnits` each covered land unit's own row (null under the
 * catchment row). No warnings.
 */
export function runApanRows(settings: { apanMm?: unknown; apanBasis?: unknown; apanUnits?: unknown } | null | undefined, nodes: readonly Unit[]): { apanMm: number[]; apanUnits: { units: Record<string, number[]> } | null } {
	const typed = Array.isArray(settings?.apanMm) ? (settings.apanMm as unknown[]).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)) : [];
	const r = resolveApanUnits(settings, nodes, false, []);
	return r ? { apanMm: [...r.catchmentMm], apanUnits: { units: r.setting.units } } : { apanMm: typed, apanUnits: null };
}

/** The land units the per-unit grid has no row for under the 'units' basis, in the model's order (every land unit with none stored); none under the catchment row or with unusable rows. Run readiness lists them. */
export function unitsWithoutGridApan<N extends Unit>(nodes: readonly N[], settings: { apanBasis?: unknown; apanUnits?: unknown } | null | undefined): N[] {
	if (!apanBasisIsUnits(settings?.apanBasis)) return [];
	const raw = settings?.apanUnits;
	// None stored: every land unit runs on the catchment row.
	if (raw === null || raw === undefined) return nodes.filter(isLand);
	if (apanUnitsError(raw)) return [];
	const units = (raw as ApanUnitsSettings).units;
	return nodes.filter((n) => isLand(n) && !Object.hasOwn(units, n.id));
}

/**
 * A scenario's change of the catchment A-pan row under the A-pan per hydro
 * unit (engine ≥ 1.117.0, docs/scenarios.md): `next` is the row the scenario
 * sets, `base` the catchment row the base runs on. Every unit's row is scaled
 * by the same factor next ÷ base month by month, so the catchment row becomes
 * `next` and each unit keeps its place against the others. A month the base
 * has no A-pan in can't be scaled: null with the reason.
 */
export function scaleApanUnits(setting: ApanUnitsSettings, base: readonly number[], next: readonly number[]): { setting: ApanUnitsSettings } | { problem: string } {
	const f: number[] = [];
	for (let m = 0; m < 12; m++) {
		const b = base[m]!;
		const n = next[m]!;
		if (b > 0) f.push(n / b);
		else if (n === 0) f.push(1);
		else return { problem: `the units’ A-pan is 0 in month ${m + 1} of the water year, so it can’t be scaled to ${n} mm` };
	}
	// Object.fromEntries, so a unit id that is a prototype key stays a plain entry (CodeQL js/remote-property-injection).
	const units: Record<string, number[]> = Object.fromEntries(Object.entries(setting.units).map(([id, row]) => [id, row.map((v, m) => (f[m] === 1 ? v : v * f[m]!))]));
	return { setting: { ...setting, units } };
}
