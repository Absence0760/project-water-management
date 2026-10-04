// `pnpm import:project --settings … --fit` (./fit-project.ts): the settings
// patch and the fit happen to the document before the import, with no
// database. Synthetic catchment: invented values only (public repo).
import { calibrate, fitRecordStatus, runModel, type ModelInput } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { FitRecord, mergeSettings } from '../src/projects/settings.js';
import { fitDocument, fitSummary, modelInputOf, withSettingsPatch, withTransferPatch, type ProjectDocument } from './fit-project.js';

function doc(): ProjectDocument {
	const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 1, returnFlowFraction: 0, damAreaFullM2: null, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const days = 1461;
	const rain = Array.from({ length: days }, (_, i) => (i % 13 === 0 ? 30 : i % 4 === 0 ? 2 : 0));
	const flow = Array.from({ length: days }, (_, i) => 0.04 + 0.25 * Math.exp(-(i % 13) / 3) * (1 + 0.5 * Math.sin(i / 58)));
	return {
		name: 'Invented',
		settings: { apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] },
		model: {
			nodes: [
				{ ...node, id: '00000000-0000-4000-8000-000000000001', name: 'Outlet', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
				{ ...node, id: '00000000-0000-4000-8000-000000000002', name: 'Unit', kind: 'farm', downstreamNodeId: '00000000-0000-4000-8000-000000000001', areaKm2: 20 }
			],
			crops: [],
			cropAreas: [],
			transfers: []
		} as unknown as ModelInput['model'],
		series: [
			{ kind: 'rain_chirps_mm', startDate: '2016-10-01', values: rain },
			{ kind: 'flow_observed_m3s', startDate: '2016-10-01', values: flow }
		]
	};
}

const arealRain = { factors: new Array(12).fill(1.8), method: 'map', source: 'invented MAP ÷ the forcing’s mean annual rain' };

describe('withTransferPatch (engine 1.14.0)', () => {
	const U2 = '00000000-0000-4000-8000-000000000003';
	const withRule = (): ProjectDocument => {
		const d = doc();
		const unit = d.model.nodes[1]!;
		d.model.nodes.push({ ...unit, id: U2, name: 'Canal', areaKm2: 0 });
		d.model.transfers = [
			{ id: '00000000-0000-4000-8000-0000000000a1', fromNodeId: unit.id, toNodeId: U2, months: [1], maxRateM3s: 0.2, dailyCapM3: null, minStoragePct: 0, enabled: false, priority: 0, source: 'river', sizing: 'capacity' }
		];
		return d;
	};

	it('sets a rule named by its end nodes, monthly rates with their months and max rate, leaving the document alone', () => {
		const d = withRule();
		const out = withTransferPatch(d, [{ from: 'Unit', to: 'Canal', set: { enabled: true, dailyCapM3: 1200, handsOffM3Day: 50, monthlyRateM3s: [0.01, 0, 0, 0.02, 0, 0, 0, 0, 0, 0, 0, 0] } }]);
		expect(out.model.transfers[0]).toMatchObject({ enabled: true, dailyCapM3: 1200, handsOffM3Day: 50, months: [1, 10], maxRateM3s: 0.02, source: 'river' });
		expect(d.model.transfers[0]!.enabled).toBe(false); // not in place
		expect(out.series).toBe(d.series);
	});

	it('refuses an entry that matches no rule, a field it can’t set, a bad value, or a model the API refuses', () => {
		expect(() => withTransferPatch(withRule(), { from: 'Unit' })).toThrow(/a list/);
		expect(() => withTransferPatch(withRule(), [{ from: 'Canal', to: 'Unit', set: { enabled: true } }])).toThrow(/0 transfer rules/);
		expect(() => withTransferPatch(withRule(), [{ from: 'Unit', to: 'Canal', set: { id: 'x' } }])).toThrow(/not a transfer field/);
		expect(() => withTransferPatch(withRule(), [{ from: 'Unit', to: 'Canal', set: { lossPct: 1 } }])).toThrow(/lossPct/);
		expect(() => withTransferPatch(withRule(), [{ from: 'Unit', to: 'Canal', set: { toNodeId: '00000000-0000-4000-8000-000000000001' } }])).toThrow(/API refuses/);
	});
});

describe('withSettingsPatch', () => {
	it('applies a patch as the API would, leaving the rest of the document alone', () => {
		const d = doc();
		const out = withSettingsPatch(d, { arealRain, calibrationStart: '2017-10-01', gr4j: { x1: 200 } });
		expect(out.settings!.arealRain).toEqual(arealRain);
		expect(out.settings!.calibrationStart).toBe('2017-10-01');
		// Groups merge one level deep: the other GR4J parameters keep their values.
		expect(out.settings!.gr4j).toEqual({ ...mergeSettings({}).gr4j, x1: 200 });
		expect(out.settings!.apanMm).toEqual(d.settings!.apanMm);
		expect(out.series).toBe(d.series);
		expect(d.settings!.arealRain).toBeUndefined(); // not in place
	});

	it('refuses what a PATCH refuses', () => {
		expect(() => withSettingsPatch(doc(), { arealRain: { ...arealRain, source: '' } })).toThrow();
		expect(() => withSettingsPatch(doc(), { gr4j: { x1: -1 } })).toThrow();
	});
});

describe('fitDocument', () => {
	it('stores the parameters calibrate() finds and a fit record that describes them, under the patched forcing', () => {
		const d = withSettingsPatch(doc(), { arealRain, calibrationStart: '2017-10-01' });
		const now = new Date('2026-01-02T03:04:05Z');
		const { doc: fitted, report } = fitDocument(d, { seed: 7, starts: 1, budget: 40, now });
		// The same inputs and seed give the same fit (what calibrate() does alone).
		const again = calibrate(modelInputOf(d), { seed: 7, starts: 1, budget: 40, validate: true });
		expect(report.params).toEqual(again.params);
		const s = fitted.settings as Record<string, any>;
		for (const k of report.free) expect(s.gr4j[k]).toBe(report.params[k]);
		const record = s.fitRecord;
		expect(FitRecord.safeParse(record).success).toBe(true);
		expect(record.fittedAt).toBe(now.toISOString());
		expect(record.forcing.arealRain).toEqual(arealRain);
		expect(record.calibrationStart).toBe('2017-10-01');
		expect(record.editedParams).toEqual([]);
		expect(record.splitSample).not.toBeNull();
		// Nothing about it is stale against the settings it sits in.
		const status = fitRecordStatus(s, record);
		expect(status.forcingChanged || status.windowChanged || status.exclusionsChanged || status.editedParams.length > 0).toBe(false);
		// A run of the fitted document scores what the fit scored (in-sample, same days).
		const run = runModel(modelInputOf(fitted));
		expect(run.summary.calibration!.nse).toBeCloseTo(report.fit.scores.nse!, 9);
		expect(run.summary.calibration!.fitStatus).toBe('fitted');
		expect(fitSummary(report)[0]).toMatch(/^fitted X1 [\d.]+, X3 [\d.]+, X4 [\d.]+ against flow_observed_m3s/);
	});

	it('validates against the other record when the document has both a gauge and a logger', () => {
		const d = doc();
		const gauge = d.series![1]!;
		d.series!.push({ kind: 'flow_logger_m3s', startDate: gauge.startDate, values: gauge.values.map((v) => (v === null ? null : v * 0.9)) });
		const { report, doc: fitted } = fitDocument(d, { seed: 1, starts: 1, budget: 20 });
		expect(report.independentRecord?.flowKind).toBe('flow_logger_m3s');
		expect((fitted.settings as Record<string, any>).fitRecord.validationRecord).toBe('flow_logger_m3s');
	});
});
