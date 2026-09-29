import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '$lib/i18n/locale.svelte';
import { markedCatalogue } from '$lib/i18n/fixtureCatalogue';
import {
	agoWords,
	farmToday,
	count,
	DAYS,
	FARMS,
	POINTS,
	WEEKS,
	daysBetween,
	fmtDay,
	fmtDayMonth,
	fmtM3Day,
	fmtMonthYear,
	fmtNumber,
	fmtPct,
	fmtStampDay,
	fmtStampTime,
	fmtVolume,
	joinAnd,
	litresPerSecond,
	monthEnd,
	roundAbout
} from './format';

/** The formatters use no-break spaces; the design's boards show plain ones. */
const sp = (s: string | null) => s?.replace(/[\u00a0\u202f]/g, ' ');

describe('agoWords: the workspace’s age count, in the reader’s words', () => {
	it('counts days, then months, then years, as $lib/format/age does', () => {
		expect(agoWords(0)).toBe('today');
		expect(agoWords(-1)).toBe('today');
		expect(agoWords(1)).toBe('yesterday');
		expect(sp(agoWords(9))).toBe('9 days ago');
		expect(sp(agoWords(637))).toBe('20 months ago');
		expect(sp(agoWords(800))).toBe('2 years ago');
	});
});

describe('volumes (§8)', () => {
	it('m³ are whole with a space between thousands', () => {
		expect(sp(fmtVolume(324_247, 'm3'))).toBe('324 247 m³');
		expect(sp(fmtVolume(350_000, 'm3'))).toBe('350 000 m³');
		expect(sp(fmtVolume(83_640.4, 'm3'))).toBe('83 640 m³');
		expect(sp(fmtVolume(999, 'm3'))).toBe('999 m³');
		expect(sp(fmtVolume(1_234_567, 'm3'))).toBe('1 234 567 m³');
	});

	it('ML have one decimal, with a trailing .0 trimmed', () => {
		expect(sp(fmtVolume(324_247, 'ML'))).toBe('324.2 ML');
		expect(sp(fmtVolume(376_466, 'ML'))).toBe('376.5 ML');
		expect(sp(fmtVolume(350_000, 'ML'))).toBe('350 ML');
		expect(sp(fmtVolume(83_640, 'ML'))).toBe('83.6 ML');
		expect(sp(fmtVolume(60_020, 'ML'))).toBe('60 ML');
		expect(sp(fmtVolume(1_234_560, 'ML'))).toBe('1 234.6 ML');
	});

	it('keeps a figure and its unit together with no-break spaces', () => {
		expect(fmtVolume(324_247, 'm3')).toBe('324\u202f247\u00a0m³');
	});

	it('rates are "m³ a day", whole', () => {
		expect(sp(fmtM3Day(121.2))).toBe('121 m³ a day');
		expect(sp(fmtM3Day(3178.9))).toBe('3 179 m³ a day');
	});

	it('writes a negative with a real minus and never "−0"', () => {
		expect(fmtNumber(-5)).toBe('−5');
		expect(fmtNumber(-0.2)).toBe('0');
	});
});

describe('l/s (§8, §11 F9 F17)', () => {
	it('is given to one decimal from 1 l/s, judged on the unrounded value', () => {
		expect(sp(litresPerSecond((121.2 * 102) / 56))).toBe('2.6 l/s');
		expect(sp(litresPerSecond(86.4))).toBe('1.0 l/s');
		expect(litresPerSecond(86.39)).toBeNull(); // 0.99989 l/s would round to "1.0": still left out
		expect(litresPerSecond(5)).toBeNull();
	});
});

describe('the "about" figures per charged day', () => {
	it('round to two significant figures', () => {
		expect(roundAbout((121.2 * 102) / 56)).toBe(220);
		expect(roundAbout((65.4 * 102) / 56)).toBe(120);
		expect(roundAbout(1234)).toBe(1200);
		expect(roundAbout(7.4)).toBe(7);
		expect(roundAbout(99.96)).toBe(100);
	});
});

describe('percentages (§8)', () => {
	it('are whole, with <1 % and >99 % instead of 0 and 100', () => {
		expect(sp(fmtPct(324_247 / 376_466))).toBe('86 %');
		expect(sp(fmtPct(113_283 / 113_810))).toBe('>99 %');
		expect(sp(fmtPct(0.004))).toBe('<1 %');
		expect(sp(fmtPct(0))).toBe('0 %');
		expect(sp(fmtPct(1))).toBe('100 %');
		expect(sp(fmtPct(1.2))).toBe('100 %');
		expect(sp(fmtPct(0.015))).toBe('2 %');
	});
});

describe('words', () => {
	it('pluralises through the catalogue (Intl.PluralRules)', () => {
		expect(sp(count(DAYS, 1))).toBe('1 day');
		expect(sp(count(DAYS, 16))).toBe('16 days');
		expect(sp(count(FARMS, 0))).toBe('0 hydrological units');
		expect(count(WEEKS, 2)).toBe('2\u00a0weeks');
		expect(sp(count(POINTS, 1))).toBe('1 point');
	});

	it('joins with "and"', () => {
		expect(joinAnd([])).toBe('');
		expect(joinAnd(['Nov'])).toBe('Nov');
		expect(joinAnd(['Nov', 'Dec'])).toBe('Nov and Dec');
		expect(joinAnd(['Oct', 'Nov', 'Dec'])).toBe('Oct, Nov and Dec');
	});
});

describe('in Afrikaans (WP-2.5, D8)', () => {
	afterEach(() => setLocale('en'));

	it('writes a decimal comma and keeps the no-break-space thousands', async () => {
		await setLocale('af', {});
		expect(sp(fmtVolume(83_640.4, 'ML'))).toBe('83,6 ML');
		expect(sp(fmtVolume(1_234_567, 'm3'))).toBe('1 234 567 m³');
		expect(sp(fmtNumber(-1234.56, 2))).toBe('−1 234,56');
		expect(litresPerSecond(200)).toBe('2,3\u00a0l/s');
		expect(sp(fmtPct(0.86))).toBe('86 %');
	});

	it('keeps English dates while the Afrikaans words are incomplete (no Afrikaans month names in an English sentence)', async () => {
		await setLocale('af', {});
		expect(fmtDay('2024-01-10')).toBe('10 Jan 2024');
	});

	it('writes af-ZA dates once the Afrikaans catalogue is complete', async () => {
		// A stand-in catalogue with every message; only the date locale is under test.
		await setLocale('af', await markedCatalogue());
		const want = new Intl.DateTimeFormat('af-ZA', { dateStyle: 'medium', timeZone: 'UTC' })
			.formatToParts(new Date(Date.UTC(2024, 0, 10)))
			.map((p) => (p.type === 'day' ? String(Number(p.value)) : p.value))
			.join('');
		expect(fmtDay('2024-01-10')).toBe(want);
		// The day is written without a leading zero and the year is kept, whatever the ICU data says.
		expect(fmtDay('2024-01-01')).toMatch(/^1\D.*2024$/);
	});
});

describe('dates (§8)', () => {
	it('writes calendar days as "12 Jan 2024", never ISO', () => {
		expect(fmtDay('2024-01-10')).toBe('10 Jan 2024');
		expect(fmtDayMonth('2023-10-01')).toBe('1 Oct');
		expect(fmtMonthYear('2023-02')).toBe('Feb 2023');
		expect(daysBetween('2024-01-10', '2024-01-19')).toBe(9);
		expect(monthEnd('2024-02')).toBe('2024-02-29');
	});

	describe('under a skewed time zone', () => {
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});

		it('never moves a calendar day, east or west of UTC', () => {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Africa/Johannesburg']) {
				process.env.TZ = zone;
				expect(fmtDay('2024-01-10'), zone).toBe('10 Jan 2024');
				expect(fmtDayMonth('2023-10-01'), zone).toBe('1 Oct');
				expect(fmtMonthYear('2023-02'), zone).toBe('Feb 2023');
				expect(daysBetween('2023-10-01', '2024-01-10'), zone).toBe(101);
			}
		});

		it('gives a timestamp the date and time where the viewer is', () => {
			process.env.TZ = 'Africa/Johannesburg';
			expect(fmtStampDay('2024-01-11T23:30:00Z')).toBe('12 Jan 2024');
			expect(fmtStampTime('2024-01-19T05:42:00Z')).toBe('07:42 on 19 Jan 2024');
			process.env.TZ = 'Pacific/Pago_Pago';
			expect(fmtStampDay('2024-01-11T23:30:00Z')).toBe('11 Jan 2024');
		});
	});
});

// Issue #51: "today" is the catchment's, not the phone's, and moves on with the clock.
describe('farmToday', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});
	const view = { today: '2024-01-05', project: { timeZone: 'Africa/Johannesburg' } };

	it('is today in the project’s zone, from this device’s clock, whatever zone the phone is set to', () => {
		process.env.TZ = 'Pacific/Pago_Pago'; // UTC−11: still the 5th on the phone
		expect(farmToday(view, new Date('2024-01-05T23:30:00Z'))).toBe('2024-01-06');
		// A saved copy days later moves on with the clock, not the response's `today`.
		expect(farmToday(view, new Date('2024-01-09T08:00:00Z'))).toBe('2024-01-09');
	});

	it('falls back to the server’s today for an unknown zone, and to the phone’s date for an old saved copy', () => {
		process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
		const now = new Date('2024-01-05T12:00:00Z');
		expect(farmToday({ today: '2024-01-05', project: { timeZone: 'Not/AZone' } }, now)).toBe('2024-01-05');
		expect(farmToday({ project: {} }, now)).toBe('2024-01-06');
	});
});
