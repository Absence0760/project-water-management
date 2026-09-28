import { describe, expect, it } from 'vitest';
import { MAX_EXPORT_BYTES } from '../export/csv.js';
import type { DailyScope } from '../export/daily-columns.js';
import { BULK_PAGE_VALUES, bulkPage, bulkPageDays, MAX_VALUE_BYTES, type BulkPage } from './bulk.js';

const scope = (series: number, days: number, value: (i: number) => number | null = (i) => i): DailyScope => ({
	name: 'Upper farm',
	kind: 'farm',
	series: Array.from({ length: series }, (_, s) => ({
		key: `k${s}`,
		label: `Series ${s}`,
		unit: 'm³/day',
		header: `Series ${s} [X] (m³/day)`,
		values: Array.from({ length: days }, (_, i) => value(i))
	}))
});

describe('bulk series paging', () => {
	it('no double or null is longer than MAX_VALUE_BYTES with its comma', () => {
		for (const v of [-2.2250738585072014e-308, -1.7976931348623157e308, -0.000001234567890123456, -123456789.12345679, null]) {
			expect(JSON.stringify(v).length + 1).toBeLessThanOrEqual(MAX_VALUE_BYTES);
		}
	});

	it('sizes a page by the series count', () => {
		expect(bulkPageDays(32)).toBe(Math.floor(BULK_PAGE_VALUES / 32));
		expect(bulkPageDays(0)).toBe(BULK_PAGE_VALUES);
		expect(bulkPageDays(10 * BULK_PAGE_VALUES)).toBe(1);
	});

	it('returns a short record in one page', () => {
		const p = bulkPage(scope(3, 120), null, '2021-10-01', 0)!;
		expect(p).toMatchObject({ name: 'Upper farm', kind: 'farm', startDate: '2021-10-01', days: 120, offset: 0, count: 120, next: null });
		expect(p.series.map((s) => s.header)).toEqual(['Series 0 [X] (m³/day)', 'Series 1 [X] (m³/day)', 'Series 2 [X] (m³/day)']);
		expect(p.series[2]!.values).toEqual(Array.from({ length: 120 }, (_, i) => i));
	});

	it('pages a long record without losing or repeating a day', () => {
		const days = 60_000;
		const s = scope(40, days);
		const got: (number | null)[] = [];
		let offset: number | null = 0;
		let pages = 0;
		while (offset !== null) {
			const p: BulkPage = bulkPage(s, 'n', '1950-01-01', offset)!;
			expect(p.offset).toBe(offset);
			expect(p.series.every((c) => c.values.length === p.count)).toBe(true);
			got.push(...p.series[39]!.values);
			offset = p.next;
			pages++;
		}
		expect(got).toEqual(s.series[39]!.values);
		expect(pages).toBe(Math.ceil(days / bulkPageDays(40)));
	});

	it('keeps the worst-case page under the export cap', () => {
		// Every value at the longest JSON a double can take, 40 series with long labels.
		const s = scope(40, 60_000, () => -2.2250738585072014e-308);
		for (const c of s.series) c.header = c.label = 'x'.repeat(300);
		const body = JSON.stringify(bulkPage(s, '00000000-0000-4000-8000-000000000000', '1950-01-01', 0));
		expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX_EXPORT_BYTES);
		// …and uses most of it, so a page isn't needlessly small.
		expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(0.9 * MAX_EXPORT_BYTES);
	});

	it('pads a shorter series with null and refuses an offset past the run', () => {
		const s = scope(2, 10);
		s.series[1]!.values = s.series[1]!.values.slice(0, 4);
		expect(bulkPage(s, null, '2021-10-01', 0)!.series[1]!.values).toEqual([0, 1, 2, 3, null, null, null, null, null, null]);
		expect(bulkPage(s, null, '2021-10-01', 10)).toBeNull();
	});
});
