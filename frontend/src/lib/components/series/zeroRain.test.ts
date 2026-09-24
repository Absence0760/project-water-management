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
const idx = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(2000, 0, 1)) / 86_400_000;

describe('zeroRainShading', () => {
	it('shades a flagged wet-season zero run, and says what the shading means', () => {
		const s = series();
		for (let i = idx('2003-05-01'); i <= idx('2003-07-31'); i++) s.values[i] = 0;
		const r = zeroRainShading(s, { mode: 'missing', keepDry: [], missing: [] });
		expect(r.ranges).toHaveLength(1);
		expect(r.ranges[0]!.start <= '2003-05-01' && r.ranges[0]!.end >= '2003-07-31').toBe(true);
		expect(r.days).toBeGreaterThanOrEqual(92);
		expect(r.caption).toBe(`Shaded: 1 period, ${r.days} days, that a run treats as missing, so CHIRPS fills them (Settings → Zero-rain runs).`);
	});

	it('shades nothing when the run is kept dry or the mode is as recorded, or with no flagged run (positive control above)', () => {
		const s = series();
		for (let i = idx('2003-05-01'); i <= idx('2003-07-31'); i++) s.values[i] = 0;
		expect(zeroRainShading(s, { mode: 'asRecorded', keepDry: [], missing: [] })).toEqual({ ranges: [], days: 0, caption: null });
		expect(zeroRainShading(s, { mode: 'missing', keepDry: [{ waterYear: 2002, reason: 'real' }], missing: [] }).days).toBe(0);
		expect(zeroRainShading(series(), { mode: 'missing', keepDry: [], missing: [] }).caption).toBeNull();
	});

	it('shades a listed missing period, clipped to the series', () => {
		const r = zeroRainShading(series(), { mode: 'missing', keepDry: [], missing: [{ start: '1999-12-01', end: '2000-01-10', reason: 'logger fault' }] });
		expect(r.ranges).toEqual([{ start: '2000-01-01', end: '2000-01-10' }]);
		expect(r.days).toBe(10);
	});
});
