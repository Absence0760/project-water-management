// End-to-end: review triggers (docs/model.md §2.15a) on a synthetic
// catchment. By hand from the base run: the storage history on the review
// date (end of the day before, every year, 29 Feb → 28 Feb in a common
// year), its terciles (type 7), the bands, the start storage (lower edge,
// the lowest band from the lowest storage on record, shared pro rata to
// capacity); and each band's member equals a plain run of the history with
// its dams reset to the band's start on the review date and the analogue's
// rain after it (settings.damStorageReset), every series to the bit but the
// reset's own step.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelInput, ModelOutput } from '../project';
import { captureModelState, runModelFrom, runModelWithoutChecks, withDamStorage } from '../index';
import { testCatchment } from '../outlook/testCatchment';
import { outlookAnalogues, outlookSeasonInput } from '../outlook/outlook';
import { reviewTriggerBands, runReviewTriggers } from '../outlook/triggers';

function series(out: Pick<ModelOutput, 'series'>, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}:${key}`);
	return s.values;
}
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
function q7(sorted: number[], p: number): number {
	const h = (sorted.length - 1) * p;
	const lo = Math.floor(h);
	return lo + 1 < sorted.length ? sorted[lo]! + (h - lo) * (sorted[lo + 1]! - sorted[lo]!) : sorted[lo]!;
}

const BASE = testCatchment({ start: '1996-10-01', end: '2009-09-30', seed: 7, ewrM3Day: 900 });
const CAP = { a: 300_000, b: 150_000 };
const baseRun = runModelWithoutChecks(BASE);

/** Σ dam storage at the end of the day before `month-day` in every year the run holds it. */
function history(md: string): { year: number; storage: number }[] {
	const d0 = toEpochDay(baseRun.startDate);
	const out: { year: number; storage: number }[] = [];
	for (let y = 1996; y <= 2010; y++) {
		const [m, d] = md.split('-').map(Number) as [number, number];
		const day = toEpochDay(`${y}-${String(m).padStart(2, '0')}-${String(m === 2 && d === 29 && !isLeap(y) ? 28 : d).padStart(2, '0')}`);
		const t = day - 1 - d0;
		if (t < 0 || t >= baseRun.days) continue;
		out.push({ year: y, storage: series(baseRun, 'a', 'dam_storage')[t]! + series(baseRun, 'b', 'dam_storage')[t]! });
	}
	return out;
}

describe('outputs e2e: review-trigger bands from the record (§2.15a)', () => {
	for (const reviewDate of ['2009-01-01', '2008-02-29']) {
		it(`review on ${reviewDate}: history, tercile edges, bands and start storages by hand`, () => {
			const seasonEnd = reviewDate.startsWith('2009') ? '2009-04-30' : '2008-04-30';
			const plan = reviewTriggerBands(BASE, baseRun, { reviewDate, seasonEnd });
			const h = history(reviewDate.slice(5));
			expect(plan.history.map((x) => x.storageM3)).toEqual(h.map((x) => x.storage));
			const sorted = h.map((x) => x.storage).sort((p, q) => p - q);
			const edges = [q7(sorted, 1 / 3), q7(sorted, 2 / 3)];
			expect(plan.bandSource).toBe('historicalTerciles');
			expect(plan.bands.map((b) => [b.band.fromM3, b.band.toM3])).toEqual([
				[0, edges[0]],
				[edges[0], edges[1]],
				[edges[1], CAP.a + CAP.b]
			]);
			// Lowest band: from the lowest storage on record when that is below its upper edge, else from empty dams
			// (with a warning); the others from their lower edge; pro rata to capacity.
			const min = sorted[0]!;
			const fromRecord = min < edges[0]!;
			expect(plan.lowestOnRecordM3).toBe(fromRecord ? min : null);
			const starts = [fromRecord ? min : 0, edges[0]!, edges[1]!];
			plan.bands.forEach((b, i) => {
				expect(b.startStorageM3).toBeCloseTo(starts[i]!, 6);
				const f = starts[i]! / (CAP.a + CAP.b);
				expect(b.storageM3ByDam.a!).toBeCloseTo(f * CAP.a, 6);
				expect(b.storageM3ByDam.b!).toBeCloseTo(f * CAP.b, 6);
			});
			expect(plan.bands[0]!.startFrom).toBe(fromRecord ? 'lowestOnRecord' : undefined);
			if (!fromRecord) expect(plan.bandWarnings.some((w) => /empty dams/.test(w))).toBe(true);
		});
	}

	it('a band’s member is a plain run with the dams reset to the band’s start on the review date', () => {
		const reviewDate = '2009-01-01';
		const season = { decisionDate: reviewDate, seasonEnd: '2009-04-30' };
		const plan = reviewTriggerBands(BASE, baseRun, { reviewDate, seasonEnd: season.seasonEnd });
		const { analogues } = outlookAnalogues(baseRun, season);
		const snap = captureModelState(BASE, reviewDate);
		const k = toEpochDay(reviewDate) - toEpochDay(baseRun.startDate);
		const rf = series(baseRun, null, 'rain_final');
		const problems: string[] = [];
		for (const b of plan.bands) {
			for (const a of analogues.slice(0, 4)) {
				const member = runModelFrom(withDamStorage(snap, BASE, b.storageM3ByDam), outlookSeasonInput(BASE, baseRun, season, a).input);
				const ai = toEpochDay(a.from) - toEpochDay(baseRun.startDate);
				const rain = BASE.series.rain_catchment_mm!;
				const plainInput: ModelInput = {
					...BASE,
					settings: { ...BASE.settings, simulationEnd: season.seasonEnd, damStorageReset: { date: reviewDate, storageM3: b.storageM3ByDam } },
					series: { rain_catchment_mm: { startDate: rain.startDate, values: [...rain.values.slice(0, k), ...rf.slice(ai, ai + 120)] } }
				};
				const plain = runModelWithoutChecks(plainInput);
				expect(series(plain, 'a', 'dam_storage')[k]).not.toBe(series(baseRun, 'a', 'dam_storage')[k]);
				for (const s of member.series) {
					// The reset's own step, and the rain's source code (forecast in a member, catchment in the plain run), aren't the state.
					if (s.key === 'dam_storage_set' || s.key === 'rain_source') continue;
					const p = series(plain, s.nodeId, s.key).slice(k);
					const t = s.values.findIndex((v, i) => !Object.is(v, p[i]));
					if (t >= 0) {
						problems.push(`band ${b.band.fromM3} ${a.label} ${s.nodeId}:${s.key} ${fromEpochDay(toEpochDay(reviewDate) + t)}: ${s.values[t]} vs ${p[t]}`);
						break;
					}
				}
			}
		}
		expect(problems.slice(0, 10)).toEqual([]);
	});

	it('the table: rows fullest band first, each a summary of its band’s members; a fuller band never picks a lower level here', () => {
		const levels = [1, 0.85, 0.7, 0.5].map((f) => ({ id: `${f}`, label: `${f * 100} %`, ops: f === 1 ? [] : [{ op: 'demand.scale' as const, factor: f }] }));
		const t = runReviewTriggers(BASE, { reviewDate: '2009-01-01', seasonEnd: '2009-04-30', decisionDate: '2008-10-01', levels, baseRun });
		expect(t.rows.map((r) => r.band.fromM3)).toEqual([...t.rows.map((r) => r.band.fromM3)].sort((p, q) => q - p));
		for (const r of t.rows) {
			const pick = r.perLevel.find((l) => l.meets);
			expect(r.level?.id ?? null).toBe(r.reason === 'met' ? pick!.levelId : null);
			for (const l of r.perLevel) expect(l.meets).toBe(l.yearsMet >= t.share * l.nYears - 1e-9);
		}
		expect(t.monotone).toBe(true);
	});
});
