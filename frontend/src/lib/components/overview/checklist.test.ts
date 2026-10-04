import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, type NetworkNode, type ProjectModel, type SeriesMeta } from '@water-management/engine';
import type { RunMeta } from '$lib/api/types';
import { checklist, checklistMode, nextStep, progress, type ChecklistStep } from './checklist';

const node = (over: Partial<NetworkNode>): NetworkNode => ({
	id: 'n',
	name: 'n',
	kind: 'farm',
	downstreamNodeId: 'g',
	sortOrder: 0,
	areaKm2: 10,
	areaHiKm2: 0,
	areaLoKm2: 0,
	flowShareManual: null,
	pctUpstreamToDam: 0,
	pctRunoffToDam: 0,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	returnFlowFraction: 0,
	damAreaFullM2: null,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});
const empty: ProjectModel = { nodes: [], crops: [], cropAreas: [], transfers: [] };
const full: ProjectModel = {
	nodes: [node({ id: 'f1', name: 'Upper' }), node({ id: 'g', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 })],
	crops: [{ id: 'c', name: 'Citrus', cropFactor: Array(12).fill(0.7) }],
	cropAreas: [{ nodeId: 'f1', cropId: 'c', areaM2: 125_000 }],
	transfers: []
};
const series = (kind: string, length = 3653): SeriesMeta => ({ id: kind, kind, name: '', unit: '', startDate: '2000-01-01', length });
const run = (createdAt: string): RunMeta => ({
	id: createdAt,
	label: null,
	engineVersion: '1',
	startDate: '2000-01-01',
	endDate: '2009-12-31',
	createdAt,
	createdBy: null,
	legacy: false
});
const settled = () => {
	const s = defaultProjectSettings();
	s.apanMm = Array(12).fill(150) as unknown as typeof s.apanMm;
	s.ewrPragmaticM3PerDay = Array(12).fill(5000) as unknown as typeof s.ewrPragmaticM3PerDay;
	return s;
};
const statuses = (steps: ReturnType<typeof checklist>) => Object.fromEntries(steps.map((s) => [s.id, s.status]));

describe('checklist', () => {
	it('a brand-new catchment: everything to do, network first', () => {
		const steps = checklist({ model: empty, settings: defaultProjectSettings(), series: [], runs: [] });
		expect(statuses(steps)).toEqual({ network: 'todo', crops: 'todo', series: 'todo', settings: 'todo', runs: 'todo' });
		expect(steps.map((s) => s.tab)).toEqual(['network', 'crops', 'series', 'settings', 'runs']);
		expect(nextStep(steps)?.id).toBe('network');
		expect(progress(steps)).toEqual({ done: 0, total: 5, complete: false });
	});

	it('shows unknown while series and runs load', () => {
		const steps = checklist({ model: full, settings: settled(), series: null, runs: null });
		expect(statuses(steps)).toMatchObject({ series: 'unknown', runs: 'unknown' });
	});

	it('a rain-source period’s series counts as rainfall, but only when a period uses it (engine ≥ 1.69.0)', () => {
		const period = { start: '2000-01-01', end: '2009-12-31', series: 'rain_catchment_alt_mm', factors: Array(12).fill(1), reason: 'invented' };
		const withPeriod = { ...settled(), rainSource: [period] } as unknown as ReturnType<typeof settled>;
		const alt = [series('rain_catchment_alt_mm', 3653), series('flow_observed_m3s')];
		expect(checklist({ model: full, settings: withPeriod, series: alt, runs: [] })[2]!.detail).toBe('Rainfall (10 years) and observed flow loaded.');
		expect(checklist({ model: full, settings: settled(), series: alt, runs: [] })[2]!.status).toBe('todo');
	});

	it('a fully set-up, freshly run catchment is complete', () => {
		const steps = checklist({
			model: full,
			settings: settled(),
			series: [series('rain_catchment_mm', 3653), series('flow_observed_m3s')],
			runs: [run('2026-01-01T00:00:00Z'), run('2026-02-01T00:00:00Z')],
			updatedAt: '2026-01-15T00:00:00Z'
		});
		expect(statuses(steps)).toEqual({ network: 'done', crops: 'done', series: 'done', settings: 'done', runs: 'done' });
		expect(steps[0]!.detail).toBe('1 hydrological unit, 1 gauge, draining to Gauge.');
		expect(steps[1]!.detail).toBe('1 crop on 1 hydrological unit, 12.5 ha irrigated.');
		expect(steps[2]!.detail).toBe('Rainfall (10 years) and observed flow loaded.');
		expect(steps[4]!.detail).toBe('2 runs, latest 2026-02-01.');
		expect(progress(steps).complete).toBe(true);
		expect(nextStep(steps)).toBeUndefined();
	});

	describe('network', () => {
		it('needs farms, exactly one outlet and a catchment area', () => {
			const gaugeOnly = { ...empty, nodes: [node({ id: 'g', kind: 'gauge', downstreamNodeId: null })] };
			expect(checklist({ model: gaugeOnly, settings: settled(), series: [], runs: [] })[0]!.status).toBe('partial');

			const twoOutlets = { ...empty, nodes: [node({ id: 'a', downstreamNodeId: null }), node({ id: 'b', downstreamNodeId: null })] };
			expect(checklist({ model: twoOutlets, settings: settled(), series: [], runs: [] })[0]!.detail).toMatch(/exactly one outflow/);

			const noArea = { ...full, nodes: full.nodes.map((n) => ({ ...n, areaKm2: 0 })) };
			const s = settled();
			expect(checklist({ model: noArea, settings: s, series: [], runs: [] })[0]!.detail).toMatch(/areas \(km²\)/);
			s.calibration.catchmentAreaKm2 = 50; // an explicit area override is enough
			expect(checklist({ model: noArea, settings: s, series: [], runs: [] })[0]!.status).toBe('done');
		});
	});

	it('crops without planted area are partial; crops are optional', () => {
		const steps = checklist({ model: { ...full, cropAreas: [] }, settings: settled(), series: [], runs: [] });
		expect(steps[1]).toMatchObject({ status: 'partial', optional: true });
		expect(steps[1]!.detail).toBe('1 crop defined, but no irrigated area on any hydrological unit yet.');
	});

	it('rainfall without observed flow is partial (no calibration check)', () => {
		const step = checklist({ model: full, settings: settled(), series: [series('rain_chirps_mm', 400)], runs: [] })[2]!;
		expect(step.status).toBe('partial');
		expect(step.detail).toMatch(/^Rainfall \(1 year\) loaded\. No observed flow/);
		// A record attached to a gauge inside the network (084) is checked there, not calibrated against: still partial.
		const sited = checklist({ model: full, settings: settled(), series: [series('rain_chirps_mm', 400), { ...series('flow_observed_m3s'), siteNodeId: 'g1' }], runs: [] })[2]!;
		expect(sited.status).toBe('partial');
		// Positive control: the same record at the outlet completes the step.
		expect(checklist({ model: full, settings: settled(), series: [series('rain_chirps_mm', 400), series('flow_observed_m3s')], runs: [] })[2]!.status).toBe('done');
		// A Pitman series (engine ≤ 0.9.0) no longer counts as run input.
		expect(checklist({ model: full, settings: settled(), series: [series('flow_pitman_m3s')], runs: [] })[2]!.status).toBe('todo');
		const onlyObserved = checklist({ model: full, settings: settled(), series: [series('flow_observed_m3s')], runs: [] })[2]!;
		expect(onlyObserved.status).toBe('todo');
	});

	it('settings: A-pan missing is a gap; EWR missing is optional', () => {
		const noApan = settled();
		noApan.apanMm = defaultProjectSettings().apanMm;
		expect(checklist({ model: full, settings: noApan, series: [], runs: [] })[3]).toMatchObject({ status: 'partial' });
		expect(checklist({ model: full, settings: noApan, series: [], runs: [] })[3]!.optional).toBeUndefined();

		const noEwr = settled();
		noEwr.ewrPragmaticM3PerDay = defaultProjectSettings().ewrPragmaticM3PerDay;
		const step = checklist({ model: full, settings: noEwr, series: [], runs: [] })[3]!;
		expect(step).toMatchObject({ status: 'partial', optional: true });
	});

	it('flags results as stale when the project changed after the last run', () => {
		const step = checklist({
			model: full,
			settings: settled(),
			series: [],
			runs: [run('2026-01-01T00:00:00Z')],
			updatedAt: '2026-03-01T00:00:00Z'
		})[4]!;
		expect(step.status).toBe('partial');
		expect(step.detail).toMatch(/^Last run 2026-01-01; the project has changed since/);
	});

	it('progress counts optional steps left partial; next skips them', () => {
		const noEwr = settled();
		noEwr.ewrPragmaticM3PerDay = defaultProjectSettings().ewrPragmaticM3PerDay;
		const steps = checklist({
			model: full,
			settings: noEwr,
			series: [series('rain_catchment_mm'), series('flow_observed_m3s')],
			runs: []
		});
		expect(progress(steps)).toEqual({ done: 4, total: 5, complete: false });
		expect(nextStep(steps)?.id).toBe('runs');
	});

	describe('checklistMode: how the Summary shows it', () => {
		const step = (id: ChecklistStep['id'], status: ChecklistStep['status'], optional = false): ChecklistStep => ({
			id,
			tab: id,
			title: id,
			status,
			detail: '',
			optional
		});
		const known = [step('network', 'done'), step('crops', 'partial', true), step('settings', 'done')];

		it('every step done (an optional one left partial counts): complete, the header pill', () => {
			expect(checklistMode([...known, step('series', 'done'), step('runs', 'done')])).toBe('complete');
		});
		it('still loading with nothing known to do: a one-line checking bar, not the open list', () => {
			expect(checklistMode([...known, step('series', 'unknown'), step('runs', 'unknown')])).toBe('checking');
		});
		it('a known gap opens the list at once, even while the rest loads', () => {
			expect(checklistMode([step('network', 'todo'), step('series', 'unknown'), step('runs', 'unknown')])).toBe('open');
			expect(checklistMode([...known, step('series', 'partial'), step('runs', 'done')])).toBe('open');
		});
		it('matches a real brand-new catchment and a real finished one', () => {
			expect(checklistMode(checklist({ model: empty, settings: defaultProjectSettings(), series: [], runs: [] }))).toBe('open');
			const done = checklist({
				model: full,
				settings: settled(),
				series: [series('rain_catchment_mm', 3653), series('flow_observed_m3s')],
				runs: [run('2026-02-01T00:00:00Z')],
				updatedAt: '2026-01-15T00:00:00Z'
			});
			expect(checklistMode(done)).toBe('complete');
		});
	});
});
