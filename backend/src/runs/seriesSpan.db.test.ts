// The first and last day a stored series holds a value, as the three queries
// that work it out in SQL see it: a run's CHIRPS choice (runs/execute.ts
// chirpsSeriesChoice), the series a run reads (feeds/store.ts runSeries) and a
// feed's target (targetSeries). They read the array in one pass (unnest WITH
// ORDINALITY) since subscripting it once a day detoasted it once a day: 6.8 s
// of a 16 161-day record's run (docs/followups.md § V1 run budget). The days
// counted are the ones with a value, so leading and trailing NULLs don't count
// and a series of NULLs has none.
import { beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { runSeries, targetSeries } from '../feeds/store.js';
import { chirpsSeriesChoice } from './execute.js';

type User = Awaited<ReturnType<typeof signUp>>;
let u: User;
let pid: string;

const put = async (kind: string, name: string, startDate: string, values: (number | null)[]) =>
	expect((await u.call('PUT', `/projects/${pid}/series`, { kind, name, unit: 'mm', startDate, values })).status).toBe(200);

beforeAll(async () => {
	u = await signUp('SeriesSpan');
	pid = (await u.call('POST', '/projects', { name: 'Series spans' })).body.project.id;
	// 2001-01-01 + 2 days is the first value, + 5 the last.
	await put('rain_chirps_mm', 'A gaps', '2001-01-01', [null, null, 0, 4, null, 2, null]);
	await put('rain_chirps_mm', 'B whole', '2000-12-30', [1, 1, 1]);
	await put('rain_chirps_mm', 'C empty', '2001-01-01', [null, null]);
});

describe('the days a stored series holds a value', () => {
	it("are the first and last non-NULL elements' days in a run's CHIRPS choice, and none for a series of NULLs", async () => {
		const choice = await withUser(u.id, (db) => chirpsSeriesChoice(db, pid));
		expect(choice).toEqual({
			rain_chirps_mm: {
				name: 'A gaps',
				others: [
					{ name: 'B whole', firstDay: '2000-12-30', lastDay: '2001-01-01' },
					{ name: 'C empty', firstDay: null, lastDay: null }
				]
			}
		});
	});

	it('are the same for the series a run reads and for a feed target', async () => {
		await withUser(u.id, async (db) => {
			expect(await runSeries(db, pid, 'rain_chirps_mm')).toMatchObject({ name: 'A gaps', firstDay: '2001-01-03', lastDay: '2001-01-06' });
			expect(await targetSeries(db, pid, 'rain_chirps_mm', 'A gaps')).toMatchObject({ filled: true, firstDay: '2001-01-03' });
			expect(await targetSeries(db, pid, 'rain_chirps_mm', 'C empty')).toMatchObject({ filled: false, firstDay: null });
			expect(await targetSeries(db, pid, 'rain_chirps_mm', 'missing')).toBeNull();
		});
	});
});
