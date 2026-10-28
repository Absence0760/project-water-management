// The S-pan → A-pan inversion (spanToApan.ts; docs/model.md §2.3a, issue #646 item 6).
import { describe, expect, it } from 'vitest';
import { lakeFactorPresetFill, SPAN_FROM_APAN } from './lakeFactorPresets';
import { apanFromSpan, apanMonthlyFromSpan, isSpanConversionId, SPAN_CONVERSIONS, spanConversionFloorMm } from './spanToApan';

const SPAN = [150, 180, 210, 230, 190, 160, 100, 70, 50, 55, 75, 110];

describe('apanFromSpan', () => {
	it('inverts each published S ← A equation exactly (round trip)', () => {
		for (const c of Object.values(SPAN_FROM_APAN)) {
			for (const a of [40, 120, 300]) expect(apanFromSpan(c.slope * a + c.interceptMm, c)).toBeCloseTo(a, 10);
		}
	});

	it('gives Taljaard’s 0.8706 / −11.1745 at a worked value: S 100 mm → A 127.70 mm', () => {
		expect(apanFromSpan(100, SPAN_FROM_APAN.taljaard2023)).toBeCloseTo((100 + 11.1745) / 0.8706, 10);
		expect(apanFromSpan(100, SPAN_FROM_APAN.taljaard2023)).toBeCloseTo(127.7, 1);
	});

	it('never goes negative: an S of 0 gives −b ÷ a, which is why small values are refused instead', () => {
		expect(apanFromSpan(0, SPAN_FROM_APAN.wr90)).toBeCloseTo(16.2354 / 0.8793, 10);
	});
});

describe('spanConversionFloorMm', () => {
	it('is the forward floor’s S-pan, −2b (WR90 32.5 mm, Taljaard 22.3 mm)', () => {
		expect(spanConversionFloorMm(SPAN_FROM_APAN.wr90)).toBeCloseTo(2 * 16.2354, 9);
		expect(spanConversionFloorMm(SPAN_FROM_APAN.taljaard2023)).toBeCloseTo(2 * 11.1745, 9);
	});
});

describe('apanMonthlyFromSpan', () => {
	it('converts 12 means to one decimal and cites the inverted equation', () => {
		const r = apanMonthlyFromSpan(SPAN, 'taljaard2023');
		if (!r.ok) throw new Error(r.reason);
		expect(r.values).toHaveLength(12);
		expect(r.values[0]).toBe(Math.round(((150 + 11.1745) / 0.8706) * 10) / 10);
		expect(r.values.every((a, m) => a > SPAN[m]!)).toBe(true);
		expect(r.note).toContain('A = (S + 11.1745) ÷ 0.8706');
		expect(r.note).toContain('Taljaard (2023)');
	});

	it('the two equations give different rows (the choice matters)', () => {
		const a = apanMonthlyFromSpan(SPAN, 'wr90');
		const b = apanMonthlyFromSpan(SPAN, 'taljaard2023');
		expect(a.ok && b.ok).toBe(true);
		if (a.ok && b.ok) expect(a.values).not.toEqual(b.values);
	});

	it('refuses a month under the floor, naming it (positive control: just above it converts)', () => {
		const floor = spanConversionFloorMm(SPAN_FROM_APAN.wr90);
		const low = [...SPAN];
		low[8] = floor - 0.1; // Jun
		const r = apanMonthlyFromSpan(low, 'wr90');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/S-pan in Jun is below 32\.5 mm/);
		low[8] = floor + 0.1;
		expect(apanMonthlyFromSpan(low, 'wr90').ok).toBe(true);
	});

	it('refuses a missing, negative or non-finite month', () => {
		expect(apanMonthlyFromSpan(SPAN.slice(0, 11), 'wr90').ok).toBe(false);
		expect(apanMonthlyFromSpan([...SPAN.slice(0, 11), -1], 'wr90').ok).toBe(false);
		expect(apanMonthlyFromSpan([...SPAN.slice(0, 11), Number.NaN], 'wr90').ok).toBe(false);
	});

	it('gives an A-pan row a WR90 lake-factor preset accepts (at or above its floor)', () => {
		for (const { id } of SPAN_CONVERSIONS) {
			const floor = spanConversionFloorMm(SPAN_FROM_APAN[id]);
			const r = apanMonthlyFromSpan(new Array(12).fill(floor + 0.2), id);
			if (!r.ok) throw new Error(r.reason);
			expect(lakeFactorPresetFill(id === 'wr90' ? 'wr90' : 'wr90-taljaard2023', r.values).ok).toBe(true);
		}
	});

	it('knows its ids', () => {
		expect(isSpanConversionId('wr90')).toBe(true);
		expect(isSpanConversionId('taljaard2023')).toBe(true);
		expect(isSpanConversionId('toString')).toBe(false);
		expect(isSpanConversionId(3)).toBe(false);
	});
});
