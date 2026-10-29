// The S1/S2 agreement report (agreement.ts): pairing radar views with
// Sentinel-2's clear ones (the same day first, then a day either side),
// the 0.1 F rule, the 85 % bar, the summary, and the report file the
// fetcher keeps.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { geometryAreaM2 } from '../../../geo/area.js';
import { openStore, type MirrorStore } from '../../../mirror/store.js';
import { OBSERVED } from '../compare.js';
import { writeObservationFile, writeWanted, type ObservationRow, type WantedOutline } from '../handover.js';
import { AGREEMENT_FILL_PER_RUN, AGREEMENT_KEY, agreementPairs, damAgreement, S1_AGREEMENT, s1Agreement, summarizeAgreement, updateAgreement } from './agreement.js';

const row = (date: string, wetAreaM2: number, pctObserved = 100): ObservationRow => ({ date, wetAreaM2, pctObserved });
const F = 10_000;

describe('S1_AGREEMENT', () => {
	it('is issue #624’s bar, with the comparison’s own clear and within rules', () => {
		expect(S1_AGREEMENT).toMatchObject({ maxDayGap: 1, withinShare: 0.1, bar: 0.85 });
		// Copied (the fetcher's bundle stays clear of compare.ts's engine import): kept equal here.
		expect(S1_AGREEMENT.withinShare).toBe(OBSERVED.withinShare);
		expect(S1_AGREEMENT.minPctObserved).toBe(OBSERVED.minPctObserved);
	});
});

describe('agreementPairs', () => {
	it('pairs a radar view with the same day’s Sentinel-2 view, else the day before, else the day after', () => {
		const s2 = [row('2026-07-01', 5000), row('2026-07-04', 6000), row('2026-07-06', 7000), row('2026-07-09', 2000), row('2026-07-11', 9000)];
		const s1 = [row('2026-07-01', 5200), row('2026-07-05', 6100), row('2026-07-10', 8000), row('2026-07-20', 1000)];
		expect(agreementPairs(s1, s2, F).map((p) => [p.s1Date, p.s2Date])).toEqual([
			['2026-07-01', '2026-07-01'],
			// 07-04 and 07-06 both a day off: the day before wins.
			['2026-07-05', '2026-07-04'],
			['2026-07-10', '2026-07-09']
		]);
	});

	it('agrees within 0.1 F, at 0.1 F too', () => {
		const pairs = agreementPairs([row('2026-07-01', 6000), row('2026-07-02', 6000), row('2026-07-03', 6000)], [row('2026-07-01', 5000), row('2026-07-02', 4999), row('2026-07-03', 7000)], F);
		expect(pairs.map((p) => p.within)).toEqual([true, false, true]);
		expect(pairs[0]).toMatchObject({ s1Share: 0.6, s2Share: 0.5 });
	});

	it('pairs only views that saw at least 90 % of the outline clearly, on both sides', () => {
		const s2 = [row('2026-07-01', 5000, 89.9), row('2026-07-02', 5000, 90)];
		expect(agreementPairs([row('2026-07-01', 5000)], s2, F).map((p) => p.s2Date)).toEqual(['2026-07-02']);
		expect(agreementPairs([row('2026-07-02', 5000, 50)], s2, F)).toEqual([]);
	});

	it('pairs nothing without a full area', () => {
		expect(agreementPairs([row('2026-07-01', 1)], [row('2026-07-01', 1)], 0)).toEqual([]);
	});
});

describe('damAgreement and s1Agreement', () => {
	it('passes at 85 % over at least 10 pairs, and not below either', () => {
		expect(damAgreement(20, 17)).toEqual({ pairs: 20, within: 17, rate: 0.85, passes: true });
		expect(damAgreement(20, 16).passes).toBe(false);
		expect(damAgreement(9, 9).passes).toBe(false);
		expect(damAgreement(0, 0)).toEqual({ pairs: 0, within: 0, rate: null, passes: false });
	});

	it('counts a dam’s rows', () => {
		const days = Array.from({ length: 12 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`);
		const s2 = days.map((d) => row(d, 5000));
		// Two windy days radar reads dry.
		const s1 = days.map((d, i) => row(d, i < 2 ? 0 : 5100));
		expect(s1Agreement(s1, s2, F)).toEqual({ pairs: 12, within: 10, rate: 10 / 12, passes: false });
		expect(s1Agreement(s1.slice(1), s2, F)).toMatchObject({ pairs: 11, within: 10, passes: true });
	});
});

describe('summarizeAgreement', () => {
	it('pools every dam’s pairs, and counts the dams judged and passing', () => {
		const s = summarizeAgreement([
			{ pairs: 20, within: 19 },
			{ pairs: 10, within: 5 },
			{ pairs: 3, within: 3 },
			{ pairs: 0, within: 0 }
		]);
		expect(s).toEqual({ dams: 4, damsPaired: 3, damsJudged: 2, damsPassing: 1, pairs: 33, within: 27, rate: 0.818, passes: false });
		expect(summarizeAgreement([]).rate).toBeNull();
	});
});

describe('updateAgreement', () => {
	const tmp: string[] = [];
	afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
	function freshStore(): MirrorStore {
		const dir = mkdtempSync(join(tmpdir(), 'wm-s1-agreement-'));
		tmp.push(dir);
		return openStore(pathToFileURL(`${dir}/`).href);
	}
	const outline = (n: number): WantedOutline => ({
		featureId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
		geometry: { type: 'Polygon', coordinates: [[[22.3, -32.1], [22.301, -32.1], [22.301, -32.101], [22.3, -32.101], [22.3, -32.1]]] },
		since: '1984-01-01'
	});
	const file = (source: 's1' | 's2', key: string, rows: ObservationRow[]) => ({
		source,
		key,
		fetchedAt: '2026-10-25T04:00:00.000Z',
		upstream: [{ url: 'https://deafrica-sentinel-1.s3.af-south-1.amazonaws.com/s1_rtc/x_VV.tif', itemId: 'i' }],
		rows: rows.map((r) => ({ ...r, upstreamKey: 'i' }))
	});

	it('recomputes the dams named, fills in listed dams it has no entry for, drops unlisted ones, and sums them', async () => {
		const store = freshStore();
		const [a, b, c] = [outline(1), outline(2), outline(3)];
		const full = geometryAreaM2(a.geometry)!;
		await writeWanted(store, { generatedAt: '2026-10-25T03:00:00Z', waterbodies: [], outlines: [a, b] });
		const days = Array.from({ length: 10 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`);
		await writeObservationFile(store, file('s2', a.featureId, days.map((d) => row(d, full / 2))));
		await writeObservationFile(store, file('s1', a.featureId, days.map((d, i) => row(d, i === 0 ? 0 : full / 2))));
		// A stale entry for a dam no longer listed.
		await store.set(AGREEMENT_KEY, new TextEncoder().encode(JSON.stringify({ computedAt: '2026-10-24T04:00:00.000Z', perDam: { [c.featureId]: { pairs: 5, within: 5, fullAreaM2: 1 } } })));

		const s = (await updateAgreement(store, [a.featureId], () => Date.parse('2026-10-25T04:30:00Z')))!;
		// a: ten pairs, nine within; b: listed, no files, filled in with none.
		expect(s).toEqual({ dams: 2, damsPaired: 1, damsJudged: 1, damsPassing: 1, pairs: 10, within: 9, rate: 0.9, passes: true });
		const saved = JSON.parse(new TextDecoder().decode(await store.get(AGREEMENT_KEY)));
		expect(Object.keys(saved.perDam).sort()).toEqual([a.featureId, b.featureId]);
		expect(saved.perDam[a.featureId].fullAreaM2).toBeCloseTo(full, 1);
		expect(saved.computedAt).toBe('2026-10-25T04:30:00.000Z');

		// A later run that changed nothing reads no observation file and keeps the counts.
		const reads: string[] = [];
		const watched = Object.create(store) as MirrorStore;
		watched.get = async (k, o) => (reads.push(k), store.get(k, o));
		expect(await updateAgreement(watched, [])).toMatchObject({ pairs: 10, within: 9 });
		expect(reads.filter((k) => k.includes('/s1/') || k.includes('/s2/'))).toEqual([]);
	});

	it('fills in at most AGREEMENT_FILL_PER_RUN unrecorded dams a run, beside the changed ones', async () => {
		const store = freshStore();
		const outlines = Array.from({ length: AGREEMENT_FILL_PER_RUN + 5 }, (_, i) => outline(i + 1));
		await writeWanted(store, { generatedAt: '2026-10-25T03:00:00Z', waterbodies: [], outlines });
		expect((await updateAgreement(store, [outlines.at(-1)!.featureId]))!.dams).toBe(AGREEMENT_FILL_PER_RUN + 1);
		expect((await updateAgreement(store, []))!.dams).toBe(AGREEMENT_FILL_PER_RUN + 5);
	});

	it('keeps a dam whose file can’t be read at its last counts, and goes on with the rest', async () => {
		const store = freshStore();
		const [a, b] = [outline(1), outline(2)];
		await writeWanted(store, { generatedAt: '2026-10-25T03:00:00Z', waterbodies: [], outlines: [a, b] });
		await store.set(AGREEMENT_KEY, new TextEncoder().encode(JSON.stringify({ computedAt: '2026-10-24T04:00:00.000Z', perDam: { [a.featureId]: { pairs: 4, within: 3, fullAreaM2: 1 } } })));
		await store.set(`/dams/s1/${a.featureId}.json` as never, new TextEncoder().encode('not json'));
		expect(await updateAgreement(store, [a.featureId, b.featureId])).toMatchObject({ dams: 2, pairs: 4, within: 3 });
	});

	it('answers null without a wanted list', async () => {
		expect(await updateAgreement(freshStore(), [])).toBeNull();
	});
});
