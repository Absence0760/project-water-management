import { describe, expect, it } from 'vitest';
import type { DroughtBadge, DroughtBadgeIndex } from '@water-management/engine';
import { droughtHeadline, droughtRows, droughtSeries, droughtTone, noIndexText, periodText, recordText, referenceText } from './drought';

const ref = { kind: 'standard' as const, from: 1991, to: 2020, minYears: 30 };
const idx = (kind: 'spi' | 'spei', scale: 3 | 6 | 12, value: number | null, extra: Partial<DroughtBadgeIndex> = {}): DroughtBadgeIndex => ({
	kind,
	scale,
	value,
	class: value === null ? null : value <= -2 ? 'extremely-dry' : value <= -1.5 ? 'severely-dry' : value <= -1 ? 'moderately-dry' : value < 1 ? 'near-normal' : 'moderately-wet',
	reference: value === null ? null : ref,
	...extra
});
const badge = (indices: DroughtBadgeIndex[]): DroughtBadge => ({ month: '2024-10', firstMonth: '1981-01', indices });

describe('the Drought index card', () => {
	it('reads the catchment rain_final and pet, never a unit’s', () => {
		const r = (key: string, nodeId: string | null) => ({ key, nodeId, label: '', unit: 'mm' });
		expect(droughtSeries([r('rain_final', null), r('pet', null)])).toEqual({ rain: true, pet: true });
		expect(droughtSeries([r('rain_final', null), r('pet', 'u1')])).toEqual({ rain: true, pet: false });
		expect(droughtSeries([r('rain_used', null)])).toEqual({ rain: false, pet: false });
	});

	it('writes the months a row covers, across a year end too', () => {
		expect(periodText('2024-10', 3)).toBe('Aug–Oct 2024');
		expect(periodText('2024-10', 12)).toBe('Nov 2023 – Oct 2024');
		expect(periodText('2024-02', 3)).toBe('Dec 2023 – Feb 2024');
	});

	it('gives each period its SPI and SPEI with the class, or why there is none', () => {
		const rows = droughtRows(
			badge([
				idx('spi', 3, -1.62),
				idx('spi', 6, -0.4),
				idx('spi', 12, null, { gap: 'short-record' }),
				idx('spei', 3, -2.31),
				idx('spei', 6, null, { gap: 'no-pet' }),
				idx('spei', 12, null, { gap: 'missing-month' })
			])
		);
		expect(rows.map((r) => [r.scale, r.period])).toEqual([
			[3, 'Aug–Oct 2024'],
			[6, 'May–Oct 2024'],
			[12, 'Nov 2023 – Oct 2024']
		]);
		expect(rows[0]!.spi).toEqual({ value: '−1.62', label: 'Severely dry', tone: 'dry' });
		expect(rows[1]!.spi).toEqual({ value: '−0.40', label: 'Near normal', tone: 'normal' });
		expect(rows[2]!.spi).toEqual({ value: '–', label: 'Record too short', tone: null });
		expect(rows[1]!.spei.label).toBe('No evaporation in this run');
		expect(rows[2]!.spei.label).toBe('A month is missing');
		expect(droughtRows({ month: null, firstMonth: null, indices: [] })).toEqual([]);
	});

	it('heads the card with the driest index', () => {
		expect(droughtHeadline(badge([idx('spi', 3, -1.62), idx('spei', 3, -2.31), idx('spei', 12, 0.2)]))).toEqual({
			label: 'Extremely dry',
			index: 'SPEI-3',
			tone: 'dry'
		});
		expect(droughtHeadline(badge([idx('spi', 3, null, { gap: 'short-record' })]))).toBeNull();
		expect(droughtTone('very-wet')).toBe('wet');
	});

	it('names the years the fits used', () => {
		expect(referenceText(badge([idx('spi', 3, 0.1), idx('spei', 3, 0.2)]))).toBe('Fitted on 1991–2020.');
		const rec = { kind: 'record' as const, from: 1999, to: 2024, minYears: 24 };
		expect(referenceText(badge([idx('spi', 3, 0.1, { reference: rec }), idx('spei', 3, 0.2)]))).toBe(
			'SPI fitted on the whole record, 1999–2024 (as few as 24 years a month); SPEI on 1991–2020.'
		);
		expect(referenceText(badge([idx('spi', 3, null)]))).toBeNull();
	});

	it('says in one line why no index has a value', () => {
		const short = { month: '2022-01', firstMonth: '2021-10', indices: [idx('spi', 3, null, { gap: 'short-record' })] };
		expect(recordText(short)).toBe('4 months');
		expect(noIndexText(short)).toBe('Needs at least 20 years of rain in each calendar month; this run has 4 months.');
		expect(recordText({ ...short, firstMonth: '2009-11', month: '2024-10' })).toBe('15 years');
		expect(noIndexText(badge([idx('spi', 3, null, { gap: 'missing-month' })]))).toBe('A month of rain is missing in every period, so none can be scored.');
	});
});
