// The forecast read from our copy (fromMirrorGefs.ts) is the forecast read
// from the files (fetch.ts runFetch → sources/chirps.ts fetchGefs), value for
// value: the committed copy re-dated in fixtures mode against the synthetic
// files, and a live copy's issue rule (today's, else yesterday's).
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { afterAll, describe, expect, it } from 'vitest';
import { MIRROR_FIXTURE, MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import { MirrorOutsideRegionError } from '../mirror/grid.js';
import { MirrorNotReadyError } from '../mirror/readCells.js';
import { fixtureMirrorUrl } from '../mirror/source.js';
import { openStore } from '../mirror/store.js';
import type { GridConfig } from './config.js';
import { FeedNoDataError } from './errors.js';
import { runFetch } from './fetch.js';
import { FIXTURE_CELL, fixtureHttp } from './fixtures.js';
import { fixtureGefsReader, forecastFromMirror, liveGefsReader } from './fromMirrorGefs.js';
import { GEFS_DAYS } from './sources/chirps.js';

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

const add = (iso: string, n: number) => fromEpochDay(toEpochDay(iso) + n);
const committed = () => openStore(fixtureMirrorUrl());
/** A private copy of the committed copy, to read as a live one (its own dates) or to change. */
function privateCopy() {
	const dir = mkdtempSync(join(tmpdir(), 'wm-gefs-copy-'));
	tmp.push(dir);
	cpSync(MIRROR_FIXTURE_DIR, dir, { recursive: true });
	return { dir, store: openStore(pathToFileURL(`${dir}/`).href) };
}

/** What the per-feed fetch answers on `today` from the synthetic files. */
const fromFiles = (config: GridConfig, today: string) => runFetch({ source: 'chirps_gefs', config, start: today, end: today, today }, fixtureHttp(() => today));

const CONFIGS: [string, GridConfig][] = [
	['the fixture cell', { cells: [{ ...FIXTURE_CELL(), weight: 1 }] }],
	['two weighted cells, one in the cover outside the grid', { cells: [{ ...FIXTURE_CELL(), weight: 2 }, { lat: -30.02, lon: 22.03, weight: 1 }] }],
	['a coastal box leaving out its sea cell', { bbox: { south: -20.3, west: 25.3, north: -20.2, east: 25.4 }, skipNoData: true }]
];

describe('a CHIRPS-GEFS forecast read from the copy', () => {
	it.each(CONFIGS)('in fixtures mode equals the files’ forecast, on any day of the pattern: %s', async (_, config) => {
		// Seventeen days in a row: every place in the 17-day pattern, so every residue the two held issues cover.
		for (let i = 0; i < 17; i++) {
			const today = add('2026-10-27', i);
			const want = await fromFiles(config, today);
			expect(want.ok).toBe(true);
			expect(await forecastFromMirror(config, today, fixtureGefsReader(committed()))).toEqual(want);
		}
	});

	it('in fixtures mode refuses a sea cell (no skipNoData) with the files’ message', async () => {
		const config: GridConfig = { cells: [{ lat: -20.275, lon: 25.375, weight: 1 }] };
		const want = await fromFiles(config, '2026-10-27');
		expect(want).toMatchObject({ ok: false });
		const err = await forecastFromMirror(config, '2026-10-27', fixtureGefsReader(committed())).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(FeedNoDataError);
		expect((want as { error: string }).error).toContain((err as Error).message);
	});

	it('a live copy: today’s issue, else yesterday’s, else not ready (the copy is behind); values as the files gave them that day', async () => {
		const { store } = privateCopy();
		const config: GridConfig = { cells: [{ ...FIXTURE_CELL(), weight: 1 }] };
		const [newest, older] = MIRROR_FIXTURE.gefsIssues;
		const onDay = await forecastFromMirror(config, newest, liveGefsReader(store));
		expect(onDay).toEqual(await fromFiles(config, newest));
		expect(onDay).toMatchObject({ startDate: newest, meta: { days: GEFS_DAYS, issued: newest } });
		// The next day before its issue is copied: yesterday's.
		expect(await forecastFromMirror(config, add(newest, 1), liveGefsReader(store))).toEqual(onDay);
		// Two days on: neither today's nor yesterday's is held.
		await expect(forecastFromMirror(config, add(newest, 2), liveGefsReader(store))).rejects.toBeInstanceOf(MirrorNotReadyError);
		// The older issue is only ever read as yesterday's.
		expect(await forecastFromMirror(config, older, liveGefsReader(store))).toMatchObject({ startDate: older });
	});

	it('a live copy with no index yet is not ready; a cell outside the region is the feed’s config', async () => {
		const { dir, store } = privateCopy();
		rmSync(join(dir, 'gefs', 'index.json'));
		const config: GridConfig = { cells: [{ ...FIXTURE_CELL(), weight: 1 }] };
		await expect(forecastFromMirror(config, MIRROR_FIXTURE.gefsIssues[0], liveGefsReader(store))).rejects.toBeInstanceOf(MirrorNotReadyError);
		await expect(forecastFromMirror({ cells: [{ lat: 5, lon: 30, weight: 1 }] }, '2026-10-27', fixtureGefsReader(committed()))).rejects.toBeInstanceOf(
			MirrorOutsideRegionError
		);
	});
});
