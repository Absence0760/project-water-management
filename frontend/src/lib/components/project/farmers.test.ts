import { describe, expect, it } from 'vitest';
import { BULK_MAX_ROWS, bulkSummary, farmNames, outcomeText, parseFarmerCsv, toggleFarm } from './farmers';

const farms = [
	{ id: 'a', name: 'Farm A' },
	{ id: 'b', name: 'Farm B' },
	{ id: 'c', name: 'Farm C' }
];

describe('farmNames', () => {
	it('names the linked farms in the farms’ order', () => {
		expect(farmNames({ nodeIds: ['c', 'a'] }, farms)).toEqual(['Farm A', 'Farm C']);
		expect(farmNames({ nodeIds: [] }, farms)).toEqual([]);
	});

	it('counts links to farms the model no longer has instead of dropping them', () => {
		expect(farmNames({ nodeIds: ['a', 'gone'] }, farms)).toEqual(['Farm A', 'a removed farm']);
		expect(farmNames({ nodeIds: ['x', 'y'] }, farms)).toEqual(['2 removed farms']);
	});
});

describe('toggleFarm', () => {
	it('adds and removes a farm, keeping the farms’ order', () => {
		expect(toggleFarm(['c'], 'a', farms)).toEqual(['a', 'c']);
		expect(toggleFarm(['a', 'c'], 'a', farms)).toEqual(['c']);
	});
});

describe('parseFarmerCsv', () => {
	it('reads email,farm,language rows without a header, skipping blank lines, with line numbers', () => {
		expect(parseFarmerCsv('ann@example.com,Farm A,af\n\n  ben@example.com , Farm B \r\n')).toEqual({
			rows: [
				{ line: 1, email: 'ann@example.com', farm: 'Farm A', locale: 'af' },
				{ line: 3, email: 'ben@example.com', farm: 'Farm B' }
			],
			problems: []
		});
	});

	it('uses a header row to find the columns, in any order', () => {
		const { rows } = parseFarmerCsv('﻿Language,Farm,Email\nen,Farm A,ann@example.com\n');
		expect(rows).toEqual([{ line: 2, email: 'ann@example.com', farm: 'Farm A', locale: 'en' }]);
		expect(parseFarmerCsv('email,farm\nann@example.com,Farm A').rows).toEqual([{ line: 2, email: 'ann@example.com', farm: 'Farm A' }]);
	});

	it('keeps quoted commas and quotes, and reads semicolon- or tab-separated files', () => {
		expect(parseFarmerCsv('ann@example.com,"Smit, Farm ""Oos"""').rows[0]!.farm).toBe('Smit, Farm "Oos"');
		expect(parseFarmerCsv('ann@example.com;Farm A;af').rows[0]).toEqual({ line: 1, email: 'ann@example.com', farm: 'Farm A', locale: 'af' });
		expect(parseFarmerCsv('ann@example.com\tFarm, A').rows[0]!.farm).toBe('Farm, A');
	});

	it('passes a short row on as it is: the server gives it its own error', () => {
		expect(parseFarmerCsv('ann@example.com').rows).toEqual([{ line: 1, email: 'ann@example.com', farm: '' }]);
	});

	it('flags an empty paste, a header with nothing under it, and more rows than one request takes', () => {
		expect(parseFarmerCsv('  \n').problems).toEqual(['Paste or upload at least one row: email,farm,language.']);
		expect(parseFarmerCsv('email,farm,language\n').problems).toEqual(['The file has a header row but no farmers under it.']);
		const big = Array.from({ length: BULK_MAX_ROWS + 1 }, (_, i) => `f${i}@example.com,Farm A`).join('\n');
		expect(parseFarmerCsv(big).problems).toEqual(['At most 200 rows at a time; this has 201. Split it into several files.']);
	});
});

describe('bulkSummary and outcomeText', () => {
	const results = [{ status: 'added' as const }, { status: 'invited' as const }, { status: 'invited' as const }, { status: 'error' as const, error: 'no farm named “X” in this catchment' }];

	it('counts the outcomes, in the future tense for a preview', () => {
		expect(bulkSummary(results, true)).toBe('1 to add, 2 to invite, 1 with an error');
		expect(bulkSummary(results, false)).toBe('1 added, 2 invited, 1 with an error');
		expect(bulkSummary([{ status: 'error' }, { status: 'error' }], false)).toBe('2 with errors');
		expect(bulkSummary([], false)).toBe('No rows');
	});

	it('says what happens to a row, and shows the server’s error as it is', () => {
		expect(outcomeText(results[0]!, true)).toBe('Will be added (has an account)');
		expect(outcomeText(results[1]!, true)).toBe('Will be invited by email');
		expect(outcomeText(results[1]!, false)).toBe('Invited');
		expect(outcomeText(results[3]!, false)).toBe('no farm named “X” in this catchment');
	});
});
