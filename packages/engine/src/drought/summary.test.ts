// summary.drought (issue #620, the portfolio badge; docs/model.md §2.15b): the stored headline is the
// badge's driest index, cut at the run's last day of history, and a saved run carries it.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import { Rng } from '../random';
import type { ModelOutput, RunSeries } from '../project';
import { droughtBadge, driestIndex } from './spi';
import { droughtLastDay, runDrought } from './summary';

/** `years` whole years of seasonal daily rain and evaporation from 1 Jan `from`. */
function record(from: number, years: number, seed = 11) {
	const rng = new Rng(seed);
	const start = `${from}-01-01`;
	const n = toEpochDay(`${from + years}-01-01`) - toEpochDay(start);
	const rain: number[] = [];
	const pet: number[] = [];
	let month = -1;
	let wet = 1;
	for (let i = 0; i < n; i++) {
		const m = Number(fromEpochDay(toEpochDay(start) + i).slice(5, 7));
		if (m !== month) {
			month = m;
			wet = Math.exp(0.5 * rng.normal());
		}
		rain.push(rng.bool(0.3) ? 6 * wet * rng.float(0.2, 1.8) : 0);
		pet.push(4 + 2 * Math.cos(((m - 1) / 12) * 2 * Math.PI));
	}
	return { start, end: fromEpochDay(toEpochDay(start) + n - 1), rain, pet };
}

const col = (key: string, values: number[], nodeId: string | null = null): RunSeries => ({ nodeId, key, label: key, unit: 'mm', values });

function output(r: ReturnType<typeof record>, over: Partial<ModelOutput['summary']> = {}, series?: RunSeries[]) {
	return {
		startDate: r.start,
		endDate: r.end,
		series: series ?? [col('rain_final', r.rain), col('pet', r.pet)],
		summary: { warnings: [], ...over } as unknown as ModelOutput['summary']
	};
}

describe('runDrought', () => {
	it('is the badge’s driest index, with the months it covers', () => {
		const r = record(1981, 44);
		const d = runDrought(output(r));
		const badge = droughtBadge({ rain: { startDate: r.start, values: r.rain }, pet: { startDate: r.start, values: r.pet }, lastDay: r.end });
		const driest = driestIndex(badge)!;
		expect(d.month).toBe('2024-12');
		expect(d.gap).toBeUndefined();
		expect(d.driest).toEqual({ kind: driest.kind, scale: driest.scale, value: driest.value, class: driest.class, from: driest.scale === 12 ? '2024-01' : driest.scale === 6 ? '2024-07' : '2024-10' });
	});

	it('never reads a forecast day: an ordinary run over forecast rain stops at the last recorded day', () => {
		const r = record(1981, 44);
		// Oct–Dec 2024 is forecast rain, and very wet; the record ends on 30 Sep 2024.
		const cut = toEpochDay('2024-10-01') - toEpochDay(r.start);
		const rain = r.rain.map((v, i) => (i >= cut ? 80 : v));
		const forecastRain = { days: rain.length - cut, from: '2024-10-01', to: r.end, inReport: 0, lastRecorded: '2024-09-30' };
		const d = runDrought(output({ ...r, rain }, { forecastRain }, [col('rain_final', rain), col('pet', r.pet)]));
		expect(d.month).toBe('2024-09');
		// The same as a run that ended on the last recorded day.
		const ended = runDrought({ ...output({ ...r, rain }), endDate: '2024-09-30' });
		expect(d).toEqual(ended);
		// Positive control: read through the forecast days, it would be the wet December.
		expect(runDrought(output({ ...r, rain }, {}, [col('rain_final', rain), col('pet', r.pet)])).month).toBe('2024-12');
	});

	it('says why there is none: no catchment rain, no whole month, a record too short', () => {
		const r = record(1981, 44);
		expect(runDrought(output(r, {}, [col('rain_final', r.rain, 'n1')]))).toEqual({ month: null, driest: null, gap: 'no-rain' });
		const tiny = { start: '2024-03-05', end: '2024-03-20', rain: new Array(16).fill(1), pet: new Array(16).fill(4) };
		expect(runDrought(output(tiny))).toEqual({ month: null, driest: null, gap: 'no-month' });
		const short = record(2010, 15);
		expect(runDrought(output(short))).toEqual({ month: '2024-12', driest: null, gap: 'short-record' });
		// SPI alone without evaporation: still a driest index.
		expect(runDrought(output(r, {}, [col('rain_final', r.rain)])).driest?.kind).toBe('spi');
	});
});

describe('droughtLastDay', () => {
	const run = { startDate: '2000-01-01', endDate: '2024-12-31' };
	it('is the run’s end without forecast rain, else the last recorded day (never past the end)', () => {
		expect(droughtLastDay({ ...run, summary: {} })).toBe('2024-12-31');
		expect(droughtLastDay({ ...run, summary: { forecastRain: { days: 3, from: '2024-12-29', to: '2024-12-31', inReport: 0, lastRecorded: '2024-12-28' } } })).toBe('2024-12-28');
		// Forecast rain only filling a gap before the record's end: the whole run is history.
		expect(droughtLastDay({ ...run, summary: { forecastRain: { days: 2, from: '2010-05-01', to: '2010-05-02', inReport: 0, lastRecorded: '2024-12-31' } } })).toBe('2024-12-31');
		// No recorded rain at all: the day before the run, so no month.
		expect(droughtLastDay({ ...run, summary: { forecastRain: { days: 9, from: '2000-01-01', to: '2024-12-31', inReport: 0, lastRecorded: null } } })).toBe('1999-12-31');
	});
});
