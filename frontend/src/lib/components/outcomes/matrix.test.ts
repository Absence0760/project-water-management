import { toEpochDay } from '@water-management/engine';
import type { RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { OutcomeSettings, Sweep, SweepMember } from '$lib/api/types';
import {
	boundsText,
	buildMatrixView,
	chooseSite,
	demandLevelOf,
	demandSweepRequest,
	isDemandSweep,
	latestDemandSweep,
	matrixSites,
	memberRun,
	metricLabel,
	OUTLET_SITE,
	parseDemandLevels,
	sweepState,
	toNaN,
	type MatrixSite,
	type MatrixView
} from './matrix';
import { OUTCOME_DEFAULTS, outcomesError, resolveOutcomes } from './outcomeSettings';

// Synthetic: nine complete water years from 1 Oct 2010, each day's natural
// flow the year's own constant, so the annual totals rank 1 … 9 (dry to wet).
const START = '2010-10-01';
const YEARS = 9;
const yearStarts = Array.from({ length: YEARS + 1 }, (_, i) => toEpochDay(`${2010 + i}-10-01`) - toEpochDay(START));
const DAYS = yearStarts[YEARS]!;
const yearOf = (t: number) => yearStarts.findIndex((s, i) => t >= s && t < yearStarts[i + 1]!);
/** Year i's flow: 1000 × (i + 1) m³/day; wetter every year. */
const natural = Array.from({ length: DAYS }, (_, t) => 1000 * (yearOf(t) + 1));

/** ewr_shortfall with `share(year)` of each year's days below the EWR (negative), the rest 0. */
function shortfall(share: (year: number) => number): (number | null)[] {
	return Array.from({ length: DAYS }, (_, t) => {
		const y = yearOf(t);
		const len = yearStarts[y + 1]! - yearStarts[y]!;
		return t - yearStarts[y]! < Math.round(share(y) * len) ? -50 : 0;
	});
}

const summary = (extra: Record<string, unknown> = {}) => ({ ...extra }) as unknown as RunSummary;

function member(position: number, name: string, over: Partial<SweepMember> = {}, below: (y: number) => number = () => 0): SweepMember {
	return {
		id: `m${position}`,
		position,
		name,
		ops: [{ op: 'demand.scale', factor: 1 }],
		opsSha256: '0'.repeat(64),
		status: 'done',
		problems: [],
		startDate: START,
		endDate: null,
		finishedAt: null,
		summary: summary(),
		series: [
			{ nodeId: null, key: 'natural_flow', label: 'Natural flow', unit: 'm³/day', values: natural },
			{ nodeId: null, key: 'ewr_shortfall', label: 'EWR shortfall', unit: 'm³/day', values: shortfall(below) }
		],
		...over
	};
}

const settings = (o: Partial<OutcomeSettings> = {}): OutcomeSettings => ({ ...resolveOutcomes({}), ...o });
const view = (members: SweepMember[], s: OutcomeSettings = settings(), baseNatural: (number | null)[] = natural, site?: MatrixSite): MatrixView =>
	buildMatrixView({ baseStartDate: START, baseNatural, members, settings: s, site });
const cellsOf = (v: MatrixView, i: number) => {
	const r = v.rows[i]!;
	if (r.kind !== 'cells') throw new Error(`row ${i} has no cells`);
	return r.cells;
};

describe('the adapter: stored sweep members → the engine', () => {
	it('maps stored nulls back to NaN, and refuses a member with no stored run', () => {
		expect(toNaN([1, null, 0])).toEqual([1, Number.NaN, 0]);
		const m = member(0, '100 %');
		m.series![1]!.values[3] = null;
		const run = memberRun(m);
		expect(run.startDate).toBe(START);
		expect(Number.isNaN(run.series[1]!.values[3]!)).toBe(true);
		expect(run.series[1]!.values[4]).toBe(0);
		expect(() => memberRun(member(1, 'x', { status: 'problems', summary: null, series: null }))).toThrow(/no stored run/);
	});

	it('a missing day in the base natural flow drops that water year from the classes (not a dry year)', () => {
		const withGap = [...natural] as (number | null)[];
		withGap[yearStarts[4]! + 10] = null;
		const v = view([member(0, '100 %')], settings(), withGap);
		expect(v.nYears).toBe(8);
		expect(v.excluded).toEqual([{ waterYear: 2014, label: '2014/15', reason: 'missingDays' }]);
		expect(v.columns.reduce((s, c) => s + c.nYears, 0)).toBe(8);
	});
});

describe('buildMatrixView', () => {
	it('columns: terciles of the base run with n years and bounds in m³, rows in sweep order', () => {
		const v = view([member(1, '85 %'), member(0, '100 %')]);
		expect(v.method).toBe('terciles');
		expect(v.nYears).toBe(YEARS);
		expect(v.columns.map((c) => [c.label, c.nYears])).toEqual([
			['Dry', 3],
			['Normal', 3],
			['Wet', 3]
		]);
		expect(v.columns[0]!.bounds).toMatch(/^≤ [\d\u202f]+ m³$/);
		expect(v.columns[1]!.bounds).toMatch(/^[\d\u202f]+ – [\d\u202f]+ m³$/);
		expect(v.columns[2]!.bounds).toMatch(/^> [\d\u202f]+ m³$/);
		expect(v.rows.map((r) => r.label)).toEqual(['100 %', '85 %']);
		expect(v.metric).toBe('daysBelowEwr');
		expect(v.metricLabel).toBe('Days below the pragmatic EWR at the outlet');
		expect(metricLabel('daysBelowEwr', undefined, { method: 'tab' })).toBe('Days below the daily EWR from the DRM TAB file at the outlet');
	});

	it('colours by the default cut-offs (5 % / 20 % of days), marked pending the hydrologist', () => {
		// Dry years 10 % of days below the EWR, normal 30 %, wet none.
		const v = view([member(0, '100 %', {}, (y) => (y < 3 ? 0.1 : y < 6 ? 0.3 : 0))]);
		expect(cellsOf(v, 0).map((c) => c.risk)).toEqual(['increasing', 'high', 'lower']);
		expect(cellsOf(v, 0).map((c) => c.riskLabel)).toEqual(['Increasing risk', 'High risk', 'Lower risk']);
		expect(cellsOf(v, 0)[2]!.text).toBe('EWR met on every day in 3 of 3 wet years (below it on 0 % of days).');
		expect(cellsOf(v, 0)[0]!.text).toBe('EWR met on every day in 0 of 3 dry years (below it on 10 % of days).');
		expect(v.cutoffsPending).toBe(true);
		expect(v.cutoffsText).toBe('Lower risk: below the EWR on at most 5 % of days. Increasing risk: at most 20 %. High risk: more than that.');
	});

	it('custom cut-offs recolour the same cells and drop the pending mark', () => {
		const s = settings({ riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: { lower: 0.15, increasing: 0.4 } } });
		const v = view([member(0, '100 %', {}, (y) => (y < 3 ? 0.1 : y < 6 ? 0.3 : 0))], s);
		expect(cellsOf(v, 0).map((c) => c.risk)).toEqual(['lower', 'increasing', 'lower']);
		expect(v.cutoffsPending).toBe(false);
		expect(v.cutoffsText).toBe('Lower risk: below the EWR on at most 15 % of days. Increasing risk: at most 40 %. High risk: more than that.');
	});

	it('quintiles on 9 years: classes under 3 years say "not enough years", uncoloured', () => {
		const v = view([member(0, '100 %')], settings({ yearClassMethod: 'quintiles' }));
		expect(v.method).toBe('quintiles');
		expect(v.columns.map((c) => c.label)).toEqual(['Very dry', 'Dry', 'Normal', 'Wet', 'Very wet']);
		const cells = cellsOf(v, 0);
		const thin = cells.filter((c) => c.nYears < 3);
		expect(thin.length).toBeGreaterThan(0);
		for (const c of thin) {
			expect(c.risk).toBeNull();
			expect(c.riskLabel).toBe('Not enough years');
			expect(c.text).toMatch(/not enough years to judge\.$/);
		}
		expect(v.warnings.some((w) => /fewer than 3 years/.test(w))).toBe(true);
	});

	it('members with problems or that failed are rows saying why; the others still fill in', () => {
		const v = view([
			member(0, '100 %'),
			member(1, '85 %', { status: 'problems', problems: ['op 1 (demand.scale): no farm to scale'], summary: null, series: null }),
			member(2, '70 %', { status: 'failed', problems: ['model run failed: over-allocated'], summary: null, series: null })
		]);
		expect(v.rows.map((r) => r.kind)).toEqual(['cells', 'notRun', 'notRun']);
		expect(v.rows[1]).toMatchObject({ status: 'problems', lines: ['op 1 (demand.scale): no farm to scale'] });
		expect(v.rows[2]).toMatchObject({ status: 'failed', lines: ['model run failed: over-allocated'] });
	});

	it('every member failing still shows the columns, with no metric and no pending mark', () => {
		const v = view([member(0, '100 %', { status: 'failed', problems: ['model run failed: x'], summary: null, series: null })]);
		expect(v.columns).toHaveLength(3);
		expect(v.metric).toBeNull();
		expect(v.cutoffsPending).toBe(false);
		expect(v.rows[0]!.kind).toBe('notRun');
	});

	it('uses Reserve months met when every level has a rule table at the outlet; pending follows that metric', () => {
		// One month per water year, met in the wet years only.
		const months = Array.from({ length: YEARS }, (_, y) => ({ waterYear: 2010 + y, met: y >= 6 }));
		const withTable = () => ({ summary: summary({ ewrAssurance: [{ nodeId: null, isOutlet: true, months }] }) });
		const custom = settings({ riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: { lower: 0.1, increasing: 0.3 } } });
		const v = view([member(0, '100 %', withTable()), member(1, '85 %', withTable())], custom);
		expect(v.metric).toBe('reserveMonthsMet');
		expect(v.metricLabel).toBe('Reserve months met (the rule table at the outlet)');
		expect(cellsOf(v, 0).map((c) => c.risk)).toEqual(['high', 'high', 'lower']);
		expect(cellsOf(v, 0)[2]!.text).toBe('Reserve met in every month in 3 of 3 wet years (100 % of months met).');
		// Only the days metric was set: the months metric's cut-offs are still the placeholders.
		expect(v.cutoffsPending).toBe(true);
		const both = view([member(0, '100 %', withTable())], settings({ riskCutoffs: { reserveMonthsMet: { lower: 0.95, increasing: 0.5 }, daysBelowEwr: null } }));
		expect(both.cutoffsPending).toBe(false);
	});

	it('a base run with no complete water year: no columns, and a warning that says why', () => {
		const v = view([member(0, '100 %')], settings(), natural.slice(0, 200));
		expect(v.nYears).toBe(0);
		expect(v.warnings).toContain('The base run has no complete water year (1 October to 30 September), so its years cannot be classed.');
	});

	it('never words a result as the app choosing a level', () => {
		const v = view([member(0, '100 %', {}, () => 0.1), member(1, '85 %'), member(2, '70 %', { status: 'problems', problems: ['p'], summary: null, series: null })]);
		const words = JSON.stringify(v);
		expect(words).not.toMatch(/recommend|likely|should|best|optimal/i);
	});
});

describe('the Reserve site', () => {
	// Outlet ← upper gauge ← farm, and a lower gauge; invented names.
	const nodes = [
		{ id: 'out', name: 'Outflow gauge', kind: 'gauge', downstreamNodeId: null, sortOrder: 1 },
		{ id: 'lower', name: 'Lower gauge', kind: 'gauge', downstreamNodeId: 'out', sortOrder: 5 },
		{ id: 'upper', name: 'Upper gauge', kind: 'gauge', downstreamNodeId: 'out', sortOrder: 3 },
		{ id: 'farm', name: 'Farm', kind: 'farm', downstreamNodeId: 'upper', sortOrder: 2 }
	] as const;
	const upperSite: MatrixSite = { id: 'upper', label: 'Gauge: Upper gauge', where: 'gauge Upper gauge' };
	/** One month per water year at each site: the outlet met every year, the upper gauge only in the wet years. */
	const assurance = (sites: ('outlet' | 'upper')[]) =>
		sites.map((k) => ({
			nodeId: k === 'outlet' ? null : 'upper',
			isOutlet: k === 'outlet',
			months: Array.from({ length: YEARS }, (_, y) => ({ waterYear: 2010 + y, met: k === 'outlet' || y >= 6 }))
		}));
	const at = (sites: ('outlet' | 'upper')[]) => ({ summary: summary({ ewrAssurance: assurance(sites) }) });

	it('offers the outlet, then each gauge above it with a rule table, in network order; never a farm or a gauge without a table', () => {
		const tables = [{ siteNodeId: null }, { siteNodeId: 'lower' }, { siteNodeId: 'upper' }, { siteNodeId: 'farm' }];
		expect(matrixSites(nodes, tables)).toEqual([
			{ id: null, label: 'Outlet (Outflow gauge)', where: 'the outlet' },
			upperSite,
			{ id: 'lower', label: 'Gauge: Lower gauge', where: 'gauge Lower gauge' }
		]);
		expect(matrixSites(nodes, [{ siteNodeId: 'upper' }]).map((x) => x.id)).toEqual([null, 'upper']);
		// A table keyed by the outlet node is the outlet's (the engine's rule), not a second site.
		expect(matrixSites(nodes, [{ siteNodeId: 'out' }]).map((x) => x.id)).toEqual([null]);
		expect(matrixSites(nodes, undefined).map((x) => x.id)).toEqual([null]);
		expect(matrixSites([], [])).toEqual([{ ...OUTLET_SITE, label: 'Outlet' }]);
	});

	it('keeps an eligible stored site, and falls back to the outlet, saying so, for one that is not eligible any more', () => {
		const sites = matrixSites(nodes, [{ siteNodeId: 'upper' }]);
		expect(chooseSite(null, sites)).toEqual({ site: sites[0], notice: null });
		expect(chooseSite(undefined, sites)).toEqual({ site: sites[0], notice: null });
		expect(chooseSite('upper', sites)).toEqual({ site: upperSite, notice: null });
		const gone = chooseSite('lower', sites);
		expect(gone.site.id).toBeNull();
		expect(gone.notice).toBe('The Reserve site chosen for this matrix no longer has a rule table (or is no longer in the network), so the matrix reads the outlet.');
	});

	it('at a gauge, reads that gauge’s Reserve months, not the outlet’s, and names the gauge in the measure', () => {
		const members = [member(0, '100 %', at(['outlet', 'upper'])), member(1, '85 %', at(['outlet', 'upper']))];
		const outlet = view(members);
		expect(outlet.metric).toBe('reserveMonthsMet');
		expect(outlet.metricLabel).toBe('Reserve months met (the rule table at the outlet)');
		expect(cellsOf(outlet, 0).map((c) => c.risk)).toEqual(['lower', 'lower', 'lower']);
		const gauge = view(members, settings(), natural, upperSite);
		expect(gauge.site).toEqual(upperSite);
		expect(gauge.siteMissing).toBeNull();
		expect(gauge.metric).toBe('reserveMonthsMet');
		expect(gauge.metricLabel).toBe('Reserve months met (the rule table at gauge Upper gauge)');
		expect(cellsOf(gauge, 0).map((c) => c.risk)).toEqual(['high', 'high', 'lower']);
		expect(cellsOf(gauge, 1)[0]!.text).toBe('Reserve met in every month in 0 of 3 dry years (0 % of months met).');
	});

	it('switches metric with the site: the outlet without a table falls back to days below the EWR; a gauge never does', () => {
		// Only the gauge has a table, and days below the EWR are all over the dry years.
		const members = [member(0, '100 %', at(['upper']), (y) => (y < 3 ? 0.5 : 0))];
		const outlet = view(members);
		expect(outlet.metric).toBe('daysBelowEwr');
		expect(outlet.metricLabel).toBe(metricLabel('daysBelowEwr'));
		expect(cellsOf(outlet, 0)[0]!.risk).toBe('high');
		const gauge = view(members, settings(), natural, upperSite);
		expect(gauge.metric).toBe('reserveMonthsMet');
		expect(cellsOf(gauge, 0).map((c) => c.risk)).toEqual(['high', 'high', 'lower']);
		expect(metricLabel('daysBelowEwr', upperSite)).toBe('Days below the pragmatic EWR at the outlet');
	});

	it('a sweep without the gauge’s results says to run a new one, with no rows and no metric, never the outlet’s numbers', () => {
		const v = view([member(0, '100 %', at(['outlet'])), member(1, '85 %', at(['outlet']))], settings(), natural, upperSite);
		expect(v.siteMissing).toBe(
			'This sweep has no Reserve results at gauge Upper gauge: its base run was made before that gauge had a rule table. Run the model again, then run a new demand sweep of the new run.'
		);
		expect(v.rows).toEqual([]);
		expect(v.metric).toBeNull();
		expect(v.metricLabel).toBeNull();
		expect(v.cutoffsPending).toBe(false);
		// Only some members with it: still missing (rows would not compare).
		const partial = view([member(0, '100 %', at(['upper'])), member(1, '85 %', at(['outlet']))], settings(), natural, upperSite);
		expect(partial.siteMissing).not.toBeNull();
		expect(partial.rows).toEqual([]);
	});
});

describe('demand levels', () => {
	it('parses a typed list in its order, with or without %, and refuses duplicates, out-of-range and too many', () => {
		expect(parseDemandLevels('100, 85, 70')).toEqual({ levels: [100, 85, 70], error: null });
		expect(parseDemandLevels(' 100%  92.5 ; 60 ')).toEqual({ levels: [100, 92.5, 60], error: null });
		expect(parseDemandLevels('').error).toMatch(/at least one/);
		expect(parseDemandLevels('100, 100').error).toBe('100 % is listed twice.');
		expect(parseDemandLevels('100, 201').error).toMatch(/“201” is not a level from 0 to 200 %/);
		expect(parseDemandLevels('abc').error).toMatch(/“abc”/);
		expect(parseDemandLevels(Array.from({ length: 13 }, (_, i) => 100 - i).join(',')).error).toMatch(/at most 12/);
	});

	it('builds one demand.scale member per level, and reads a member back as its level', () => {
		const req = demandSweepRequest('run-1', [100, 85, 70]);
		expect(req).toEqual({
			name: 'Demand levels 100 % / 85 % / 70 %',
			baseRunId: 'run-1',
			members: [
				{ name: '100 %', ops: [{ op: 'demand.scale', factor: 1 }] },
				{ name: '85 %', ops: [{ op: 'demand.scale', factor: 0.85 }] },
				{ name: '70 %', ops: [{ op: 'demand.scale', factor: 0.7 }] }
			]
		});
		expect(req.members.map(demandLevelOf)).toEqual([100, 85, 70]);
		expect(demandLevelOf({ ops: [] })).toBeNull();
		expect(demandLevelOf({ ops: [{ op: 'demand.scale', factor: 0.9, months: [1] }] })).toBeNull();
		expect(demandLevelOf({ ops: [{ op: 'demand.scale', factor: 0.9, category: 'user' }] })).toBeNull();
		expect(demandLevelOf({ ops: [{ op: 'demand.scale', factor: 0.9, category: 'farm' }] })).toBe(90);
	});

	it('picks the newest demand sweep, skipping other sweeps', () => {
		const other = { id: 'o', members: [{ ops: [{ op: 'series.scale', factor: 1 }] }] } as unknown as Sweep;
		const demand = { id: 'd', members: [{ ops: [{ op: 'demand.scale', factor: 1 }] }] } as unknown as Sweep;
		expect(isDemandSweep(other)).toBe(false);
		expect(latestDemandSweep([other, demand])?.id).toBe('d');
		expect(latestDemandSweep([other])).toBeNull();
	});
});

describe('sweepState (from the sweep and its job, never a timer)', () => {
	const job = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'j', status, error: null, progress: null, ...extra }) as Sweep['job'];
	it('reads queued, running with progress, a retry, dead with its reason, a purged job, and complete', () => {
		expect(sweepState({ status: 'pending', job: job('queued') })).toEqual({ kind: 'pending', text: 'Queued: waiting for the background worker.', progress: null });
		expect(sweepState({ status: 'pending', job: job('running', { progress: 33 }) })).toEqual({ kind: 'pending', text: 'Running the demand levels…', progress: 33 });
		expect(sweepState({ status: 'pending', job: job('failed', { error: 'lease lost' }) }).kind).toBe('pending');
		expect(sweepState({ status: 'pending', job: job('dead', { error: 'the base run can no longer be rebuilt' }) })).toEqual({
			kind: 'stuck',
			text: 'This sweep could not run: the base run can no longer be rebuilt'
		});
		expect(sweepState({ status: 'pending', job: null }).kind).toBe('stuck');
		expect(sweepState({ status: 'complete', job: job('done') })).toEqual({ kind: 'complete' });
	});
});

describe('outcome settings (frontend)', () => {
	it('resolves an older API to the defaults, and checks cut-offs with the engine', () => {
		expect(resolveOutcomes({})).toEqual(OUTCOME_DEFAULTS);
		expect(outcomesError(OUTCOME_DEFAULTS)).toBeNull();
		expect(outcomesError({ yearClassMethod: 'auto', riskCutoffs: { reserveMonthsMet: { lower: 0.5, increasing: 0.9 }, daysBelowEwr: null } })).toMatch(/^Reserve months met/);
		expect(outcomesError({ yearClassMethod: 'auto', riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: { lower: 0.5, increasing: 0.2 } } })).toMatch(/^Days below the EWR/);
		expect(outcomesError({ yearClassMethod: 'auto', riskCutoffs: { reserveMonthsMet: { lower: 1.5, increasing: 0.2 }, daysBelowEwr: null } })).toMatch(/^Reserve months met/);
	});

	it('boundsText covers the open ends', () => {
		expect(boundsText({ lowerM3: null, upperM3: 1_000_000 })).toBe('≤ 1\u202f000\u202f000 m³');
		expect(boundsText({ lowerM3: 1_000_000, upperM3: null })).toBe('> 1\u202f000\u202f000 m³');
		expect(boundsText({ lowerM3: null, upperM3: null })).toBe('all years');
	});
});
