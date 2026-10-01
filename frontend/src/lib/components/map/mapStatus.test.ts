// Results on the map, the data layer (mapStatus.ts, issue #326 A1): each
// measure's figure and band per node, the gauges' EWR, which run the map shows
// for each role, and the fill colours.
import { describe, expect, it } from 'vitest';
import type { CurtailmentFarm, EwrSiteSummary, FarmSummary, RunAllocations, RunSummary, SupplyReliability } from '@water-management/engine';
import type { RunMeta } from '$lib/api/types';
import type { DamLevel } from '$lib/components/overview/damLevels';
import {
	BAND_TOKEN,
	bandFills,
	chooseMapRun,
	DEFAULT_MAP_MEASURE,
	ewrStatuses,
	fromSupplyBand,
	MAP_MEASURES,
	MEASURE_LEGEND,
	mapRuns,
	shareBand,
	unitStatuses,
	type MapStatus,
	type StatusInput
} from './mapStatus';

const farm = (id: string, damCapacityM3 = 0) => ({ id, kind: 'farm' as const, name: id.toUpperCase(), damCapacityM3 });
const nodes: StatusInput['nodes'] = [farm('a', 100_000), farm('b', 100_000), farm('c', 100_000), farm('d'), { id: 'u', kind: 'user', name: 'Town' }, { id: 'g1', kind: 'gauge', name: 'G1' }, { id: 'g2', kind: 'gauge', name: 'G2' }];

const rel = (nodeId: string, demandDays: number, metDays: number, kind: 'farm' | 'user' = 'farm') => ({ nodeId, name: nodeId, kind, demandDays, metDays }) as SupplyReliability;
const cut = (nodeId: string, totalChangeM3Day: number, fractionOfDemandLeft: number | null) => ({ nodeId, name: nodeId, totalChangeM3Day, fractionOfDemandLeft }) as CurtailmentFarm;
const site = (nodeId: string, daysNotMet: number, isOutlet = false) => ({ nodeId, name: nodeId, isOutlet, daysNotMet }) as EwrSiteSummary;

const summary = (over: Partial<RunSummary> = {}): StatusInput['summary'] => ({ farms: [] as FarmSummary[], ...over }) as StatusInput['summary'];
const by = (s: MapStatus[]) => new Map(s.map((x) => [x.nodeId, x]));

describe('the measures', () => {
	it('lists the four measures with days short first, the default (D-A1)', () => {
		expect(MAP_MEASURES.map((m) => m.id)).toEqual(['daysShort', 'curtailment', 'damLevel', 'allocation']);
		expect(DEFAULT_MAP_MEASURE).toBe('daysShort');
	});

	it('maps the supply bands onto the map scale and bands a share with the supply thresholds (95 %, 70 %)', () => {
		expect([fromSupplyBand('met'), fromSupplyBand('short'), fromSupplyBand('low'), fromSupplyBand('none'), fromSupplyBand('absent')]).toEqual(['ok', 'watch', 'short', 'none', 'none']);
		expect([shareBand(1), shareBand(0.95), shareBand(0.9499), shareBand(0.7), shareBand(0.6999), shareBand(0)]).toEqual(['ok', 'ok', 'watch', 'watch', 'short', 'short']);
	});

	it('has legend words for every band of every measure but a missed-only EWR watch', () => {
		for (const m of [...MAP_MEASURES.map((x) => x.id), 'ewr'] as const)
			for (const b of ['ok', 'short', 'none'] as const) expect(MEASURE_LEGEND[m][b]).not.toBe('');
		expect(MEASURE_LEGEND.damLevel).toMatchObject({ ok: '60% full or more', watch: '30–60% full' });
	});
});

describe('days short', () => {
	it('counts demand days not fully met in the window, banded by the share met', () => {
		const s = summary({ supplyAssurance: { reliability: [rel('a', 100, 100), rel('b', 100, 80), rel('c', 100, 50), rel('d', 0, 0), rel('u', 10, 9, 'user')] } as RunSummary['supplyAssurance'] });
		const m = by(unitStatuses('daysShort', { nodes, summary: s }));
		expect(m.get('a')).toEqual({ nodeId: 'a', measure: 'daysShort', value: 0, band: 'ok', label: '0 of 100 days short' });
		expect(m.get('b')).toMatchObject({ value: 20, band: 'watch', label: '20 of 100 days short' });
		expect(m.get('c')).toMatchObject({ value: 50, band: 'short' });
		expect(m.get('d')).toMatchObject({ value: null, band: 'none', label: 'No demand days' });
		expect(m.get('u')).toMatchObject({ value: 1, band: 'watch' });
		// Gauges carry no unit measure.
		expect(m.has('g1')).toBe(false);
	});

	it('is none for a unit not in the run, and for every unit on a run with no assurance figures', () => {
		const m = by(unitStatuses('daysShort', { nodes, summary: summary({ supplyAssurance: { reliability: [rel('a', 1, 1)] } as RunSummary['supplyAssurance'] }) }));
		expect(m.get('b')).toMatchObject({ band: 'none', label: 'Not in this run' });
		const old = unitStatuses('daysShort', { nodes, summary: summary() });
		expect(old.every((x) => x.band === 'none' && x.value === null)).toBe(true);
		expect(old[0].label).toBe('No days-short figures in this run');
	});
});

describe('curtailment', () => {
	it('is the cut asked for, banded by the share of demand left; no cut is ok', () => {
		const s = summary({ curtailment: { farms: [cut('a', 50, 1), cut('b', -120, 0.8), cut('c', -400, 0.4), cut('d', 0, null)] } as RunSummary['curtailment'] });
		const m = by(unitStatuses('curtailment', { nodes, summary: s }));
		expect(m.get('a')).toEqual({ nodeId: 'a', measure: 'curtailment', value: 0, band: 'ok', label: 'No cut' });
		expect(m.get('b')).toMatchObject({ value: 120, band: 'watch', label: 'Cut 120 m³/day, 80% of demand left' });
		expect(m.get('c')).toMatchObject({ value: 400, band: 'short' });
		expect(m.get('d')).toMatchObject({ band: 'none', label: 'No demand' });
		expect(m.get('u')).toMatchObject({ band: 'none', label: 'Not in the curtailment table' });
	});

	it('is none without a curtailment table', () => {
		expect(unitStatuses('curtailment', { nodes, summary: summary() }).every((x) => x.band === 'none')).toBe(true);
	});
});

describe('dam level', () => {
	const level = (nodeId: string, endPct: number, minPct = 0) => ({ nodeId, name: nodeId, capacityM3: 100_000, endPct, minPct }) as DamLevel;

	it('uses the Network dam colouring: 60 % and over ok, 30–60 % watch, under 30 % or at its minimum short', () => {
		const m = by(unitStatuses('damLevel', { nodes, summary: summary(), damLevels: [level('a', 75), level('b', 45), level('c', 10, 10)] }));
		expect(m.get('a')).toEqual({ nodeId: 'a', measure: 'damLevel', value: 75, band: 'ok', label: '75% full' });
		expect(m.get('b')).toMatchObject({ value: 45, band: 'watch' });
		expect(m.get('c')).toMatchObject({ value: 10, band: 'short', label: '10%, at its minimum' });
		expect(m.get('d')).toMatchObject({ value: null, band: 'none', label: 'No dam' });
		expect(m.get('u')).toMatchObject({ band: 'none', label: 'No dam' });
	});

	it('is none for a dam the run has no level for, and for all until the levels are loaded', () => {
		expect(by(unitStatuses('damLevel', { nodes, summary: summary(), damLevels: [] })).get('a')).toMatchObject({ band: 'none', value: null, label: 'Not in this run' });
		expect(unitStatuses('damLevel', { nodes, summary: summary() }).every((x) => x.band === 'none' && x.label === 'Dam levels not loaded')).toBe(true);
	});
});

describe('use against allocation', () => {
	const src = (waterSource: 'surface' | 'groundwater', wholeYears: number, yearsOver: number, modelled: number | null, registered: number | null) => ({
		waterSource,
		wholeYears,
		yearsOver,
		meanModelledM3PerYear: modelled,
		meanRegisteredM3PerYear: registered
	});
	const allocations = (nodes: RunAllocations['nodes']): RunAllocations => ({ mode: 'none', tolerance: 0.1, used: 1, notMatched: 0, nodes });

	it('bands above registered short, use with no registered volume watch, within or below ok', () => {
		const s = summary({
			allocations: allocations([
				{ nodeId: 'a', name: 'a', sources: [src('surface', 3, 0, 100, 100)] },
				{ nodeId: 'b', name: 'b', sources: [src('surface', 3, 0, 50, 100)] },
				{ nodeId: 'c', name: 'c', sources: [src('surface', 3, 2, 105, 100)] },
				{ nodeId: 'u', name: 'u', sources: [src('surface', 2, 0, 80, 0)] }
			])
		});
		const m = by(unitStatuses('allocation', { nodes, summary: s }));
		expect(m.get('a')).toEqual({ nodeId: 'a', measure: 'allocation', value: 1, band: 'ok', label: 'Within band, 100% of registered (surface water)' });
		expect(m.get('b')).toMatchObject({ value: 0.5, band: 'ok', label: 'Below registered, 50% of registered (surface water)' });
		// Above registered in any whole year wins over a mean within the band (allocations.ts unitRows).
		expect(m.get('c')).toMatchObject({ band: 'short', label: 'Above registered in 2 of 3 whole years (surface water)' });
		expect(m.get('u')).toMatchObject({ value: null, band: 'watch', label: 'No registered volume (surface water)' });
		expect(m.get('d')).toMatchObject({ band: 'none', label: 'No registered volume' });
	});

	it('shows the worse of two sources', () => {
		const s = summary({ allocations: allocations([{ nodeId: 'a', name: 'a', sources: [src('surface', 2, 0, 100, 100), src('groundwater', 2, 0, 200, 100)] }]) });
		expect(by(unitStatuses('allocation', { nodes, summary: s })).get('a')).toMatchObject({ band: 'short', value: 2, label: 'Above registered, 200% of registered (groundwater)' });
	});

	it('is none with no whole water year, no use and none registered, or no allocations in the run', () => {
		const s = summary({ allocations: allocations([{ nodeId: 'a', name: 'a', sources: [src('surface', 0, 0, null, null)] }, { nodeId: 'b', name: 'b', sources: [src('surface', 1, 0, 0, 0)] }]) });
		const m = by(unitStatuses('allocation', { nodes, summary: s }));
		expect(m.get('a')).toMatchObject({ band: 'none', label: 'No whole water year in this run' });
		expect(m.get('b')).toMatchObject({ band: 'none', label: 'No use, none registered' });
		expect(unitStatuses('allocation', { nodes, summary: summary() }).every((x) => x.band === 'none' && x.label === 'No registered volumes in this run')).toBe(true);
	});
});

describe('gauges and EWR sites', () => {
	it('says met or missed per site, outlet first, and none for a gauge the run has no site for', () => {
		const s = summary({ curtailment: { farms: [], ewrSites: [site('out', 0, true), site('g1', 3)] } as unknown as RunSummary['curtailment'] });
		const out = ewrStatuses({ nodes, summary: s });
		expect(out.map((x) => x.nodeId)).toEqual(['out', 'g1', 'g2']);
		expect(out[0]).toEqual({ nodeId: 'out', measure: 'ewr', value: 0, band: 'ok', label: 'EWR met every day (outlet)' });
		expect(out[1]).toMatchObject({ value: 3, band: 'short', label: 'EWR missed on 3 days (gauge)' });
		expect(out[2]).toMatchObject({ value: null, band: 'none', label: 'Not an EWR site in this run' });
	});

	it('is none for every gauge on a run without EWR sites', () => {
		expect(ewrStatuses({ nodes, summary: summary() })).toEqual([
			{ nodeId: 'g1', measure: 'ewr', value: null, band: 'none', label: 'No EWR figures in this run' },
			{ nodeId: 'g2', measure: 'ewr', value: null, band: 'none', label: 'No EWR figures in this run' }
		]);
	});
});

describe('which run the map shows (D-A1)', () => {
	const run = (id: string, createdAt: string, published = false) => ({ id, createdAt, published }) as RunMeta;
	const runs = [run('old', '2026-01-01T00:00:00Z'), run('pub', '2026-02-01T00:00:00Z', true), run('new', '2026-03-01T00:00:00Z')];

	it('offers every run to an editor or owner, only the published one below', () => {
		expect(mapRuns(runs, 'owner').map((r) => r.id)).toEqual(['old', 'pub', 'new']);
		expect(mapRuns(runs, 'editor')).toHaveLength(3);
		for (const role of ['viewer', 'contributor', 'farmer'] as const) expect(mapRuns(runs, role).map((r) => r.id)).toEqual(['pub']);
	});

	it('shows the published run by default, for every role', () => {
		for (const role of ['owner', 'editor', 'viewer', 'contributor'] as const) expect(chooseMapRun(runs, role)).toEqual({ run: runs[1], from: 'published' });
	});

	it('lets an editor pick any run, and ignores a viewer’s pick of an unpublished one', () => {
		expect(chooseMapRun(runs, 'editor', 'old')).toEqual({ run: runs[0], from: 'picked' });
		expect(chooseMapRun(runs, 'editor', 'pub')).toEqual({ run: runs[1], from: 'published' });
		expect(chooseMapRun(runs, 'editor', 'gone')).toEqual({ run: runs[1], from: 'published' });
		expect(chooseMapRun(runs, 'viewer', 'new')).toEqual({ run: runs[1], from: 'published' });
	});

	it('with nothing published: an editor sees the newest run, anyone below sees nothing', () => {
		const unpublished = [run('x', '2026-01-01T00:00:00Z'), run('y', '2026-05-01T00:00:00Z'), run('z', '2026-03-01T00:00:00Z')];
		expect(chooseMapRun(unpublished, 'owner')).toEqual({ run: unpublished[1], from: 'newest' });
		expect(chooseMapRun(unpublished, 'viewer')).toEqual({ run: null, from: 'none' });
		expect(chooseMapRun([], 'owner')).toEqual({ run: null, from: 'none' });
	});
});

describe('fill colours', () => {
	const f = (id: string, kind: 'farm_parcel' | 'dam' | 'gauge' | 'catchment_boundary' | 'river' | 'other', nodeId: string | null) => ({ id, kind, nodeId });
	const statuses: MapStatus[] = [
		{ nodeId: 'a', measure: 'daysShort', value: 0, band: 'ok', label: '' },
		{ nodeId: 'b', measure: 'daysShort', value: 9, band: 'watch', label: '' },
		{ nodeId: 'c', measure: 'daysShort', value: 50, band: 'short', label: '' },
		{ nodeId: 'd', measure: 'daysShort', value: null, band: 'none', label: '' },
		{ nodeId: 'g1', measure: 'ewr', value: 2, band: 'short', label: '' }
	];
	const resolve = (t: string) => `rgb(${t})`;

	it('gives each linked feature its band token’s colour, keyed by feature id', () => {
		const out = bandFills([f('p1', 'farm_parcel', 'a'), f('p2', 'farm_parcel', 'b'), f('p3', 'other', 'c'), f('p4', 'farm_parcel', 'd'), f('dam', 'dam', 'a'), f('gauge', 'gauge', 'g1')], statuses, resolve);
		expect(out).toEqual({ p1: 'rgb(--success)', p2: 'rgb(--warning)', p3: 'rgb(--danger)', p4: 'rgb(--text-muted)', dam: 'rgb(--success)', gauge: 'rgb(--danger)' });
		expect(BAND_TOKEN).toEqual({ ok: '--success', watch: '--warning', short: '--danger', none: '--text-muted' });
	});

	it('leaves out unlinked features, nodes with no status, the boundary, rivers and tokens that resolve to nothing', () => {
		const out = bandFills([f('loose', 'farm_parcel', null), f('other', 'farm_parcel', 'zz'), f('b', 'catchment_boundary', 'a'), f('r', 'river', 'a'), f('p', 'farm_parcel', 'b')], statuses, (t) => (t === '--warning' ? '' : 'x'));
		expect(out).toEqual({});
	});

	it('resolves each token once', () => {
		const seen: string[] = [];
		bandFills([f('p1', 'farm_parcel', 'a'), f('p2', 'farm_parcel', 'a'), f('p3', 'farm_parcel', 'c')], statuses, (t) => (seen.push(t), 'x'));
		expect(seen).toEqual(['--success', '--danger']);
	});
});
