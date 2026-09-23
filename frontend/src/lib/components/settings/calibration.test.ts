import { describe, expect, it } from 'vitest';
import { calibrationFields, humanise, parseNumberList } from './calibration';

describe('humanise', () => {
	it('splits camelCase and pulls unit suffixes', () => {
		expect(humanise('rainThresholdMm')).toBe('Rain threshold (mm)');
		expect(humanise('baseFlowInitial')).toBe('Base flow initial');
		expect(humanise('recessionM3Day')).toBe('Recession (m³/day)');
		expect(humanise('a')).toBe('a');
	});
});

describe('calibrationFields', () => {
	it('classifies values by type', () => {
		const f = calibrationFields({ a: 0.1, summerMonths: [10, 11], on: true, table: { x: 1 } });
		expect(f.map((x) => x.kind)).toEqual(['number', 'list', 'boolean', 'other']);
	});
});

describe('parseNumberList', () => {
	it('parses comma lists', () => {
		expect(parseNumberList('10, 11,12')).toEqual([10, 11, 12]);
		expect(parseNumberList('')).toEqual([]);
		expect(parseNumberList('1, x')).toBeNull();
	});
});
