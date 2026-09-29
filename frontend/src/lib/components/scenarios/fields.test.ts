import { NODE_SET_FIELDS, PE_SOURCE_MAX, SETTINGS_PATHS, TRANSFER_SET_FIELDS, nodeFieldError, settingsValueError, transferFieldError } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import {
	NODE_FIELD_SPECS,
	SETTINGS_SPECS,
	TRANSFER_FIELD_SPECS,
	formatValue,
	monthsText,
	nodeFields,
	parseValue,
	peDraftOf,
	percentMessage,
	settingsValue,
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
		// A gauge: its name, and whether it is an EWR site (engine 1.5.0).
		expect(nodeFields('gauge')).toEqual([
			{ field: 'name', label: 'Name' },
			{ field: 'ewrSite', label: 'EWR site' }
		]);
		expect(nodeFields('farm').map((f) => f.field)).toEqual([...NODE_SET_FIELDS.farm]);
	});

	it('offers a farm its supply rule and river pump (WP-3.8), never a user or gauge', () => {
		const supply = ['supplyRule', 'pumpCapacityM3Day', 'supplyTriggerPct', 'supplyStopPct'];
		expect(nodeFields('farm').filter((f) => supply.includes(f.field))).toEqual([
			{ field: 'supplyRule', label: 'Supply rule' },
			{ field: 'pumpCapacityM3Day', label: 'River pump capacity' },
			{ field: 'supplyTriggerPct', label: 'Supply switch-to-river level' },
			{ field: 'supplyStopPct', label: 'Supply switch-back level' }
		]);
		expect(nodeFields('user').some((f) => supply.includes(f.field))).toBe(false);
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
				case 'pe':
					return { kind: 'monthly', mm: [90, 110, 140, 160, 150, 120, 80, 50, 35, 30, 40, 60], source: 'Station FAO-56 ET₀, 2015–2020' };
				case 'curve':
					return [
						{ levelM: 100, areaM2: 0, volumeM3: 0 },
						{ levelM: 104.5, areaM2: 42_000, volumeM3: 95_000.5 }
					];
			}
		};
		const check = (table: Record<string, { spec: ValueSpec }>, err: (k: string, v: unknown) => string | null, skip: string[] = []) => {
			for (const [k, { spec }] of Object.entries(table)) {
				if (skip.includes(k)) continue;
				const v = sample(spec);
				const back = parseValue(spec, spec.t === 'months' ? (v as number[]) : spec.t === 'pe' ? peDraftOf(v, undefined) : valueText(spec, v));
				expect(back, k).toEqual({ ok: true, value: v });
				expect(err(k, v), k).toBeNull();
			}
		};
		// The GR4J bounds are the engine's own (GR4J_PARAMS).
		check(NODE_FIELD_SPECS, nodeFieldError);
		check(TRANSFER_FIELD_SPECS, transferFieldError);
		check(SETTINGS_SPECS, settingsValueError, ['gr4j.x1', 'gr4j.x2', 'gr4j.x3', 'gr4j.x4']);
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
	it('is null only where the field allows it', () => {
		expect(parseValue(pct, '')).toEqual({ ok: false, error: 'enter a number' });
		expect(parseValue({ t: 'number', unit: 'm²', scale: 1, nullable: true }, ' ')).toEqual({ ok: true, value: null });
		expect(parseValue({ t: 'date', nullLabel: 'start' }, '')).toEqual({ ok: true, value: null });
	});
	it('refuses what isn’t a value of the field', () => {
		expect(parseValue(pct, 'lots')).toEqual({ ok: false, error: '“lots” isn\'t a number' });
		expect(parseValue({ t: 'number', unit: '', scale: 1, nullable: false, int: true }, '2.5')).toEqual({ ok: false, error: 'enter a whole number' });
		expect(parseValue({ t: 'date', nullLabel: '' }, '2021-02-30')).toEqual({ ok: false, error: 'enter a date as YYYY-MM-DD' });
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
		expect(formatValue(NODE_FIELD_SPECS.damAreaFullM2.spec, null)).toBe('estimated (capacity ÷ 3 m)');
		expect(formatValue(SETTINGS_SPECS.flowShareMethod.spec, 'hiLo')).toBe('High/low MAP');
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
