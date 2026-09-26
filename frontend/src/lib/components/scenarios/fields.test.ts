import { NODE_SET_FIELDS, SETTINGS_PATHS, TRANSFER_SET_FIELDS, nodeFieldError, settingsValueError, transferFieldError } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import {
	NODE_FIELD_SPECS,
	SETTINGS_SPECS,
	TRANSFER_FIELD_SPECS,
	formatValue,
	monthsText,
	nodeFields,
	parseValue,
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
		expect(nodeFields('gauge')).toEqual([{ field: 'name', label: 'Name' }]);
		expect(nodeFields('farm').map((f) => f.field)).toEqual([...NODE_SET_FIELDS.farm]);
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
					return [0.5, 1, 1.5, 2, 0.5, 1, 1.5, 2, 0.5, 1, 1.5, 0.25];
				case 'months':
					return [1, 11, 12];
				case 'bool':
					return false;
				case 'date':
					return '2022-03-01';
				case 'node':
					return 'n1';
			}
		};
		const check = (table: Record<string, { spec: ValueSpec }>, err: (k: string, v: unknown) => string | null, skip: string[] = []) => {
			for (const [k, { spec }] of Object.entries(table)) {
				if (skip.includes(k)) continue;
				const v = sample(spec);
				const back = parseValue(spec, spec.t === 'months' ? (v as number[]) : valueText(spec, v));
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
		expect(formatValue(NODE_FIELD_SPECS.damCapacityM3.spec, 180_000)).toBe('180,000 m³');
		expect(formatValue(NODE_FIELD_SPECS.irrigationEfficiency.spec, 0.8)).toBe('80 %');
		expect(formatValue(NODE_FIELD_SPECS.damAreaFullM2.spec, null)).toBe('estimated (capacity ÷ 3 m)');
		expect(formatValue(SETTINGS_SPECS.flowShareMethod.spec, 'hiLo')).toBe('High/low MAP');
		expect(formatValue(SETTINGS_SPECS.simulationStart.spec, null)).toBe('start of data');
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
