import type { RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { isLowerAnchor, isModelQualityAnchor, MODEL_QUALITY_ANCHORS, modelQualitySections } from './modelQuality';
import { resultSections } from './sections';

const ids = (summary: Parameters<typeof modelQualitySections>[0]) => modelQualitySections(summary).map((s) => s.id);
const gauge = (nodeId: string) => ({ nodeId }) as NonNullable<NonNullable<RunSummary['plausibility']>['gauges']>[number];

describe('modelQualitySections', () => {
	it('lists the panels every run has, the hydrograph and the flow-duration curve first', () => {
		expect(ids({})).toEqual(['res-hydrograph', 'res-fdc', 'res-calibration', 'res-ewr-agreement']);
	});

	it('adds the optional panels in page order: runoff model (GR4J), WR2012, then plausibility after EWR vs observed', () => {
		expect(
			ids({
				runoff: { model: 'gr4j' } as RunSummary['runoff'],
				wr2012: {} as RunSummary['wr2012'],
				plausibility: {} as RunSummary['plausibility']
			})
		).toEqual(['res-hydrograph', 'res-fdc', 'res-calibration', 'res-runoff', 'res-wr2012', 'res-ewr-agreement', 'res-plausibility']);
	});

	it('lists Rain for each unit after the runoff model, only for a run that ran per unit (issue #482), else Rain from rainfall stations (issue #553)', () => {
		const runoff = { model: 'gr4j' } as RunSummary['runoff'];
		expect(ids({ runoff })).not.toContain('res-unit-rain');
		// A stored summary from another engine: read defensively, whatever its type says.
		expect(ids({ runoff, unitRain: { mode: 'catchment', units: [] } as unknown as RunSummary['unitRain'] })).not.toContain('res-unit-rain');
		const perUnit = ids({ runoff, unitRain: { mode: 'perUnit', gaugeMapMm: null, gaugeMapSource: null, mapPeriod: { start: '1991-01-01', end: '2020-12-31' }, units: [] } });
		expect(perUnit.indexOf('res-unit-rain')).toBe(perUnit.indexOf('res-runoff') + 1);
		const catchment = { nodeId: null, name: 'Synthetic catchment' } as NonNullable<RunSummary['stations']>['catchment'];
		const stations = modelQualitySections({ runoff, stations: { pairings: [], catchment, units: [], catchmentMapMm: null, catchmentMapFromUnits: true } });
		expect(stations.find((x) => x.id === 'res-unit-rain')?.label).toBe('Rain from rainfall stations');
	});

	it('lists the checks-only gauges after the flow-duration curve, not the calibration site’s alone (issue #554)', () => {
		const checked = { plausibility: { gauges: [gauge('a')] } as RunSummary['plausibility'] };
		expect(ids(checked).slice(0, 3)).toEqual(['res-hydrograph', 'res-fdc', 'res-gauges']);
		expect(ids({ ...checked, calibration: { siteNodeId: 'a' } })).not.toContain('res-gauges');
	});

	it('names each link as its panel’s heading, word for word, with no shorter bar name', () => {
		const sections = modelQualitySections({
			runoff: { model: 'gr4j' } as RunSummary['runoff'],
			wr2012: { quaternary: 'X11A' } as RunSummary['wr2012'],
			plausibility: { gauges: [gauge('a')] } as RunSummary['plausibility']
		});
		expect(sections.map((s) => s.label)).toEqual([
			'Hydrograph',
			'Flow-duration curve',
			'Flow at gauges in the network (checks only)',
			'Calibration against observed flow',
			'Runoff model: GR4J',
			'WR2012 check: X11A',
			'EWR test: model against observed flow',
			'Plausibility checks'
		]);
		expect(sections.some((s) => s.bar)).toBe(false);
	});

	it('uses only the anchors MODEL_QUALITY_ANCHORS names, in its order, none of them still on Runs & results', () => {
		const all = ids({
			runoff: { model: 'gr4j' } as RunSummary['runoff'],
			wr2012: {} as RunSummary['wr2012'],
			plausibility: { gauges: [gauge('a')] } as RunSummary['plausibility'],
			unitRain: { mode: 'perUnit', gaugeMapMm: null, gaugeMapSource: null, mapPeriod: { start: '1991-01-01', end: '2020-12-31' }, units: [] }
		});
		expect(all).toEqual([...MODEL_QUALITY_ANCHORS]);
		const onRuns = resultSections({ farms: [] }, true).map((s) => s.id);
		for (const id of MODEL_QUALITY_ANCHORS) expect(onRuns, id).not.toContain(id);
	});
});

describe('isLowerAnchor', () => {
	it('is every Model quality panel after the flow-duration curve and the sub-headings with an index line, and nothing else (issue #586 R3-B, R3-D)', () => {
		expect(isLowerAnchor('res-hydrograph')).toBe(false);
		expect(isLowerAnchor('res-fdc')).toBe(false);
		for (const id of MODEL_QUALITY_ANCHORS.slice(2)) expect(isLowerAnchor(id), id).toBe(true);
		// And Calibration against observed flow's sub-headings with an index line, so a link to one has it drawn at once.
		for (const id of ['res-calibration-check', 'res-fit-provenance']) expect(isLowerAnchor(id), id).toBe(true);
		// Calibration's own parts, Runs & results' panels and the settings panels draw nothing early.
		for (const id of ['cal-setup', 'cal-fit', 'res-notes', 'res-water-balance', 'set-fit', '']) {
			expect(isLowerAnchor(id), id).toBe(false);
			expect(isModelQualityAnchor(id), id).toBe(false);
		}
	});
});
