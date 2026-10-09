// Settings → Data feeds → Rain for each unit (issue #482, docs/ui.md § Data
// feeds, docs/maps.md § Rain for each unit): the per-unit CHIRPS proposal
// (GET …/feeds/chirps/from-units) in words, and the checks on the panel's
// product and start date. Pure, so they test without a page.
import type { UnitRainApplyBody, UnitRainApplyResult, UnitRainProduct, UnitRainProposal, UnitRainProposalUnit } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';
import { CHIRPS_PRODUCT_FIRST_DAY, healthMessage, STATE_LABELS, type FeedMeta, type FeedState } from './feeds';

/** The product a new set of unit feeds reads unless the owner picks the other: rnl, the record from 1981 (provisional, issue #482 question 3; the server's DEFAULT_UNIT_PRODUCT). */
export const UNIT_RAIN_DEFAULT_PRODUCT: UnitRainProduct = 'rnl';

const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;

/** A unit's row in the panel: its cells and its feed's state, read from the feeds list. */
export interface UnitRainRow {
	nodeId: string;
	name: string;
	areaKm2: number;
	cells: number;
	/** "3 cells, 62 % of their area inside": how much of the cells the parcel covers. */
	cellsText: string;
	/** null: no feed yet (Create makes one). */
	feed: { id: string; state: FeedState; label: string; health: string } | null;
	seriesDays: number;
}

/** The share of the cells' area inside the parcel: each cell's share, weighted by its area (∝ cos latitude on the 0.05° grid). */
function insideShare(u: Pick<UnitRainProposalUnit, 'cells'>): number | null {
	if (!u.cells.length) return null;
	const area = (lat: number) => Math.cos((lat * Math.PI) / 180);
	const all = u.cells.reduce((t, c) => t + area(c.lat), 0);
	return u.cells.reduce((t, c) => t + c.share * area(c.lat), 0) / all;
}

export function unitRainRows(p: Pick<UnitRainProposal, 'units'>, feeds: readonly Pick<FeedMeta, 'id' | 'health'>[]): UnitRainRow[] {
	return p.units.map((u) => {
		const f = u.feedId ? feeds.find((x) => x.id === u.feedId) : undefined;
		const inside = insideShare(u);
		return {
			nodeId: u.nodeId,
			name: u.name,
			areaKm2: u.areaKm2,
			cells: u.cells.length,
			cellsText: `${plural(u.cells.length, 'cell')}${inside === null ? '' : `, ${fmtNum(inside * 100, 0)} % of their area inside`}`,
			// A feed the list doesn't hold yet (made a moment ago, or removed elsewhere) reads as waiting until Refresh.
			feed: u.feedId
				? f
					? { id: f.id, state: f.health.state, label: STATE_LABELS[f.health.state], health: healthMessage(f.health) }
					: { id: u.feedId, state: 'pending', label: STATE_LABELS.pending, health: 'Not in the feeds list yet: refresh the status.' }
				: null,
			seriesDays: u.seriesDays
		};
	});
}

/** Rank of a row: the units that need something first (no feed, failing, stale), then the rest, each in the server's order. */
const NEEDS: Record<string, number> = { none: 0, failing: 1, stale: 2, pending: 3, disabled: 4, ok: 5 };
export const sortUnitRows = (rows: readonly UnitRainRow[]): UnitRainRow[] =>
	rows
		.map((r, i) => ({ r, i }))
		.sort((a, b) => (NEEDS[a.r.feed?.state ?? 'none'] ?? 9) - (NEEDS[b.r.feed?.state ?? 'none'] ?? 9) || a.i - b.i)
		.map((x) => x.r);

/**
 * What the button does, from each unit's action: create the missing feeds,
 * give the empty ones new cells or the product, or both. Null when nothing
 * would change (every unit's feed reads its parcel already, or no unit).
 */
export function unitRainAction(p: Pick<UnitRainProposal, 'units'>): { label: string; words: string } | null {
	const make = p.units.filter((u) => u.action === 'create').length;
	const update = p.units.filter((u) => u.action === 'update').length;
	if (!make && !update) return null;
	if (!update) return { label: make === 1 ? 'Create the feed' : `Create ${fmtNum(make)} feeds`, words: `Creates ${plural(make, 'CHIRPS feed')}, one into each unit’s own rain series.` };
	if (!make)
		return {
			label: update === 1 ? 'Update the feed' : `Update ${fmtNum(update)} feeds`,
			words: `Gives ${update === 1 ? 'the unit’s feed' : `${fmtNum(update)} units’ feeds`} the cells of ${update === 1 ? 'its parcel' : 'their parcels'} as ${update === 1 ? 'it is' : 'they are'} now, and the product; their series hold no days yet, so nothing is spliced.`
		};
	return {
		label: `Create ${fmtNum(make)}, update ${fmtNum(update)}`,
		words: `Creates ${plural(make, 'CHIRPS feed')} for the units without one, and gives ${plural(update, 'empty feed')} the cells of their parcels as they are now, and the product.`
	};
}

/** Every proposed unit's feed already reads its parcel with this product. */
export const unitRainUpToDate = (p: Pick<UnitRainProposal, 'units'>) => p.units.length > 0 && p.units.every((u) => u.action === 'none');

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day (2001-02-30 isn't), read as UTC so no time zone moves it. */
const isCalendarDay = (d: string) => ISO_DAY.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** The POST body for the panel's choices, or the start date's problem in words. */
export function unitRainBody(product: UnitRainProduct, startDate: string, nodeIds?: readonly string[]): { body: UnitRainApplyBody } | { error: string } {
	const start = startDate.trim();
	const first = CHIRPS_PRODUCT_FIRST_DAY[product];
	if (start && !isCalendarDay(start)) return { error: 'The start date should be a day, YYYY-MM-DD.' };
	if (start && start < first)
		return { error: product === 'sat' ? `The sat product begins on ${first}. For earlier days choose rnl, which reads 1981 onwards.` : `CHIRPS begins on ${first}.` };
	return { body: { product, ...(start ? { startDate: start } : {}), ...(nodeIds ? { nodeIds: [...nodeIds] } : {}) } };
}

/** "Created 3 feeds and updated 1 feed. …" from the POST's answer, with how many units it left out. */
export function appliedWords(r: Pick<UnitRainApplyResult, 'created' | 'updated' | 'skipped'>): string {
	const parts = [r.created ? `created ${plural(r.created, 'feed')}` : null, r.updated ? `updated ${plural(r.updated, 'feed')}` : null].filter(Boolean);
	const skipped = r.skipped?.length ? ` ${plural(r.skipped.length, 'unit')} left out: see below.` : '';
	if (!parts.length) return `Nothing to change: every unit’s feed already reads its parcel.${skipped}`;
	const s = parts.join(' and ');
	return `${s.charAt(0).toUpperCase()}${s.slice(1)}. They run on the next schedule, or now with “Run now” on each feed.${skipped}`;
}
