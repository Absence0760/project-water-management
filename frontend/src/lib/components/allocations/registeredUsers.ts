// Registered users by hydrological unit (docs/allocations.md § Registered
// users by hydrological unit; docs/ui.md § Allocations): one row per
// registered user per farm, with what their authorisations in force today
// register, grouped by unit, each unit's subtotal and the catchment's total.
// What is registered only: no run is read, so it shows before the model has
// run. Pure, unit-tested in registeredUsers.test.ts; AllocationRegisteredUsers
// draws it and AllocationUseMap shades the units by its subtotals.
//
// The counting rules are the comparison's (engine allocations/compare.ts and
// area.ts), read on one day instead of over a run's days, as a viewer's totals
// per water source are (backend viewerUnits.ts volumeTotals):
//  * a row is in force on `day` when valid_from ≤ day ≤ valid_to (either open);
//  * the water use is the volume of its takes (s21a), surface and groundwater
//    added; a storage-only (s21b) row is never a take (engine isStorageOnly);
//  * the irrigated area is the one stated on its takes (a 21b row has none);
//  * the dam capacity is its registered storage: 21b rows and the storage
//    stated on a take.
// A figure none of a user's rows states is null ("–"), as the comparison's
// registered area and storage are; a subtotal or total is null when none of its
// rows has one.
import { isStorageOnly } from '@water-management/engine';
import type { Allocation } from '#lib/api/types.js';
import { toCsv } from '#lib/spreadsheet/paste/grid.js';

/** The three registered figures a row, a unit or the catchment carries. */
export interface RegisteredFigures {
	/** Σ irrigated area stated on the takes, ha; null: none states one. */
	areaHa: number | null;
	/** Σ registered storage (21b rows and storage on a take), m³; null: none registered. */
	storageM3: number | null;
	/** Σ volume of the takes, m³ a year; null: no take (storage only). */
	volumeM3: number | null;
}

/** One registered user on one farm. */
export interface RegisteredUserRow extends RegisteredFigures {
	key: string;
	/** The farm number: the allocation's property field ('' when none is stated). */
	farmNo: string;
	/** The registered user's name; null when none is stated or the reader may not see names (D3). */
	holder: string | null;
	/** How many authorisations in force are added up in it. */
	authorisations: number;
}

/** One hydrological unit's users (or the volumes not matched to a unit). */
export interface RegisteredUnitGroup {
	/** null: the volumes not matched to a unit. */
	nodeId: string | null;
	name: string;
	rows: RegisteredUserRow[];
	subtotal: RegisteredFigures;
}

export interface RegisteredUsersTable {
	groups: RegisteredUnitGroup[];
	/** Every group's subtotal added up, the not-matched group's included. */
	total: RegisteredFigures;
	/** Registered volumes not in force on the day, so in no figure. */
	notInForce: number;
	/** How many rows (registered users per farm) in all. */
	users: number;
}

/** The name the not-matched group goes under. */
export const NOT_MATCHED = 'Not matched to a unit';

/** In force on `day` (ISO date): valid_from ≤ day ≤ valid_to, either open (viewerUnits.ts inForce). */
export const inForceOn = (a: Pick<Allocation, 'validFrom' | 'validTo'>, day: string): boolean => (!a.validFrom || a.validFrom <= day) && (!a.validTo || a.validTo >= day);

const add = (a: number | null, b: number | null | undefined): number | null => (b === null || b === undefined || !Number.isFinite(b) ? a : (a ?? 0) + b);

function addRow(into: RegisteredFigures, a: Allocation) {
	if (isStorageOnly(a)) into.storageM3 = add(into.storageM3, a.storageM3);
	else {
		into.volumeM3 = add(into.volumeM3, a.volumeM3PerYear);
		into.areaHa = add(into.areaHa, a.irrigatedAreaHa);
		into.storageM3 = add(into.storageM3, a.storageM3);
	}
}

const sumFigures = (xs: readonly RegisteredFigures[]): RegisteredFigures => ({
	areaHa: xs.reduce<number | null>((s, x) => add(s, x.areaHa), null),
	storageM3: xs.reduce<number | null>((s, x) => add(s, x.storageM3), null),
	volumeM3: xs.reduce<number | null>((s, x) => add(s, x.volumeM3), null)
});

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * The table, from the volumes the page reads (`allocations`), the project's
 * units in their order (`nodes`, the list's) and the day the figures are in
 * force on. A user is one per unit, farm number and name, compared ignoring
 * case and spacing; with names hidden (`holders` false) the rows are per unit
 * and farm number. Units with no user in force are left out; the not-matched
 * group comes last. Within a unit, rows go by farm number, then name.
 */
export function registeredUsers(allocations: readonly Allocation[], nodes: readonly { id: string; name: string }[], day: string, holders = true): RegisteredUsersTable {
	const norm = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');
	const rowsByUnit = new Map<string | null, Map<string, RegisteredUserRow>>();
	const names = new Map<string, string>(nodes.map((n) => [n.id, n.name]));
	let notInForce = 0;
	for (const a of allocations) {
		if (!inForceOn(a, day)) {
			notInForce++;
			continue;
		}
		if (a.nodeId && !names.has(a.nodeId)) names.set(a.nodeId, a.nodeName ?? 'A hydrological unit');
		const farmNo = norm(a.propertyRef);
		const holder = holders ? norm(a.holder) || null : null;
		const key = `${a.nodeId ?? ''}|${farmNo.toLowerCase()}|${(holder ?? '').toLowerCase()}`;
		const unit = rowsByUnit.get(a.nodeId) ?? new Map<string, RegisteredUserRow>();
		rowsByUnit.set(a.nodeId, unit);
		const row = unit.get(key) ?? { key, farmNo, holder, areaHa: null, storageM3: null, volumeM3: null, authorisations: 0 };
		unit.set(key, row);
		row.authorisations++;
		addRow(row, a);
	}
	const order = [...nodes.map((n) => n.id), ...[...names.keys()].filter((id) => !nodes.some((n) => n.id === id))];
	const groups: RegisteredUnitGroup[] = [];
	for (const id of [...order, null]) {
		const unit = rowsByUnit.get(id);
		if (!unit?.size) continue;
		const rows = [...unit.values()].sort((a, b) => byText(a.farmNo, b.farmNo) || byText(a.holder ?? '', b.holder ?? ''));
		groups.push({ nodeId: id, name: id === null ? NOT_MATCHED : names.get(id)!, rows, subtotal: sumFigures(rows) });
	}
	return { groups, total: sumFigures(groups.map((g) => g.subtotal)), notInForce, users: groups.reduce((s, g) => s + g.rows.length, 0) };
}

/** Each unit's subtotal by its node id (the map's run-free shading): units with no user in force aren't in it. */
export function unitSubtotals(t: RegisteredUsersTable): Map<string, RegisteredFigures> {
	return new Map(t.groups.filter((g): g is RegisteredUnitGroup & { nodeId: string } => g.nodeId !== null).map((g) => [g.nodeId, g.subtotal]));
}

/**
 * The table as CSV, the screen's rows and columns: each user, each unit's
 * subtotal after its users and the catchment total last. The Registered user
 * column only when names are shown. Numbers plain (no grouping), cells defused
 * against spreadsheet formulas (csvCell).
 */
export function registeredUsersCsv(t: RegisteredUsersTable, holders: boolean): string {
	const head = ['farm_no', ...(holders ? ['registered_user'] : []), 'hydrological_unit', 'registered_irrigated_area_ha', 'registered_farm_dam_capacity_m3', 'registered_water_use_m3_a'];
	const figs = (f: RegisteredFigures) => [f.areaHa, f.storageM3, f.volumeM3];
	const lines: (string | number | null)[][] = [head];
	for (const g of t.groups) {
		for (const r of g.rows) lines.push([r.farmNo, ...(holders ? [r.holder ?? ''] : []), g.name, ...figs(r)]);
		lines.push([`Subtotal: ${g.name}`, ...(holders ? [''] : []), g.name, ...figs(g.subtotal)]);
	}
	lines.push(['Catchment total', ...(holders ? [''] : []), '', ...figs(t.total)]);
	return toCsv(lines);
}
