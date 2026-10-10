import { defaultDataQualitySettings, defaultZeroRainSettings, type ZeroRainSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { zeroRainShading } from './zeroRain';

/** Six winter-rainfall years from 2000-01-01: rain every other day, 1 mm in summer, 8 mm in May–Aug. */
function series() {
	const values: (number | null)[] = [];
	const d0 = Date.UTC(2000, 0, 1);
	for (let i = 0; i < 6 * 365; i++) {
		const m = new Date(d0 + i * 86_400_000).getUTCMonth() + 1;
		values.push(i % 2 ? 0 : m >= 5 && m <= 8 ? 8 : 1);
	}
	return { startDate: '2000-01-01', values };
}
const zr = (over: Partial<ZeroRainSettings> = {}): ZeroRainSettings => ({ ...defaultZeroRainSettings(), ...over });
const idx = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(2000, 0, 1)) / 86_400_000;

describe('zeroRainShading', () => {
	it('shades a flagged wet-season zero run, and says what the shading means', () => {
		const s = series();
		for (let i = idx('2003-05-01'); i <= idx('2003-07-31'); i++) s.values[i] = 0;
		const r = zeroRainShading(s, zr({ mode: 'missing', keepDry: [], missing: [] }));
		expect(r.ranges).toHaveLength(1);
		expect(r.ranges[0]!.start <= '2003-05-01' && r.ranges[0]!.end >= '2003-07-31').toBe(true);
		expect(r.days).toBeGreaterThanOrEqual(92);
		expect(r.caption).toBe(`Shaded: 1 period, ${r.days} days, that a run treats as missing, so CHIRPS fills them (Settings → Zero-rain runs).`);
	});

	it('shades nothing when the run is kept dry or the mode is as recorded, or with no flagged run (positive control above)', () => {
		const s = series();
		for (let i = idx('2003-05-01'); i <= idx('2003-07-31'); i++) s.values[i] = 0;
		expect(zeroRainShading(s, zr({ mode: 'asRecorded', keepDry: [], missing: [] }))).toEqual({ ranges: [], days: 0, spreadDays: 0, setAsideDays: 0, caption: null });
		expect(zeroRainShading(s, zr({ mode: 'missing', keepDry: [{ waterYear: 2002, reason: 'real' }], missing: [] })).days).toBe(0);
		expect(zeroRainShading(series(), zr({ mode: 'missing', keepDry: [], missing: [] })).caption).toBeNull();
	});

	it('follows the data-quality limits a run uses (engine 1.20.0): a higher wet-season minimum, or CHIRPS reading the run as dry', () => {
		const s = series();
		for (let i = idx('2003-05-01'); i <= idx('2003-07-31'); i++) s.values[i] = 0;
		const on = zr({ mode: 'missing', keepDry: [], missing: [] });
		const dq = defaultDataQualitySettings();
		expect(zeroRainShading(s, on, null, 'monthly', { dq }).days).toBeGreaterThanOrEqual(92);
		expect(zeroRainShading(s, on, null, 'monthly', { dq: { ...dq, zeroRunMinWetDays: 200 } }).days).toBe(0);
		// CHIRPS dry over the run too, with the CHIRPS check on: a dry spell that may be real, not shaded.
		const chirps = { startDate: s.startDate, values: s.values.slice() };
		expect(zeroRainShading(s, on, chirps, 'monthly', { dq: { ...dq, zeroRunChirpsCheck: true } }).days).toBe(0);
		// Positive control: CHIRPS as usual over the run keeps it flagged; engine ≥ 1.81.0 (issue #507 item 3) sets aside
		// only its days CHIRPS reads more than 2 mm on (the fixture rains every other day), the rest stay dry.
		const usual = series();
		let wet = 0;
		for (let i = idx('2003-05-01'); i <= idx('2003-07-31'); i++) if (usual.values[i]! > 2) wet++;
		expect(wet).toBeGreaterThan(0);
		expect(wet).toBeLessThan(92);
		expect(zeroRainShading(s, on, usual, 'monthly', { dq: { ...dq, zeroRunChirpsCheck: true } }).days).toBe(wet);
	});

	it('shades only the days a run sets aside: a flagged run’s days CHIRPS reads 2 mm or less on stay dry, unshaded, and the caption says so (engine ≥ 1.81.0)', () => {
		const s = series();
		for (let i = idx('2003-05-01'); i <= idx('2003-07-31'); i++) s.values[i] = 0;
		// CHIRPS: 5 mm on the run's first ten days, 1 mm (drizzle) on the next five, 5 mm on the rest.
		const chirps = { startDate: s.startDate, values: s.values.map(() => 5 as number | null) };
		for (let i = idx('2003-05-11'); i <= idx('2003-05-15'); i++) chirps.values[i] = 1;
		const r = zeroRainShading(s, zr({ mode: 'missing', keepDry: [], missing: [] }), chirps, 'monthly', { dq: defaultDataQualitySettings() });
		const run = r.ranges.filter((x) => x.end >= '2003-05-01' && x.start <= '2003-07-31');
		// The fixture's 0 mm on 2003-04-30 starts the flagged run a day early.
		expect(run).toEqual([
			{ start: '2003-04-30', end: '2003-05-10' },
			{ start: '2003-05-16', end: '2003-07-31' }
		]);
		expect(r.caption).toContain('(5 other days of flagged runs stay dry: CHIRPS reads 2 mm or less)');
		// Positive control: a 0.5 mm threshold fills the drizzle days too, one shaded range, no kept-dry note.
		const low = zeroRainShading(s, zr({ mode: 'missing', keepDry: [], missing: [], fillAboveChirpsMm: 0.5 }), chirps, 'monthly', { dq: defaultDataQualitySettings() });
		expect(low.ranges.filter((x) => x.end >= '2003-05-01' && x.start <= '2003-07-31')).toEqual([{ start: '2003-04-30', end: '2003-07-31' }]);
		expect(low.caption).not.toContain('stay dry');
	});

	it('shades a listed missing period, clipped to the series', () => {
		const r = zeroRainShading(series(), zr({ mode: 'missing', keepDry: [], missing: [{ start: '1999-12-01', end: '2000-01-10', reason: 'logger fault' }] }));
		expect(r.ranges).toEqual([{ start: '2000-01-01', end: '2000-01-10' }]);
		expect(r.days).toBe(10);
	});

	it('shades a multi-day accumulation a run spreads by CHIRPS, and the zero run it ends only up to the window', () => {
		const s = series();
		// CHIRPS: the catchment's rain every other day, as the fixture reads.
		const chirps = { startDate: s.startDate, values: s.values.slice() };
		// The gauge not read for 20 winter days, then the lot entered on 2003-06-21 (CHIRPS dry that day and either side).
		const r = idx('2003-06-21');
		let total = 0;
		for (let i = r - 20; i < r; i++) {
			total += s.values[i]!;
			s.values[i] = 0;
		}
		s.values[r] = total;
		for (const i of [r - 1, r, r + 1]) chirps.values[i] = 0;
		const res = zeroRainShading(s, zr(), chirps);
		expect(res.ranges).toEqual([{ start: '2003-06-01', end: '2003-06-21' }]);
		expect(res.spreadDays).toBe(21);
		expect(res.caption).toBe('Shaded: 1 multi-day accumulation, 21 days, whose recorded total a run spreads over the days it covers by CHIRPS.');
		// Without CHIRPS nothing can be judged; as recorded, nothing is spread.
		expect(zeroRainShading(s, zr()).caption).toBeNull();
		expect(zeroRainShading(s, zr({ accumulationMode: 'asRecorded' }), chirps).caption).toBeNull();
	});

	it('shades a reading that ends a blank outage (engine ≥ 1.70.0): its own day, set aside; 7 blank days are a window instead', () => {
		const s = series();
		const chirps = { startDate: s.startDate, values: s.values.slice() };
		// A logger out for 30 winter days (blank), then 60 mm on 2003-06-21, a day CHIRPS was dry on (and either side).
		const r = idx('2003-06-21');
		for (let i = r - 30; i < r; i++) s.values[i] = null;
		s.values[r] = 60;
		for (const i of [r - 1, r, r + 1]) chirps.values[i] = 0;
		const res = zeroRainShading(s, zr(), chirps);
		expect(res.ranges).toEqual([{ start: '2003-06-21', end: '2003-06-21' }]);
		expect(res).toMatchObject({ days: 0, spreadDays: 0, setAsideDays: 1 });
		expect(res.caption).toBe('Shaded: 1 reading after an outage that a run sets aside, so CHIRPS fills its day.');
		// Kept as recorded, nothing is shaded.
		expect(zeroRainShading(s, zr({ keepReadings: [{ start: '2003-06-21', end: '2003-06-21', reason: 'storm' }] }), chirps).caption).toBeNull();
		// Only 7 blank days before it: a window over them, the fixture's zero day before them and the reading day
		// (40 mm: CHIRPS over the run, 24 mm, is over half).
		const t = series();
		for (let i = r - 7; i < r; i++) t.values[i] = null;
		t.values[r] = 40;
		const w = zeroRainShading(t, zr(), chirps);
		expect(w.ranges).toEqual([{ start: '2003-06-13', end: '2003-06-21' }]);
		expect(w).toMatchObject({ spreadDays: 9, setAsideDays: 0 });
	});
});
