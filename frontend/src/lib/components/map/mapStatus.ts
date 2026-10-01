// Results on the map, the data layer (issue #326 A1, decision D-A1; docs/maps.md
// § Results on the map): one run's figures per node, as a measure, a value, a
// band and words, so a parcel can be coloured and the same figures listed in a
// table beside the map. Pure: no MapLibre, no fetch. Every figure comes from
// the run's summary (GET /projects/:id/runs/:runId), the one the Hydrological
// units page and the Network's colours read, so no series is downloaded.
//
// The bands are the app's existing ones, not new thresholds:
// - days short and curtailment band a share (of demand days met, of demand
//   left) with the supply bands' thresholds (network/supplyColour.ts:
//   SUPPLY_TARGET 95 %, LOW_SUPPLY 70 %);
// - dam level is the Network's "Colour by dam level" (network/farmColour.ts
//   damColouring: 60 % full or more, LOW_PCT 30 %, at its minimum);
// - use against allocation is the Allocations page's status (engine
//   allocationStatus with the run's tolerance, "above registered" in any
//   whole year first, as allocations/allocations.ts unitRows does);
// - an EWR site is met when the run's reporting window has no day not met
//   (summary.curtailment.ewrSites, the curtailment table's EWR sites).
import { allocationStatus, type AllocationStatus, type NetworkNode, type RunSummary } from '@water-management/engine';
import type { MapFeature, Role, RunMeta } from '$lib/api/types';
import { STATUS_LABEL } from '$lib/components/allocations/allocations';
import { LOW_PCT, type DamLevel } from '$lib/components/overview/damLevels';
import { DAM_FULL_PCT, damColouring } from '$lib/components/network/farmColour';
import { LOW_SUPPLY, type SupplyBand } from '$lib/components/network/supplyColour';
import { SUPPLY_TARGET } from '$lib/components/runs/results';
import { fmtNum, fmtPct } from '$lib/format/number';

/** What a hydrological unit's parcel is coloured by. `daysShort` is the default (D-A1). */
export type MapMeasure = 'daysShort' | 'curtailment' | 'damLevel' | 'allocation';

export const MAP_MEASURES: readonly { id: MapMeasure; label: string }[] = [
	{ id: 'daysShort', label: 'Days short' },
	{ id: 'curtailment', label: 'Curtailment' },
	{ id: 'damLevel', label: 'Dam level' },
	{ id: 'allocation', label: 'Use against allocation' }
];

export const DEFAULT_MAP_MEASURE: MapMeasure = 'daysShort';

/** `ok` fine, `watch` worth a look, `short` the worst band, `none` no figure (no demand, no dam, not in the run). */
export type MapBand = 'ok' | 'watch' | 'short' | 'none';

export interface MapStatus {
	nodeId: string;
	/** A unit's measure, or `ewr` for a gauge or the outlet (met or missed). */
	measure: MapMeasure | 'ewr';
	/**
	 * daysShort: demand days not fully met in the reporting window; curtailment:
	 * the cut asked for, m³/day (0 = none); damLevel: % of capacity at the end
	 * of the run; allocation: modelled use ÷ registered volume per whole water
	 * year; ewr: days the EWR was not met in the window. null with band `none`
	 * (and for allocation use with no registered volume).
	 */
	value: number | null;
	band: MapBand;
	/** The figure in words, so a colour is never the only cue. */
	label: string;
}

/** A band's word, for a legend or a table cell beside the colour. */
export const BAND_WORD: Record<MapBand, string> = { ok: 'OK', watch: 'Watch', short: 'Short', none: 'No figure' };

/** The supply bands (supplyColour.ts) on the map's scale: met → ok, short → watch, low → short. */
export function fromSupplyBand(b: SupplyBand): MapBand {
	return b === 'met' ? 'ok' : b === 'short' ? 'watch' : b === 'low' ? 'short' : 'none';
}

/** A share (0–1) banded with the supply thresholds: ≥ SUPPLY_TARGET ok, ≥ LOW_SUPPLY watch, else short. */
export function shareBand(share: number): MapBand {
	if (share >= SUPPLY_TARGET) return 'ok';
	if (share >= LOW_SUPPLY) return 'watch';
	return 'short';
}

/** What the legend says for each band of a measure (`none` covers every "no figure" case). */
export const MEASURE_LEGEND: Record<MapMeasure | 'ewr', Record<MapBand, string>> = {
	daysShort: {
		ok: `${fmtPct(SUPPLY_TARGET, 0)} or more of demand days met`,
		watch: `${fmtPct(LOW_SUPPLY, 0)} to ${fmtPct(SUPPLY_TARGET, 0)} of demand days met`,
		short: `Under ${fmtPct(LOW_SUPPLY, 0)} of demand days met`,
		none: 'No demand days, or not in this run'
	},
	curtailment: {
		ok: `No cut, or ${fmtPct(SUPPLY_TARGET, 0)} or more of demand left`,
		watch: `${fmtPct(LOW_SUPPLY, 0)} to ${fmtPct(SUPPLY_TARGET, 0)} of demand left`,
		short: `Under ${fmtPct(LOW_SUPPLY, 0)} of demand left`,
		none: 'No demand, or not in this run'
	},
	damLevel: {
		ok: `${DAM_FULL_PCT}% full or more`,
		watch: `${LOW_PCT}–${DAM_FULL_PCT}% full`,
		short: `Under ${LOW_PCT}%, or at its minimum`,
		none: 'No dam, or not in this run'
	},
	allocation: {
		ok: `${STATUS_LABEL.within} or ${STATUS_LABEL.under.toLowerCase()}`,
		watch: STATUS_LABEL.unregistered,
		short: STATUS_LABEL.over,
		none: 'No registered volume, or no whole water year'
	},
	ewr: { ok: 'EWR met every day', watch: '', short: 'EWR missed on some days', none: 'Not an EWR site in this run' }
};

type UnitNode = Pick<NetworkNode, 'id' | 'kind' | 'name'> & Partial<Pick<NetworkNode, 'damCapacityM3'>>;
type StatusSummary = Pick<RunSummary, 'farms'> & Partial<Pick<RunSummary, 'supplyAssurance' | 'curtailment' | 'allocations'>>;

const none = (nodeId: string, measure: MapStatus['measure'], label: string): MapStatus => ({ nodeId, measure, value: null, band: 'none', label });
const isUnit = (n: UnitNode) => n.kind === 'farm' || n.kind === 'user';
const days = (n: number) => `${fmtNum(n)} day${n === 1 ? '' : 's'}`;

/** Days short: demand days in the reporting window not fully met (assurance of supply, engine ≥ 0.32.0). */
function daysShortStatuses(units: readonly UnitNode[], s: StatusSummary): MapStatus[] {
	const rel = s.supplyAssurance ? new Map(s.supplyAssurance.reliability.map((r) => [r.nodeId, r])) : null;
	return units.map((n) => {
		if (!rel) return none(n.id, 'daysShort', 'No days-short figures in this run');
		const r = rel.get(n.id);
		if (!r) return none(n.id, 'daysShort', 'Not in this run');
		if (!(r.demandDays > 0)) return none(n.id, 'daysShort', 'No demand days');
		const short = r.demandDays - r.metDays;
		return { nodeId: n.id, measure: 'daysShort', value: short, band: shareBand(r.metDays / r.demandDays), label: `${fmtNum(short)} of ${days(r.demandDays)} short` };
	});
}

/** Curtailment: the cut in supply the curtailment table asks for over the reporting window (hydrological units only). */
function curtailmentStatuses(units: readonly UnitNode[], s: StatusSummary): MapStatus[] {
	const cut = s.curtailment ? new Map(s.curtailment.farms.map((f) => [f.nodeId, f])) : null;
	return units.map((n) => {
		if (!cut) return none(n.id, 'curtailment', 'No curtailment table in this run');
		if (n.kind !== 'farm') return none(n.id, 'curtailment', 'Not in the curtailment table');
		const c = cut.get(n.id);
		if (!c) return none(n.id, 'curtailment', 'Not in this run');
		if (c.fractionOfDemandLeft === null) return none(n.id, 'curtailment', 'No demand');
		const m3 = c.totalChangeM3Day < 0 ? -c.totalChangeM3Day : 0;
		if (m3 === 0) return { nodeId: n.id, measure: 'curtailment', value: 0, band: 'ok', label: 'No cut' };
		return { nodeId: n.id, measure: 'curtailment', value: m3, band: shareBand(c.fractionOfDemandLeft), label: `Cut ${fmtNum(m3)} m³/day, ${fmtPct(c.fractionOfDemandLeft, 0)} of demand left` };
	});
}

/** Dam level: the Network's dam colouring (farmColour.ts), with each dam's end-of-run % as the value. */
function damStatuses(units: readonly UnitNode[], levels: readonly DamLevel[] | null): MapStatus[] {
	if (!levels) return units.map((n) => none(n.id, 'damLevel', 'Dam levels not loaded'));
	const colouring = damColouring(units as readonly NetworkNode[], levels, { name: '', ago: '' }, false);
	const pct = new Map(levels.map((l) => [l.nodeId, l.endPct]));
	return units.map((n) => {
		const c = colouring.byNode.get(n.id);
		if (!c) return none(n.id, 'damLevel', 'No dam');
		const band = fromSupplyBand(c.band);
		const label = c.text.charAt(0).toUpperCase() + c.text.slice(1);
		return { nodeId: n.id, measure: 'damLevel', value: band === 'none' ? null : (pct.get(n.id) ?? null), band, label };
	});
}

const ALLOCATION_RANK: Record<AllocationStatus, number> = { over: 0, unregistered: 1, under: 2, within: 3, none: 4 };
const ALLOCATION_BAND: Record<AllocationStatus, MapBand> = { over: 'short', unregistered: 'watch', under: 'ok', within: 'ok', none: 'none' };

/**
 * Use against allocation: per water source, "above registered" when any whole
 * water year was, else the status of the mean whole year (allocations.ts
 * unitRows); a unit with two sources shows its worse one.
 */
function allocationStatuses(units: readonly UnitNode[], s: StatusSummary): MapStatus[] {
	const a = s.allocations;
	const byNode = a ? new Map(a.nodes.map((x) => [x.nodeId, x])) : null;
	return units.map((n) => {
		if (!a || !byNode) return none(n.id, 'allocation', 'No registered volumes in this run');
		const node = byNode.get(n.id);
		if (!node?.sources.length) return none(n.id, 'allocation', 'No registered volume');
		let worst: { status: AllocationStatus; ratio: number | null; label: string } | null = null;
		for (const src of node.sources) {
			if (src.wholeYears === 0 || src.meanModelledM3PerYear === null || src.meanRegisteredM3PerYear === null) continue;
			const status = src.yearsOver > 0 ? 'over' : allocationStatus(src.meanModelledM3PerYear, src.meanRegisteredM3PerYear, a.tolerance);
			const ratio = src.meanRegisteredM3PerYear > 0 ? src.meanModelledM3PerYear / src.meanRegisteredM3PerYear : null;
			const what = src.waterSource === 'groundwater' ? 'groundwater' : 'surface water';
			const label =
				status === 'over' && src.yearsOver > 0
					? `${STATUS_LABEL.over} in ${src.yearsOver} of ${src.wholeYears} whole year${src.wholeYears === 1 ? '' : 's'} (${what})`
					: `${STATUS_LABEL[status]}${ratio === null ? '' : `, ${fmtPct(ratio, 0)} of registered`} (${what})`;
			if (!worst || ALLOCATION_RANK[status] < ALLOCATION_RANK[worst.status]) worst = { status, ratio, label };
		}
		if (!worst) return none(n.id, 'allocation', 'No whole water year in this run');
		if (worst.status === 'none') return none(n.id, 'allocation', STATUS_LABEL.none);
		return { nodeId: n.id, measure: 'allocation', value: worst.ratio, band: ALLOCATION_BAND[worst.status], label: worst.label };
	});
}

export interface StatusInput {
	/** The model's nodes (today's), for which units and gauges to show. */
	nodes: readonly UnitNode[];
	/** The run's summary. */
	summary: StatusSummary;
	/** Dam levels at the end of the run (overview/damLevels.ts damLevelsFromSummary or loadDamLevels); null until known. */
	damLevels?: readonly DamLevel[] | null;
}

/** Every hydrological unit's and water user's figure for one measure, in model order. */
export function unitStatuses(measure: MapMeasure, input: StatusInput): MapStatus[] {
	const units = input.nodes.filter(isUnit);
	switch (measure) {
		case 'daysShort':
			return daysShortStatuses(units, input.summary);
		case 'curtailment':
			return curtailmentStatuses(units, input.summary);
		case 'damLevel':
			return damStatuses(units, input.damLevels ?? null);
		case 'allocation':
			return allocationStatuses(units, input.summary);
	}
}

/**
 * Each gauge's EWR, met or missed over the reporting window, and the outlet's
 * when the outlet is a node of the model: one status per gauge node and per
 * EWR site (outlet first, as the run lists them). A gauge the run has no site
 * for is `none`.
 */
export function ewrStatuses(input: Pick<StatusInput, 'nodes' | 'summary'>): MapStatus[] {
	const sites = input.summary.curtailment?.ewrSites ?? null;
	const out: MapStatus[] = [];
	const seen = new Set<string>();
	for (const site of sites ?? []) {
		seen.add(site.nodeId);
		const missed = site.daysNotMet > 0;
		const where = site.isOutlet ? 'outlet' : 'gauge';
		out.push({
			nodeId: site.nodeId,
			measure: 'ewr',
			value: site.daysNotMet,
			band: missed ? 'short' : 'ok',
			label: missed ? `EWR missed on ${days(site.daysNotMet)} (${where})` : `EWR met every day (${where})`
		});
	}
	for (const n of input.nodes)
		if (n.kind === 'gauge' && !seen.has(n.id)) out.push(none(n.id, 'ewr', sites ? MEASURE_LEGEND.ewr.none : 'No EWR figures in this run'));
	return out;
}

// --- which run the map shows (D-A1) ---

const EDITORS: readonly Role[] = ['editor', 'owner'];

/** The runs a person may show on the map: every run for an editor or owner, only the published one below. */
export function mapRuns(runs: readonly RunMeta[], role: Role): RunMeta[] {
	return EDITORS.includes(role) ? [...runs] : runs.filter((r) => r.published === true);
}

export interface MapRunChoice {
	run: RunMeta | null;
	/** `picked` the run the editor chose, `published` the current publication's, `newest` an editor's newest run when nothing is published, `none` nothing to show. */
	from: 'picked' | 'published' | 'newest' | 'none';
}

const newestFirst = (runs: readonly RunMeta[]) =>
	[...runs].map((r, i) => ({ r, i, t: Date.parse(r.createdAt) })).sort((a, b) => (Number.isNaN(b.t) ? -Infinity : b.t) - (Number.isNaN(a.t) ? -Infinity : a.t) || a.i - b.i).map((x) => x.r);

/**
 * The run the map is coloured from: the published run for everyone by default;
 * an editor may pick any run (`picked`, e.g. from `run=` in the URL), and sees
 * their newest run when nothing is published. Below editor a pick of an
 * unpublished run is ignored, and nothing published means nothing to show.
 */
export function chooseMapRun(runs: readonly RunMeta[], role: Role, picked: string | null = null): MapRunChoice {
	const allowed = mapRuns(runs, role);
	const p = picked ? allowed.find((r) => r.id === picked) : undefined;
	if (p) return { run: p, from: p.published ? 'published' : 'picked' };
	const ordered = newestFirst(allowed);
	const pub = ordered.find((r) => r.published === true);
	if (pub) return { run: pub, from: 'published' };
	if (EDITORS.includes(role) && ordered.length) return { run: ordered[0], from: 'newest' };
	return { run: null, from: 'none' };
}

// --- the fill colours ---

/** Each band's design token (app.css), the same family the schematic and the node card use. */
export const BAND_TOKEN: Record<MapBand, string> = { ok: '--success', watch: '--warning', short: '--danger', none: '--text-muted' };

/** A token's value now, from <html>'s computed style (follows data-theme and the OS theme). */
export function readToken(token: string, root: Element = document.documentElement): string {
	return getComputedStyle(root).getPropertyValue(token).trim();
}

/**
 * Each feature's fill, by feature id, for CatchmentMap's `fills` prop: a
 * feature linked to a node with a status takes its band's token colour. The
 * boundary and rivers are never filled. `resolve` turns a token into a CSS
 * colour MapLibre can read (default readToken; re-run it when the theme
 * changes, appTheme.ts watchAppTheme). A token that resolves to '' is left out.
 */
export function bandFills(
	features: readonly Pick<MapFeature, 'id' | 'kind' | 'nodeId'>[],
	statuses: readonly MapStatus[],
	resolve: (token: string) => string = (t) => readToken(t)
): Record<string, string> {
	const band = new Map(statuses.map((s) => [s.nodeId, s.band]));
	const colour = new Map<MapBand, string>();
	const out: Record<string, string> = {};
	for (const f of features) {
		if (!f.nodeId || f.kind === 'catchment_boundary' || f.kind === 'river') continue;
		const b = band.get(f.nodeId);
		if (!b) continue;
		if (!colour.has(b)) colour.set(b, resolve(BAND_TOKEN[b]));
		const c = colour.get(b)!;
		if (c) out[f.id] = c;
	}
	return out;
}
