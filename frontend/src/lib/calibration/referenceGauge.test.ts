import { describe, expect, it } from 'vitest';
import { areaFactor, modelCatchmentAreaKm2, monthLabel, monthlyVolumes, perDay, referenceName, resolveReferenceGauge, scaledReference, verificationRow, volumeUnit } from './referenceGauge';

describe('the reference gauge setting (resolveReferenceGauge)', () => {
	it('reads a valid setting, trimming the name; a blank outlet area is the model’s', () => {
		expect(resolveReferenceGauge({ referenceGauge: { areaKm2: 300, targetAreaKm2: null, name: '  Upper weir ' } })).toEqual({ areaKm2: 300, targetAreaKm2: null, name: 'Upper weir' });
		expect(resolveReferenceGauge({ referenceGauge: { areaKm2: 300, targetAreaKm2: 240, name: '' } })).toEqual({ areaKm2: 300, targetAreaKm2: 240, name: '' });
	});
	it('none: absent, null, or no positive area of its own', () => {
		expect(resolveReferenceGauge({})).toBeNull();
		expect(resolveReferenceGauge(null)).toBeNull();
		expect(resolveReferenceGauge({ referenceGauge: null })).toBeNull();
		expect(resolveReferenceGauge({ referenceGauge: { areaKm2: 0, targetAreaKm2: null, name: '' } })).toBeNull();
		expect(resolveReferenceGauge({ referenceGauge: 'x' })).toBeNull();
	});
	it('a name or "the reference gauge"', () => {
		expect(referenceName({ name: 'Upper weir' })).toBe('Upper weir');
		expect(referenceName({ name: ' ' })).toBe('the reference gauge');
		expect(referenceName(null)).toBe('the reference gauge');
	});
});

describe('the area factor', () => {
	const units = { nodes: [{ kind: 'farm', areaKm2: 120 }, { kind: 'farm', areaKm2: 80 }, { kind: 'dam', areaKm2: 5 }, { kind: 'gauge' }] };
	it('the model’s area: the units’ areas, else the catchment area setting', () => {
		expect(modelCatchmentAreaKm2(units, { catchmentAreaKm2: 999 })).toBe(200);
		expect(modelCatchmentAreaKm2({ nodes: [{ kind: 'farm', areaKm2: 0 }] }, { catchmentAreaKm2: 150 })).toBe(150);
		expect(modelCatchmentAreaKm2({ nodes: [] }, null)).toBeNull();
		expect(modelCatchmentAreaKm2(null, { catchmentAreaKm2: 150 })).toBeNull();
	});
	it('outlet ÷ reference: the outlet area set, else the model’s', () => {
		expect(areaFactor({ areaKm2: 250, targetAreaKm2: null, name: '' }, 200)).toEqual({ factor: 0.8, targetKm2: 200, refKm2: 250, targetFrom: 'model' });
		expect(areaFactor({ areaKm2: 250, targetAreaKm2: 100, name: '' }, 200)).toEqual({ factor: 0.4, targetKm2: 100, refKm2: 250, targetFrom: 'set' });
	});
	it('none without a reference area, or with no outlet area at all', () => {
		expect(areaFactor(null, 200)).toBeNull();
		expect(areaFactor({ areaKm2: 250, targetAreaKm2: null, name: '' }, null)).toBeNull();
	});
});

describe('the scaled record', () => {
	it('m³/s to m³/day, × the factor; a missing day stays missing', () => {
		expect(scaledReference({ startDate: '2020-01-01', unit: 'm³/s', values: [1, null, 2] }, 0.5)).toEqual({ startDate: '2020-01-01', values: [43_200, null, 86_400] });
		expect(scaledReference({ startDate: '2020-01-01', unit: 'm3/s', values: [1] }, 1)!.values).toEqual([86_400]);
		expect(scaledReference({ startDate: '2020-01-01', unit: 'm³/day', values: [10] }, 2)!.values).toEqual([20]);
	});
	it('a unit it can’t read: none', () => {
		expect(perDay('ft³/s')).toBeNull();
		expect(scaledReference({ startDate: '2020-01-01', unit: 'cfs', values: [1] }, 1)).toBeNull();
	});
});

describe('the model against the scaled record (verificationRow)', () => {
	const ref = { startDate: '2020-01-02', values: [10, 20, null, 40, 50] };
	it('over the days both have a value, each from its own start', () => {
		// The model starts a day earlier: its [1..5] line up with the record's [0..4].
		const model = { startDate: '2020-01-01', values: [999, 10, 20, 30, 40, 50] };
		const row = verificationRow(ref, model)!;
		expect(row).toMatchObject({ days: 4, from: '2020-01-02', to: '2020-01-06' });
		expect(row.kge).toBeCloseTo(1, 12);
		expect(row.biasPct).toBeCloseTo(0, 12);
		expect(row.r).toBeCloseTo(1, 12);
	});
	it('the bias is the model’s volume against the record’s', () => {
		const model = { startDate: '2020-01-02', values: [12, 24, 0, 48, 60] };
		const row = verificationRow(ref, model)!;
		expect(row.biasPct).toBeCloseTo(20, 9);
		expect(row.r).toBeCloseTo(1, 12);
		expect(row.kge).toBeCloseTo(0.8, 9);
	});
	it('stops at a forecast run’s first forecast day', () => {
		const model = { startDate: '2020-01-02', values: [10, 20, 30, 40, 50] };
		expect(verificationRow(ref, model, '2020-01-05')).toMatchObject({ days: 2, to: '2020-01-03' });
	});
	it('no shared day: none', () => {
		expect(verificationRow(ref, { startDate: '2021-01-01', values: [1, 2] })).toBeNull();
	});
});

describe('the monthly volumes (monthlyVolumes)', () => {
	const day = (n: number, v: number | null = 1) => Array.from({ length: n }, () => v);

	it('cuts at month boundaries, from the first to the last shared month, a month’s volume the sum of its days', () => {
		// 20 Jan – 10 Mar 2021 for all three: Jan has 12 days, Feb 28, Mar 10.
		const ref = { startDate: '2021-01-20', values: day(50, 2) };
		const sim = { startDate: '2021-01-01', values: day(100, 3) };
		const nat = { startDate: '2021-01-20', values: day(60, 5) };
		const rows = monthlyVolumes(ref, sim, nat, null, 10);
		expect(rows.map((r) => [r.month, r.days, r.daysInMonth])).toEqual([
			['2021-01', 12, 31],
			['2021-02', 28, 28],
			['2021-03', 10, 31]
		]);
		expect(rows[1]).toMatchObject({ reference: 56, simulated: 84, natural: 140 });
	});
	it('a partial month under the minimum is a gap, not a low value', () => {
		const ref = { startDate: '2021-01-20', values: day(50, 2) };
		const sim = { startDate: '2021-01-20', values: day(50, 3) };
		const rows = monthlyVolumes(ref, sim, null);
		expect(rows[0]).toMatchObject({ month: '2021-01', days: 12, reference: null, simulated: null, natural: null });
		expect(rows[1]).toMatchObject({ month: '2021-02', days: 28, reference: 56, simulated: 84, natural: null });
		expect(rows[2]).toMatchObject({ month: '2021-03', days: 10, reference: null });
	});
	it('counts only the days every flow has a value: a missing day in one drops it from all', () => {
		const refVals = day(28, 1);
		for (let i = 0; i < 10; i++) refVals[i] = null;
		const ref = { startDate: '2021-02-01', values: refVals };
		const sim = { startDate: '2021-02-01', values: day(28, 2) };
		const natVals = day(28, 4);
		natVals[27] = null;
		const nat = { startDate: '2021-02-01', values: natVals };
		const [feb] = monthlyVolumes(ref, sim, nat, null, 15);
		expect(feb).toMatchObject({ days: 17, reference: 17, simulated: 34, natural: 68 });
		// With 20 needed, the same month is a gap.
		expect(monthlyVolumes(ref, sim, nat)[0]).toMatchObject({ days: 17, reference: null, simulated: null, natural: null });
	});
	it('stops before a forecast run’s first forecast day; no shared span, no months', () => {
		const ref = { startDate: '2021-01-01', values: day(90, 1) };
		const sim = { startDate: '2021-01-01', values: day(90, 1) };
		expect(monthlyVolumes(ref, sim, null, '2021-03-01').map((r) => r.month)).toEqual(['2021-01', '2021-02']);
		expect(monthlyVolumes(ref, { startDate: '2022-01-01', values: day(5) }, null)).toEqual([]);
	});
	it('the volume unit and the month label', () => {
		const row = (v: number) => ({ month: '2021-01', days: 31, daysInMonth: 31, reference: v, simulated: null, natural: null });
		expect(volumeUnit([row(2.5e6)])).toEqual({ text: 'million m³', div: 1e6 });
		expect(volumeUnit([row(4e5)])).toEqual({ text: 'thousand m³', div: 1e3 });
		expect(monthLabel('2021-10')).toBe('Oct 2021');
	});
});
