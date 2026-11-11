import {
	CROP_SET_FIELDS,
	LAND_COVER_SET_FIELDS,
	NODE_SET_FIELDS,
	PE_SOURCE_MAX,
	SETTINGS_PATHS,
	TRANSFER_SET_FIELDS,
	cropFieldError,
	monthlyRatesMismatch,
	withMonthlyRates,
	landCoverFieldError,
	nodeFieldError,
	settingsValueError,
	transferFieldError
} from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { applyScenario, type ModelInput, type ScenarioOp, type Transfer, type TransferSetField } from '@water-management/engine';
import { newNode } from '#lib/model/editor.svelte.js';
import { snapshotInput } from './ops';
import { pumpUnit, riverToDamUnit, type FlowUnitId } from '#lib/components/network/flowUnit.svelte.js';
import {
	CROP_FIELD_SPECS,
	DEMAND_OBJECT_FIELD_SPECS,
	LAND_COVER_FIELD_SPECS,
	NODE_FIELD_SPECS,
	SETTINGS_SPECS,
	TRANSFER_FIELD_SPECS,
	TRANSFER_FIELDS,
	formatValue,
	monthsText,
	nodeFields,
	parseValue,
	peDraftOf,
	rescaleText,
	percentMessage,
	settingsValue,
	transferChoices,
	transferFieldsFor,
	valueText,
	type ValueSpec
} from './fields';

describe('field specs cover the engine’s op catalogue', () => {
	it('has a spec for every node field, transfer field and settings path an op may set, and no others', () => {
		const nodeFieldsAll = new Set(Object.values(NODE_SET_FIELDS).flat());
		expect(new Set(Object.keys(NODE_FIELD_SPECS))).toEqual(nodeFieldsAll);
		expect(Object.keys(TRANSFER_FIELD_SPECS).sort()).toEqual([...TRANSFER_SET_FIELDS].sort());
		expect(Object.keys(SETTINGS_SPECS).sort()).toEqual([...SETTINGS_PATHS].sort());
	});

	it('lists a node kind’s fields in the engine’s order', () => {
		// A gauge: its name, whether it is an EWR site (engine 1.5.0) and the bed losses below it (engine 1.75.0), by month too (1.116.0).
		expect(nodeFields('gauge')).toEqual([
			{ field: 'name', label: 'Name' },
			{ field: 'ewrSite', label: 'EWR site' },
			{ field: 'reachLossFrac', label: 'Bed losses in the reach below' },
			{ field: 'reachLossMaxM3Day', label: 'Bed losses at most' },
			{ field: 'reachLossFracMonthly', label: 'Bed losses by month' },
			{ field: 'reachLossMaxMonthlyM3Day', label: 'Bed losses at most by month' }
		]);
		expect(nodeFields('farm').map((f) => f.field)).toEqual([...NODE_SET_FIELDS.farm]);
	});

	it('offers a farm its supply rule and river pump (WP-3.8); a user only its pump capacity (engine 1.58.0); a gauge neither', () => {
		const supply = ['supplyRule', 'pumpCapacityM3Day', 'supplyTriggerPct', 'supplyStopPct'];
		expect(nodeFields('farm').filter((f) => supply.includes(f.field))).toEqual([
			{ field: 'supplyRule', label: 'Supply rule' },
			{ field: 'pumpCapacityM3Day', label: 'River pump capacity' },
			{ field: 'supplyTriggerPct', label: 'Supply switch-to-river level' },
			{ field: 'supplyStopPct', label: 'Supply switch-back level' }
		]);
		expect(nodeFields('user').filter((f) => supply.includes(f.field))).toEqual([{ field: 'pumpCapacityM3Day', label: 'River pump capacity' }]);
		expect(nodeFields('gauge').some((f) => supply.includes(f.field))).toBe(false);
		// The rule's words are run comparison's (engine compare.ts).
		const rule = NODE_FIELD_SPECS.supplyRule.spec;
		expect(rule.t === 'enum' && rule.options).toEqual([
			{ value: 'damFirst', label: 'dam only' },
			{ value: 'riverFirst', label: 'river first' },
			{ value: 'trigger', label: 'dam, river when low' },
			{ value: 'runOfRiver', label: 'run of river' }
		]);
		const pump = NODE_FIELD_SPECS.pumpCapacityM3Day.spec;
		expect(formatValue(pump, null)).toBe('no limit');
		expect(formatValue(pump, 1200)).toBe('1\u202f200 m³/day');
		expect(parseValue(pump, '')).toEqual({ ok: true, value: null });
		expect(formatValue(NODE_FIELD_SPECS.supplyTriggerPct.spec, 0.4)).toBe('40 %');
	});

	// Round trip: a value the engine accepts, shown as text and read back, is
	// the same value and still one the engine accepts.
	it('reads back what it shows, for a valid value of every field', () => {
		const sample = (spec: ValueSpec): unknown => {
			switch (spec.t) {
				case 'text':
					return 'Dam farm';
				case 'number':
					return spec.unit === '%' ? 0.35 : spec.int ? 28 : 1.25;
				case 'enum':
					return spec.options[0]!.value;
				case 'monthly':
					// Within 0–1, so a row of fractions (monthly effective rain) is valid too.
					return [0.5, 1, 0.75, 0.2, 0.5, 1, 0.75, 0.2, 0.5, 1, 0.75, 0.25];
				case 'months':
					return [1, 11, 12];
				case 'bool':
					return false;
				case 'date':
					return '2022-03-01';
				case 'node':
					return 'n1';
				case 'system':
					return 'drip';
				case 'pe':
					return { kind: 'monthly', mm: [90, 110, 140, 160, 150, 120, 80, 50, 35, 30, 40, 60], source: 'Station FAO-56 ET₀, 2015–2020' };
				case 'curve':
					return [
						{ levelM: 100, areaM2: 0, volumeM3: 0 },
						{ levelM: 104.5, areaM2: 42_000, volumeM3: 95_000.5 }
					];
				case 'restriction':
					return { reviewDates: ['01-01'], liftDates: ['05-01'], levels: [{ label: 'Level 1', belowPct: 0.6, cuts: { crops: 0.3, domestic: 0.1 } }] };
				case 'ewrDaily':
					return { method: 'tab', scaling: 'mar', tableMarMm3: 12.5, tableAreaKm2: null, tabM3s: new Array(12).fill(0.2), naturalPctM3s: null, reservePctM3s: null };
				case 'destinations':
					return [
						{ nodeId: 'n1', pct: 0.4 },
						{ nodeId: 'n2', pct: 0.6 }
					];
				case 'diversionMonths':
					return [{ coefficient: 2000, exponent: -0.9, maxPct: 0.97 }, ...new Array(11).fill(null)];
			}
		};
		const check = (table: Record<string, { spec: ValueSpec }>, err: (k: string, v: unknown) => string | null, skip: string[] = []) => {
			for (const [k, { spec }] of Object.entries(table)) {
				if (skip.includes(k)) continue;
				const v = sample(spec);
				// The rule is edited whole in its own editor (the draft holds the object), as a PE input is its draft.
				const back = parseValue(spec, spec.t === 'months' ? (v as number[]) : spec.t === 'pe' ? peDraftOf(v, undefined) : spec.t === 'restriction' || spec.t === 'ewrDaily' ? (v as never) : valueText(spec, v));
				expect(back, k).toEqual({ ok: true, value: v });
				expect(err(k, v), k).toBeNull();
			}
		};
		// The GR4J bounds are the engine's own (GR4J_PARAMS).
		// The sediment rate's range is 0–20 % (the sample's 35 % is out of it), and the dam area exponent's
		// 0–1 (the sample's 1.25 is out of it, engine ≥ 1.63.0): their own cases below.
		check(NODE_FIELD_SPECS, nodeFieldError, ['damSedimentPctPerYear', 'damAreaExponent']);
		check(TRANSFER_FIELD_SPECS, transferFieldError);
		check(SETTINGS_SPECS, settingsValueError, ['gr4j.x1', 'gr4j.x2', 'gr4j.x3', 'gr4j.x4']);
	});

	it('reads the unit an off-take’s seepage rejoins below, empty as the source (engine 1.42.0), and a plain node field never empty', () => {
		const spec = TRANSFER_FIELD_SPECS.lossReturnNodeId.spec;
		expect(parseValue(spec, '')).toEqual({ ok: true, value: null });
		expect(formatValue(spec, null)).toBe('the source');
		expect(transferFieldError('lossReturnNodeId', null)).toBeNull();
		expect(parseValue(TRANSFER_FIELD_SPECS.fromNodeId.spec, '')).toEqual({ ok: false, error: 'pick a hydrological unit' });
	});

	it('reads an empty destination as out of the catchment (engine 1.86.0)', () => {
		const spec = TRANSFER_FIELD_SPECS.toNodeId.spec;
		expect(parseValue(spec, '')).toEqual({ ok: true, value: null });
		expect(formatValue(spec, null)).toBe('outside the catchment');
		expect(transferFieldError('toNodeId', null)).toBeNull();
	});
});

describe('development over the run (engine 1.30.0, issue #67)', () => {
	it('offers the dam fields on a farm, the abstraction start on a farm and a user, and none on a gauge', () => {
		const dev = ['damSurveyDate', 'damSedimentPctPerYear', 'damInServiceFrom', 'abstractionFrom'];
		expect(nodeFields('farm').filter((f) => dev.includes(f.field))).toEqual([
			{ field: 'damSurveyDate', label: 'Dam survey date' },
			{ field: 'damSedimentPctPerYear', label: 'Dam capacity lost to sediment a year' },
			{ field: 'damInServiceFrom', label: 'Dam in service from' },
			{ field: 'abstractionFrom', label: 'Abstraction starts' }
		]);
		expect(nodeFields('user').filter((f) => dev.includes(f.field))).toEqual([{ field: 'abstractionFrom', label: 'Abstraction starts' }]);
		expect(nodeFields('gauge').some((f) => dev.includes(f.field))).toBe(false);
	});

	it('takes a dam area exponent above 0 up to 1, which the engine checks (engine ≥ 1.63.0)', () => {
		const spec = NODE_FIELD_SPECS.damAreaExponent.spec;
		expect(parseValue(spec, '0.7')).toEqual({ ok: true, value: 0.7 });
		expect(nodeFieldError('damAreaExponent', 0.7)).toBeNull();
		expect(nodeFieldError('damAreaExponent', 1)).toBeNull();
		expect(nodeFieldError('damAreaExponent', 1.25)).toMatch(/at most 1/);
	});

	it('reads a sediment rate as a percentage within 0–20 %, and a date as the engine checks it', () => {
		const rate = NODE_FIELD_SPECS.damSedimentPctPerYear.spec;
		expect(parseValue(rate, '1.5')).toEqual({ ok: true, value: 0.015 });
		expect(parseValue(rate, '')).toEqual({ ok: true, value: null });
		expect(formatValue(rate, 0.015)).toBe('1.5 %');
		expect(formatValue(rate, null)).toBe('none');
		expect(nodeFieldError('damSedimentPctPerYear', 0.015)).toBeNull();
		expect(nodeFieldError('damSedimentPctPerYear', 0.25)).not.toBeNull();
		const date = NODE_FIELD_SPECS.damInServiceFrom.spec;
		expect(parseValue(date, '2004-10-01')).toEqual({ ok: true, value: '2004-10-01' });
		expect(parseValue(date, '')).toEqual({ ok: true, value: null });
		expect(formatValue(date, null)).toBe('the whole run');
		expect(nodeFieldError('abstractionFrom', '2004-02-30')).not.toBeNull();
	});
});

describe('a dam survey curve (engine 1.20.0)', () => {
	const spec = NODE_FIELD_SPECS.damCurve.spec;
	it('reads pasted rows as the Network form does, and empty as none', () => {
		expect(spec).toEqual({ t: 'curve' });
		expect(parseValue(spec, 'level\tarea\tvolume\n0\t0\t0\n5.5\t60000\t180000\n')).toEqual({
			ok: true,
			value: [
				{ levelM: 0, areaM2: 0, volumeM3: 0 },
				{ levelM: 5.5, areaM2: 60_000, volumeM3: 180_000 }
			]
		});
		expect(parseValue(spec, '  ')).toEqual({ ok: true, value: null });
	});
	it('refuses unreadable text and a curve the engine could not use', () => {
		expect(parseValue(spec, '0, 0')).toEqual({ ok: false, error: 'line 1: expected 3 values (level, area, volume), found 2' });
		expect(parseValue(spec, '0, 0, 0')).toEqual({ ok: false, error: 'a survey curve needs at least two rows' });
		expect(parseValue(spec, '0, 0, 100\n1, 10, 100')).toEqual({ ok: false, error: 'two survey rows have the same volume (100 m³)' });
	});
	it('shows the rows back as the paste box reads them, and in a few words', () => {
		const rows = [
			{ levelM: 0, areaM2: 0, volumeM3: 0 },
			{ levelM: 5.5, areaM2: 60_000, volumeM3: 180_000 }
		];
		expect(valueText(spec, rows)).toBe('0, 0, 0\n5.5, 60000, 180000');
		expect(valueText(spec, null)).toBe('');
		expect(formatValue(spec, rows)).toBe('2 survey rows, 180\u202f000 m³ at the top');
		expect(formatValue(spec, null)).toBe('none (power law)');
	});
});

describe('parseValue', () => {
	const pct: ValueSpec = { t: 'number', unit: '%', scale: 100, nullable: false };
	it('stores a percentage as a fraction, and reads grouped and decimal-comma numbers', () => {
		expect(parseValue(pct, '80')).toEqual({ ok: true, value: 0.8 });
		expect(parseValue(pct, '12,5')).toEqual({ ok: true, value: 0.125 });
		expect(parseValue({ t: 'number', unit: 'm³', scale: 1, nullable: false }, '180,000')).toEqual({ ok: true, value: 180_000 });
	});
	it('reads a typed date day first and gives it back day first', () => {
		const date = { t: 'date', nullLabel: 'the whole run' } as const;
		expect(parseValue(date, '1 Mar 2022')).toEqual({ ok: true, value: '2022-03-01' });
		expect(parseValue(date, '01/03/2022')).toEqual({ ok: true, value: '2022-03-01' });
		expect(parseValue(date, '2022-03-01')).toEqual({ ok: true, value: '2022-03-01' });
		expect(valueText(date, '2022-03-01')).toBe('1 Mar 2022');
	});
	it('is null only where the field allows it', () => {
		expect(parseValue(pct, '')).toEqual({ ok: false, error: 'enter a number' });
		expect(parseValue({ t: 'number', unit: 'm²', scale: 1, nullable: true }, ' ')).toEqual({ ok: true, value: null });
		expect(parseValue({ t: 'date', nullLabel: 'start' }, '')).toEqual({ ok: true, value: null });
	});
	it('refuses what isn’t a value of the field', () => {
		expect(parseValue(pct, 'lots')).toEqual({ ok: false, error: '“lots” isn\'t a number' });
		expect(parseValue({ t: 'number', unit: '', scale: 1, nullable: false, int: true }, '2.5')).toEqual({ ok: false, error: 'enter a whole number' });
		expect(parseValue({ t: 'date', nullLabel: '' }, '2021-02-30')).toEqual({ ok: false, error: 'type a day, day first: 15 Nov 2021, 15/11/2021 or 2021-11-15' });
		expect(parseValue({ t: 'date', nullLabel: '' }, '11/15/2021')).toEqual({ ok: false, error: 'type a day, day first: 15 Nov 2021, 15/11/2021 or 2021-11-15' });
		expect(parseValue({ t: 'enum', options: [{ value: 'a', label: 'A' }] }, 'b')).toEqual({ ok: false, error: 'pick one of the options' });
		expect(parseValue({ t: 'text' }, '  ')).toEqual({ ok: false, error: 'enter a name' });
	});
	it('reads 12 monthly values however they are separated, or one value for every month', () => {
		const m: ValueSpec = { t: 'monthly', unit: 'mm', scale: 1, nullable: false };
		const twelve = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
		expect(parseValue(m, twelve.join(' '))).toEqual({ ok: true, value: twelve });
		expect(parseValue(m, twelve.join(', '))).toEqual({ ok: true, value: twelve });
		expect(parseValue(m, twelve.join(','))).toEqual({ ok: true, value: twelve });
		expect(parseValue(m, twelve.join('; '))).toEqual({ ok: true, value: twelve });
		expect(parseValue(m, '1,5; 2')).toEqual({ ok: false, error: 'enter 12 values, Oct to Sep (got 2)' });
		expect(parseValue(m, '150')).toEqual({ ok: true, value: new Array(12).fill(150) });
		expect(parseValue(m, '1 2 3 4 5 x 7 8 9 10 11 12')).toEqual({ ok: false, error: 'Mar: “x” isn\'t a number' });
	});
	it('sorts ticked months into a set', () => {
		expect(parseValue({ t: 'months' }, [12, 1, 12, 11])).toEqual({ ok: true, value: [1, 11, 12] });
	});
});

describe('formatValue', () => {
	it('shows units, percentages and each field’s “none”', () => {
		expect(formatValue(NODE_FIELD_SPECS.damCapacityM3.spec, 180_000)).toBe('180\u202f000 m³');
		expect(formatValue(NODE_FIELD_SPECS.irrigationEfficiency.spec, 0.8)).toBe('80 %');
		expect(formatValue(NODE_FIELD_SPECS.damAreaFullM2.spec, null)).toBe('estimated (7.2 × capacity^0.77)');
		expect(formatValue(SETTINGS_SPECS.chirpsBiasCorrection.spec, 'none')).toBe('None');
		expect(formatValue(SETTINGS_SPECS.simulationStart.spec, null)).toBe('first day with rain');
		expect(formatValue(SETTINGS_SPECS.apanMm.spec, new Array(12).fill(100))).toBe('100 mm every month');
		expect(formatValue(TRANSFER_FIELD_SPECS.enabled.spec, false)).toBe('no');
		expect(formatValue(TRANSFER_FIELD_SPECS.toNodeId.spec, 'n1', (id) => (id === 'n1' ? 'Lower farm' : id))).toBe('Lower farm');
		expect(formatValue(NODE_FIELD_SPECS.name.spec, 'Hilltop')).toBe('“Hilltop”');
	});
	it('writes months in calendar order', () => {
		expect(monthsText([12, 11, 1])).toBe('Jan, Nov, Dec');
		expect(monthsText([])).toBe('no months');
		expect(monthsText([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBe('every month');
	});
});

it('reads a dotted settings path', () => {
	expect(settingsValue({ gr4j: { x1: 300 }, apanMm: [1] }, 'gr4j.x1')).toBe(300);
	expect(settingsValue({ apanMm: [1] }, 'apanMm')).toEqual([1]);
	expect(settingsValue({}, 'gr4j.x1')).toBeUndefined();
});

it('puts an engine range message in the percent that was typed', () => {
	const pct = NODE_FIELD_SPECS.damMinPct.spec;
	expect(percentMessage(pct, 'must be at most 1')).toBe('must be at most 100 %');
	expect(percentMessage(pct, 'must be above 0')).toBe('must be above 0 %');
	expect(percentMessage(NODE_FIELD_SPECS.damCapacityM3.spec, 'must be at least 0')).toBe('must be at least 0');
});

describe('the GR4J PE input (settings.pe, issue #39)', () => {
	const spec = SETTINGS_SPECS.pe.spec;
	const monthly = { kind: 'monthly' as const, mm: [90, 110, 140, 160, 150, 120, 80, 50, 35, 30, 40, 60], source: 'Station ET₀' };

	it('round-trips both kinds through the form draft, each one the engine accepts', () => {
		for (const v of [{ kind: 'pan' as const }, monthly]) {
			const draft = peDraftOf(v, undefined);
			expect(parseValue(spec, draft)).toEqual({ ok: true, value: v });
			expect(settingsValueError('pe', v)).toBeNull();
		}
		expect(peDraftOf({ kind: 'pan' }, undefined)).toEqual({ kind: 'pan', mm: '', source: '' });
		expect(valueText(spec, monthly)).toBe('90 110 140 160 150 120 80 50 35 30 40 60');
	});

	it('reads an unset input as pan × A-pan, as the engine runs it', () => {
		expect(peDraftOf(undefined, undefined)).toEqual({ kind: 'pan', mm: '', source: '' });
		expect(formatValue(spec, null)).toBe('pan coefficient × A-pan');
		expect(formatValue(spec, monthly)).toBe('monthly, entered directly: 1\u202f065 mm a year (Station ET₀)');
	});

	it('starts a new monthly row from the PE GR4J runs on now, with the source blank', () => {
		const settings = { apanMm: new Array(12).fill(200), panCoefficient: new Array(12).fill(0.75) };
		expect(peDraftOf({ kind: 'pan' }, settings, 'monthly')).toEqual({ kind: 'monthly', mm: new Array(12).fill(150).join(' '), source: '' });
		// Already monthly: kept as it is.
		expect(peDraftOf(monthly, settings, 'monthly').source).toBe('Station ET₀');
		expect(peDraftOf(monthly, settings, 'pan')).toEqual({ kind: 'pan', mm: '', source: '' });
	});

	it('refuses a monthly row without a source, with a bad value, or with too long a source (the Settings form’s rules)', () => {
		expect(parseValue(spec, { kind: 'monthly', mm: '100', source: '  ' })).toEqual({ ok: false, error: 'say where the monthly PE comes from: its source is required' });
		expect(parseValue(spec, { kind: 'monthly', mm: '1 2 3', source: 'x' })).toEqual({ ok: false, error: 'enter 12 values, Oct to Sep (got 3)' });
		expect(parseValue(spec, { kind: 'monthly', mm: '20000', source: 'x' })).toMatchObject({ ok: false, error: expect.stringMatching(/^monthly PE must be 0 to 10\u202f000 mm in every month/) });
		expect(parseValue(spec, { kind: 'monthly', mm: '100', source: 'x'.repeat(PE_SOURCE_MAX + 1) })).toMatchObject({ ok: false, error: expect.stringMatching(/^the PE source is at most/) });
		expect(parseValue(spec, 'pan')).toEqual({ ok: false, error: 'pick where the PE comes from' });
	});
});

describe('the hands-off flow and River to dam by month (engine 1.32.0, issue #204)', () => {
	const handsOff = NODE_FIELD_SPECS.handsOffM3Day.spec;
	const divert = NODE_FIELD_SPECS.divertMonthlyM3Day.spec;
	const ewr = NODE_FIELD_SPECS.handsOffEwr.spec;
	const row = [0.0129, 12_345.5, 0, 0, 150, 150, 150, 800, 800, 800, 800, 0];

	it('shows none for no row, and reads an empty box back as none', () => {
		for (const spec of [handsOff, divert]) {
			expect(formatValue(spec, null)).toBe('none');
			expect(valueText(spec, null)).toBe('');
			expect(parseValue(spec, '')).toEqual({ ok: true, value: null });
		}
	});

	it('round-trips 12 values through the text box, every figure kept', () => {
		for (const spec of [handsOff, divert]) {
			expect(parseValue(spec, valueText(spec, row))).toEqual({ ok: true, value: row });
			expect(nodeFieldError(spec === handsOff ? 'handsOffM3Day' : 'divertMonthlyM3Day', row)).toBeNull();
		}
		expect(formatValue(handsOff, new Array(12).fill(150))).toBe('150 m³/day every month');
		// River to dam is shown in m³/s (stored m³/day): 864 m³/day is 0.01 m³/s.
		expect(formatValue(divert, [864, 17_280, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe('0.01, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 m³/s (Oct–Sep)');
		expect(parseValue(divert, '1 2 3')).toEqual({ ok: false, error: 'enter 12 values, Oct to Sep (got 3)' });
	});

	it('keeps the EWR as yes or no', () => {
		expect(formatValue(ewr, true)).toBe('yes');
		expect(formatValue(ewr, false)).toBe('no');
		expect(valueText(ewr, true)).toBe('true');
		expect(parseValue(ewr, valueText(ewr, true))).toEqual({ ok: true, value: true });
		expect(parseValue(ewr, valueText(ewr, false))).toEqual({ ok: true, value: false });
		expect(parseValue(ewr, 'maybe')).toEqual({ ok: false, error: 'pick yes or no' });
	});
});

describe('a crop and a land-cover patch (crop.set, landCover.set, engine 1.35.0)', () => {
	it('has a spec for every crop and land-cover field the engine lets a scenario set, and no others', () => {
		expect(Object.keys(CROP_FIELD_SPECS).sort()).toEqual([...CROP_SET_FIELDS].sort());
		expect(Object.keys(LAND_COVER_FIELD_SPECS).sort()).toEqual([...LAND_COVER_SET_FIELDS].sort());
	});

	it('reads back what it shows, each value one the engine accepts', () => {
		const cases: [ValueSpec, unknown, (v: unknown) => string | null][] = [
			[CROP_FIELD_SPECS.name.spec, 'Stone fruit', (v) => cropFieldError('name', v)],
			[CROP_FIELD_SPECS.cropFactor.spec, [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 0.5, 0.4], (v) => cropFieldError('cropFactor', v)],
			[CROP_FIELD_SPECS.irrigationEfficiency.spec, 0.85, (v) => cropFieldError('irrigationEfficiency', v)],
			[CROP_FIELD_SPECS.irrigationEfficiency.spec, null, (v) => cropFieldError('irrigationEfficiency', v)],
			[LAND_COVER_FIELD_SPECS.coverClass.spec, 'invasive', (v) => landCoverFieldError('coverClass', v)],
			[LAND_COVER_FIELD_SPECS.areaKm2.spec, 1.25, (v) => landCoverFieldError('areaKm2', v)],
			[LAND_COVER_FIELD_SPECS.densityPct.spec, 0.35, (v) => landCoverFieldError('densityPct', v)],
			[LAND_COVER_FIELD_SPECS.factors.spec, { mar: 0.2, lowFlow: 0.35 }, (v) => landCoverFieldError('factors', v)],
			[LAND_COVER_FIELD_SPECS.factors.spec, null, (v) => landCoverFieldError('factors', v)]
		];
		for (const [spec, v, check] of cases) {
			const back = parseValue(spec, valueText(spec, v));
			expect(back, JSON.stringify(v)).toEqual({ ok: true, value: v });
			expect(check(v)).toBeNull();
		}
	});

	it('shows reductions as percentages, the class’s when none, and refuses anything but two numbers', () => {
		const s = LAND_COVER_FIELD_SPECS.factors.spec;
		expect(formatValue(s, null)).toBe("the class's");
		expect(formatValue(s, { mar: 0.2, lowFlow: 0.35 })).toBe('MAR −20 %, low flow −35 %');
		expect(parseValue(s, '20 %, 35 %')).toEqual({ ok: true, value: { mar: 0.2, lowFlow: 0.35 } });
		expect(parseValue(s, '20')).toMatchObject({ ok: false });
		expect(parseValue(s, 'a; b')).toMatchObject({ ok: false });
		expect(formatValue(CROP_FIELD_SPECS.irrigationEfficiency.spec, null)).toBe("the hydrological unit's");
	});
});

describe('an other water user’s priority (issue #507 item 4)', () => {
	it('offers the stored senior / junior as Priority / Non-priority, and shows them that way', () => {
		const spec = NODE_FIELD_SPECS.userPriority.spec;
		expect(spec).toMatchObject({ t: 'enum', options: [{ value: 'senior', label: 'Priority' }, { value: 'junior', label: 'Non-priority' }] });
		expect(formatValue(spec, 'junior')).toBe('Non-priority');
	});
});

describe('pump capacities and River to dam in m³/s, l/s or m³/day (issue #523 C2)', () => {
	const PUMPS = [
		NODE_FIELD_SPECS.pumpCapacityM3Day,
		NODE_FIELD_SPECS.cropRiverPumpM3Day,
		NODE_FIELD_SPECS.boreholeCapacityM3Day,
		NODE_FIELD_SPECS.cropRemoteCapM3Day,
		DEMAND_OBJECT_FIELD_SPECS.riverPumpM3Day
	].map((f) => f.spec);
	const RIVER_TO_DAM = [NODE_FIELD_SPECS.divertCapacityM3Day.spec, NODE_FIELD_SPECS.divertMonthlyM3Day.spec];
	/** Run `fn` with the pumps' and River to dam's unit picked, then put both back to their defaults. */
	function picked(id: FlowUnitId, fn: () => void) {
		pumpUnit.set(id);
		riverToDamUnit.set(id);
		try {
			fn();
		} finally {
			pumpUnit.set('m3day');
			riverToDamUnit.set('m3s');
		}
	}

	it('follows the Network form’s pick: every pump field the pumps’ unit, River to dam its own', () => {
		for (const s of PUMPS) expect(s).toMatchObject({ t: 'number', flowUnit: pumpUnit, unit: 'm³/day', scale: 1, nullable: true });
		for (const s of RIVER_TO_DAM) expect(s).toMatchObject({ flowUnit: riverToDamUnit, unit: 'm³/s' });
		picked('ls', () => {
			for (const s of [...PUMPS, ...RIVER_TO_DAM]) expect(s).toMatchObject({ unit: 'l/s', scale: 1000 / 86_400 });
		});
	});

	it('stores what is typed in m³/day, whichever unit it is typed in', () => {
		const pump = NODE_FIELD_SPECS.pumpCapacityM3Day.spec;
		expect(parseValue(pump, '432')).toEqual({ ok: true, value: 432 });
		expect(parseValue(pump, '')).toEqual({ ok: true, value: null });
		picked('ls', () => {
			expect(parseValue(pump, '5')).toEqual({ ok: true, value: 432 });
			expect(parseValue(pump, '12,5')).toEqual({ ok: true, value: 1080 });
			expect(valueText(pump, 432)).toBe('5');
			expect(formatValue(pump, 1080)).toBe('12.5 l/s');
			expect(formatValue(pump, null)).toBe('no limit');
			expect(parseValue(NODE_FIELD_SPECS.divertMonthlyM3Day.spec, '10')).toEqual({ ok: true, value: new Array(12).fill(864) });
		});
		picked('m3s', () => {
			expect(parseValue(DEMAND_OBJECT_FIELD_SPECS.riverPumpM3Day.spec, '0.05')).toEqual({ ok: true, value: 4320 });
			expect(parseValue(NODE_FIELD_SPECS.divertCapacityM3Day.spec, '0.2')).toEqual({ ok: true, value: 17_280 });
		});
	});

	it('reads a stored value back unchanged when its text isn’t edited, in every unit', () => {
		const pump = NODE_FIELD_SPECS.pumpCapacityM3Day.spec;
		for (const id of ['m3s', 'ls', 'm3day'] as const)
			picked(id, () => {
				for (const v of [0, 1, 432, 999.999, 1234.5678, 17_280, 86_400, 123_456.789, 2_000_000 / 7]) {
					const back = parseValue(pump, valueText(pump, v));
					expect(back.ok && (back.value as number)).toBeCloseTo(v, 6);
				}
			});
	});

	it('rewrites the typed text in a new unit, leaving text it can’t read and other fields alone', () => {
		const pump = NODE_FIELD_SPECS.pumpCapacityM3Day.spec;
		picked('m3day', () => {
			// Typed as 5 l/s, then m³/day picked: 432, not 5 m³/day.
			expect(rescaleText(pump, '5', 1000 / 86_400)).toBe('432');
			expect(rescaleText(pump, 'five', 1000 / 86_400)).toBe('five');
			expect(rescaleText(pump, '', 1000 / 86_400)).toBe('');
			expect(rescaleText(NODE_FIELD_SPECS.damCapacityM3.spec, '5', 1000 / 86_400)).toBe('5');
		});
		picked('ls', () => expect(rescaleText(NODE_FIELD_SPECS.divertMonthlyM3Day.spec, '0.01 0.02 0 0 0 0 0 0 0 0 0 0', 1 / 86_400)).toBe('10 20 0 0 0 0 0 0 0 0 0 0'));
	});
});

describe('the transfer fields Add a change offers for a rule (engine 1.14.0 monthly rates)', () => {
	const single = { months: [10, 11, 12], maxRateM3s: 0.2, monthlyRateM3s: null };
	const monthly = withMonthlyRates([0.1, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0.3]);
	const offered = (t: Parameters<typeof transferFieldsFor>[0]) => transferFieldsFor(t).map((f) => f.field);

	it('offers every field for a rule with one maximum rate, and before a rule is picked', () => {
		expect(transferFieldsFor(single)).toEqual(TRANSFER_FIELDS);
		expect(transferFieldsFor({ monthlyRateM3s: undefined })).toEqual(TRANSFER_FIELDS);
		expect(transferFieldsFor(undefined)).toEqual(TRANSFER_FIELDS);
	});

	it('drops the months and the one maximum rate for a rule with monthly rates, and keeps the monthly rates and the rest', () => {
		const fields = offered(monthly);
		expect(fields).not.toContain('months');
		expect(fields).not.toContain('maxRateM3s');
		expect(fields).toContain('monthlyRateM3s');
		expect(fields).toEqual(TRANSFER_FIELDS.map((f) => f.field).filter((f) => f !== 'months' && f !== 'maxRateM3s'));
	});

	it('hides exactly the rate fields whose change the engine’s save rule refuses on that rule', () => {
		// A change to each rate field, applied the way transfer.set applies it (monthlyRateM3s also sets the pair).
		const changed = {
			months: (t: typeof monthly) => ({ ...t, months: [...t.months, 1] }),
			maxRateM3s: (t: typeof monthly) => ({ ...t, maxRateM3s: t.maxRateM3s + 1 }),
			monthlyRateM3s: (t: typeof monthly) => ({ ...t, ...withMonthlyRates(t.monthlyRateM3s.map((x) => x * 2)) })
		};
		expect(monthlyRatesMismatch(monthly)).toBeNull();
		for (const [field, change] of Object.entries(changed)) expect(offered(monthly).includes(field as never), field).toBe(monthlyRatesMismatch(change(monthly)) === null);
		// On a rule with one rate the pair is free to change.
		expect(monthlyRatesMismatch({ ...single, months: [1, 2], maxRateM3s: 5 })).toBeNull();
	});
});

describe('the choices Add a change offers for a transfer field: exactly what the engine takes on that rule', () => {
	// Synthetic ids and invented names. HI drains into LO, LO into UP, UP into the outlet gauge; US is an other water user.
	const G = '00000000-0000-4000-8000-000000000001';
	const UP = '00000000-0000-4000-8000-000000000002';
	const LO = '00000000-0000-4000-8000-000000000003';
	const HI = '00000000-0000-4000-8000-000000000004';
	const US = '00000000-0000-4000-8000-000000000005';
	const DAM = '00000000-0000-4000-8000-0000000000a1';
	const OUT = '00000000-0000-4000-8000-0000000000a2';
	const RIVER = '00000000-0000-4000-8000-0000000000a3';
	const CURVE = '00000000-0000-4000-8000-0000000000a4';
	const MONTHLY = '00000000-0000-4000-8000-0000000000a5';
	const UNITS = [UP, LO, HI];
	const rule = (id: string, from: string, to: string | null, more: Partial<Transfer> = {}): Transfer => ({
		id,
		fromNodeId: from,
		toNodeId: to,
		months: [11, 12],
		maxRateM3s: 0.01,
		dailyCapM3: null,
		minStoragePct: 0.2,
		enabled: true,
		priority: 0,
		...more
	});
	const curve = { diversionCoefficient: 2, diversionExponent: 0.5, diversionMaxPct: 0.4, diversionFlowUnit: 'm3/s', diversionFlowBasis: 'modelled' } as const;
	function base(): ModelInput {
		const farm = (id: string, i: number, down: string, name: string) => ({ ...newNode(i, down), id, name, areaKm2: 10, damCapacityM3: 100_000 });
		const user = { ...newNode(4, UP), id: US, kind: 'user' as const, name: 'Town' };
		return snapshotInput(
			{
				nodes: [{ ...newNode(0, null), id: G, name: 'Outflow gauge' }, farm(UP, 1, G, 'Upper farm'), farm(LO, 2, UP, 'Lower farm'), farm(HI, 3, LO, 'Hill farm'), user],
				crops: [],
				cropAreas: [],
				transfers: [
					rule(DAM, UP, LO),
					rule(OUT, UP, null),
					rule(RIVER, LO, UP, { source: 'river', sizing: 'demand' }),
					rule(CURVE, LO, UP, { source: 'river', sizing: 'diversionCurve', ...curve }),
					rule(MONTHLY, LO, HI, withMonthlyRates([0.1, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0.3]))
				]
			},
			{ simulationStart: null, apanMm: new Array(12).fill(100) }
		);
	}
	const input = base();
	const accepted = (id: string, field: TransferSetField, value: unknown) => applyScenario(input, [{ op: 'transfer.set', transferId: id, field, value } as ScenarioOp]).problems.length === 0;
	const choices = (id: string, field: TransferSetField) => transferChoices(input, id, field, UNITS);

	it('starts from a model the engine takes whole', () => {
		expect(applyScenario(input, []).problems).toEqual([]);
	});

	it('offers a share of the river’s flow only on a river off-take with a complete curve', () => {
		expect(choices(DAM, 'sizing')).toEqual(['demand', 'capacity']);
		expect(choices(RIVER, 'sizing')).toEqual(['demand', 'capacity']);
		expect(choices(CURVE, 'sizing')).toEqual(['demand', 'capacity', 'diversionCurve']);
	});

	it('offers the river as the source only to a rule that can be an off-take, and the dam only to one not sized by a formula', () => {
		// Upper → Lower: Lower drains into Upper, so as an off-take it would take water before it arrives.
		expect(choices(DAM, 'source')).toEqual(['dam']);
		expect(choices(RIVER, 'source')).toEqual(['dam', 'river']);
		// Out of the catchment: a dam rule only.
		expect(choices(OUT, 'source')).toEqual(['dam']);
		expect(choices(CURVE, 'source')).toEqual(['river']);
	});

	it('offers out of the catchment and the ends a rule may have, never its own source or one that loops an off-take', () => {
		expect(choices(DAM, 'toNodeId')).toEqual(['', LO, HI]);
		// An off-take from LO: not out of the catchment, not to itself, not to HI, which drains into it.
		expect(choices(RIVER, 'toNodeId')).toEqual([UP]);
		expect(choices(DAM, 'fromNodeId')).toEqual([UP, HI]);
		// Its seepage rejoins the river at the source (none, or named) or below it, never above.
		expect(choices(RIVER, 'lossReturnNodeId')).toEqual(['', UP, LO]);
		expect(choices(RIVER, 'diversionFlowUnit')).toContain('');
		expect(choices(CURVE, 'diversionFlowUnit')).not.toContain('');
	});

	it('agrees with the engine on every choice of every choice field of every rule', () => {
		for (const t of input.model.transfers)
			for (const field of Object.keys(TRANSFER_FIELD_SPECS) as TransferSetField[]) {
				const spec = TRANSFER_FIELD_SPECS[field].spec;
				const all =
					spec.t === 'enum' ? [...(spec.nullable ? [''] : []), ...spec.options.map((o) => o.value)] : spec.t === 'bool' ? ['true', 'false'] : spec.t === 'node' ? [...(spec.nullLabel !== undefined ? [''] : []), ...UNITS] : null;
				const got = choices(t.id, field);
				if (!all) {
					expect(got, field).toBeNull();
					continue;
				}
				const value = (text: string) => (spec.t === 'bool' ? text === 'true' : text === '' ? null : text);
				expect(got, `${t.id} ${field}`).toEqual(all.filter((text) => accepted(t.id, field, value(text))));
			}
		expect(transferChoices(input, '00000000-0000-4000-8000-0000000000ff', 'sizing', UNITS)).toBeNull();
	});

	it('hides the months and the one maximum rate exactly where the engine refuses a change to them', () => {
		for (const t of input.model.transfers) {
			const fields = transferFieldsFor(t).map((f) => f.field);
			expect(fields.includes('months'), t.id).toBe(accepted(t.id, 'months', [1, 2, 3]));
			expect(fields.includes('maxRateM3s'), t.id).toBe(accepted(t.id, 'maxRateM3s', 0.7));
			expect(fields.includes('monthlyRateM3s')).toBe(true);
		}
		expect(transferFieldsFor(input.model.transfers.find((t) => t.id === MONTHLY)).map((f) => f.field)).not.toContain('months');
	});
});
