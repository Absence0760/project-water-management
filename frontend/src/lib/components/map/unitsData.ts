// Each unit's data from the map, reviewed together (issue #646 item 2;
// docs/ui.md § Map, docs/design/start-from-map.md § The flow, step 4): the
// two per-unit proposals, MAP for each unit (GET …/map/unit-map) and rain for
// each unit (GET …/feeds/chirps/from-units), side by side in one table, one
// row per land unit. Each value shows its source and has its own tick,
// unticked until the editor ticks it (or Tick all); Apply sends only the
// ticked units to each proposal's own POST, which re-derives every value on
// the server. Nothing is applied by itself. Pure, so it tests without a page.
import type { UnitMapProposal, UnitRainProposal } from '#lib/api/types.js';
import { fmtNum } from '#lib/format/number.js';
import { unitRainRows } from '../feeds/unitRain';

/** A unit's MAP: offered (a value from the grid, different from its form's), already held, or none (and why). */
export type MapCell = { kind: 'offer'; mapMm: number; current: number | null; coverage: number } | { kind: 'same'; mapMm: number } | { kind: 'none'; reason: string };
/**
 * A unit's rain: a feed to create or update, or one whose record is read again over its parcel's new cells (`replace`,
 * backend 296_feed_area_replace) (`owner` false: only an owner may), already reading it, or none (and why).
 */
export type RainCell = { kind: 'offer'; action: 'create' | 'update' | 'replace'; cellsText: string; owner: boolean } | { kind: 'same'; cellsText: string } | { kind: 'none'; reason: string };

export interface UnitDataRow {
	nodeId: string;
	name: string;
	map: MapCell;
	rain: RainCell;
}

export type UnitTicks = Record<string, { map: boolean; rain: boolean }>;

const NO_POLYGON = 'no boundary or parcel on the map';

/**
 * One row per land unit, in the model's order (`order`, its node ids), from
 * whichever proposals loaded (null: that proposal is unavailable, its cells
 * say why in `unavailable`).
 */
export function unitDataRows(order: readonly { id: string; name: string }[], map: UnitMapProposal | null, rain: UnitRainProposal | null, unavailable = { map: 'not loaded', rain: 'not loaded' }): UnitDataRow[] {
	const mapOf = new Map<string, MapCell>();
	if (map) {
		for (const u of map.units) mapOf.set(u.nodeId, u.same ? { kind: 'same', mapMm: u.mapMm } : { kind: 'offer', mapMm: u.mapMm, current: u.current.mapMm, coverage: u.coveredShare });
		for (const u of map.uncovered) mapOf.set(u.nodeId, { kind: 'none', reason: u.reason });
		for (const u of map.refused) mapOf.set(u.nodeId, { kind: 'none', reason: u.reason });
		for (const u of map.withoutPolygon) mapOf.set(u.nodeId, { kind: 'none', reason: NO_POLYGON });
	}
	const rainOf = new Map<string, RainCell>();
	if (rain) {
		const rows = new Map(unitRainRows(rain, []).map((r) => [r.nodeId, r]));
		for (const u of rain.units) {
			const cellsText = rows.get(u.nodeId)!.cellsText;
			rainOf.set(u.nodeId, u.action === 'none' ? { kind: 'same', cellsText } : { kind: 'offer', action: u.action, cellsText, owner: rain.canApply });
		}
		for (const u of rain.refused) rainOf.set(u.nodeId, { kind: 'none', reason: u.reason });
		for (const u of rain.withoutPolygon) rainOf.set(u.nodeId, { kind: 'none', reason: NO_POLYGON });
	}
	const listed = new Set([...mapOf.keys(), ...rainOf.keys()]);
	return order
		.filter((n) => listed.has(n.id))
		.map((n) => ({
			nodeId: n.id,
			name: n.name,
			map: mapOf.get(n.id) ?? { kind: 'none', reason: map ? 'no loaded MAP grid covers it' : unavailable.map },
			rain: rainOf.get(n.id) ?? { kind: 'none', reason: rain ? 'not proposed' : unavailable.rain }
		}));
}

/** Whether a cell can be ticked: offered, and (for rain) the caller may apply it. */
export const mapTickable = (c: MapCell) => c.kind === 'offer';
export const rainTickable = (c: RainCell) => c.kind === 'offer' && c.owner;

/** The ticks a review opens with: every value unticked. */
export const initialUnitTicks = (rows: readonly UnitDataRow[]): UnitTicks => Object.fromEntries(rows.map((r) => [r.nodeId, { map: false, rain: false }]));

/** Tick every value that can be ticked (Tick all): still the editor's choice, and Apply still asks first. */
export const tickAllUnits = (rows: readonly UnitDataRow[]): UnitTicks => Object.fromEntries(rows.map((r) => [r.nodeId, { map: mapTickable(r.map), rain: rainTickable(r.rain) }]));

/** What Apply sends: the ticked units of each proposal (never a value that wasn't offered). */
export function unitApplyPlan(rows: readonly UnitDataRow[], ticks: UnitTicks): { map: string[]; rain: string[] } {
	return {
		map: rows.filter((r) => ticks[r.nodeId]?.map && mapTickable(r.map)).map((r) => r.nodeId),
		rain: rows.filter((r) => ticks[r.nodeId]?.rain && rainTickable(r.rain)).map((r) => r.nodeId)
	};
}

const units = (n: number) => (n === 1 ? '1 unit' : `${fmtNum(n)} units`);

/** The confirm's words: what each POST will do, with the grid and the product named. */
export function unitApplySummary(plan: { map: string[]; rain: string[] }, map: UnitMapProposal | null, rain: UnitRainProposal | null): string {
	const parts: string[] = [];
	if (plan.map.length && map?.dataset)
		parts.push(`${units(plan.map.length)} ${plan.map.length === 1 ? 'gets its' : 'get their'} MAP from the MAP grid ${map.dataset.label} ${map.dataset.version}, saved straight to the model as one change in History.`);
	if (plan.rain.length && rain) parts.push(`${units(plan.rain.length)} ${plan.rain.length === 1 ? 'gets its own CHIRPS feed' : 'get their own CHIRPS feeds'} (${rain.product}), over ${plan.rain.length === 1 ? 'its' : 'their'} boundary’s cells, recorded as one change in History; the feeds fetch on their schedule.`);
	return parts.join(' ');
}

/** "855 mm" for a MAP, whole mm as the grid gives it. */
export const mmText = (mm: number) => `${fmtNum(mm, 0)} mm`;
