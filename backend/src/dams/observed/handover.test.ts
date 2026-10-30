import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { FeedFormatError } from '../../feeds/errors.js';
import { openStore } from '../../mirror/store.js';
import {
	DAM_METRIC_NAMESPACE,
	DAM_PASS_METRIC,
	DAM_RECENCY_METRIC,
	damPassMetricLine,
	damS1Mode,
	damSourceOn,
	type ObservationFile,
	observationKey,
	readObservationFile,
	readStatus,
	readWanted,
	recencyDays,
	statusKey,
	WANTED_KEY,
	writeObservationFile,
	writeStatus,
	writeWanted
} from './handover.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function store() {
	const dir = mkdtempSync(join(tmpdir(), 'wm-dams-'));
	dirs.push(dir);
	return openStore(pathToFileURL(`${dir}/`).href);
}
const square = [
	[21.3, -33.7],
	[21.31, -33.7],
	[21.31, -33.69],
	[21.3, -33.69],
	[21.3, -33.7]
] as [number, number][];
const FID = '6f1c1d6e-4a7b-4d65-9a0c-1b2c3d4e5f60';
const file = (o: Partial<ObservationFile> = {}): ObservationFile => ({
	source: 'waterbodies',
	key: 'zzzzza0001',
	fetchedAt: '2026-10-27T04:00:00.000Z',
	upstream: [{ url: 'https://example.invalid/a.csv', etag: '"abc"' }],
	rows: [{ date: '2020-01-05', wetAreaM2: 1000, pctObserved: 90, upstreamKey: 'zzzzza0001' }],
	...o
});

describe('the dams handover files', () => {
	it('keys every file under dams/', () => {
		expect(WANTED_KEY).toBe('/dams/wanted.json');
		expect(statusKey('wofs')).toBe('/dams/wofs-status.json');
		expect(observationKey('waterbodies', 'zzzzza0001')).toBe('/dams/waterbodies/zzzzza0001.json');
		expect(observationKey('wofs', FID)).toBe(`/dams/wofs/${FID}.json`);
	});

	it('round-trips each file, and reads null for one not there', async () => {
		const s = store();
		expect(await readWanted(s)).toBeNull();
		expect(await readStatus(s, 'wofs')).toBeNull();
		expect(await readObservationFile(s, 'waterbodies', 'zzzzza0001')).toBeNull();
		const wanted = { generatedAt: '2026-10-27T04:00:00.000Z', waterbodies: ['zzzzza0001'], outlines: [{ featureId: FID, geometry: { type: 'Polygon' as const, coordinates: [square] }, since: '1984-01-01' }] };
		await writeWanted(s, wanted);
		expect(await readWanted(s)).toEqual(wanted);
		const status = {
			source: 'waterbodies' as const,
			ranAt: '2026-10-27T04:00:00.000Z',
			stopped: false,
			perKey: { zzzzza0001: { lastGood: '2026-10-27T04:00:00.000Z', newest: '2023-09-17', triedAt: '2026-10-27T04:00:00.000Z' } }
		};
		// A status written before the Waterbodies API (no wbId, no fullAt) still reads.
		await writeStatus(s, status);
		expect(await readStatus(s, 'waterbodies')).toEqual(status);
		// The API pass's own fields: the uid's wb_id and its last whole fetch.
		const withId = { ...status, perKey: { zzzzza0001: { ...status.perKey.zzzzza0001, wbId: 89768, fullAt: '2026-10-27T04:00:00.000Z' } } };
		await writeStatus(s, withId);
		expect(await readStatus(s, 'waterbodies')).toEqual(withId);
		for (const wbId of [0, -1, 1.5, '89768', Number.MAX_SAFE_INTEGER + 2]) {
			expect(() => writeStatus(s, { ...status, perKey: { zzzzza0001: { wbId: wbId as number } } }), String(wbId)).toThrow();
		}
		expect(() => writeStatus(s, { ...status, perKey: { zzzzza0001: { fullAt: 'yesterday' } } })).toThrow();
		await writeObservationFile(s, file());
		expect(await readObservationFile(s, 'waterbodies', 'zzzzza0001')).toEqual(file());
		await writeObservationFile(s, file({ source: 'wofs', key: FID, rows: [{ date: '2026-10-20', wetAreaM2: 5, pctObserved: 100, upstreamKey: 'item-1' }] }));
		expect((await readObservationFile(s, 'wofs', FID))!.rows).toHaveLength(1);
	});

	it('refuses what doesn’t fit: a wrong key, a repeated date, a share over 100, a uid listed twice, garbage', async () => {
		const s = store();
		expect(() => writeObservationFile(s, file({ key: 'NOT A UID' }))).toThrow();
		expect(() => writeObservationFile(s, file({ source: 'wofs' }))).toThrow();
		expect(() =>
			writeObservationFile(
				s,
				file({
					rows: [
						{ date: '2020-01-05', wetAreaM2: 1, pctObserved: 1, upstreamKey: 'k' },
						{ date: '2020-01-05', wetAreaM2: 2, pctObserved: 1, upstreamKey: 'k' }
					]
				})
			)
		).toThrow();
		expect(() => writeObservationFile(s, file({ rows: [{ date: '2020-01-05', wetAreaM2: 1, pctObserved: 101, upstreamKey: 'k' }] }))).toThrow();
		expect(() => writeObservationFile(s, file({ rows: [{ date: '2023-02-31', wetAreaM2: 1, pctObserved: 1, upstreamKey: 'k' }] }))).toThrow();
		expect(() => writeObservationFile(s, file({ rows: [{ date: '9999-12-31', wetAreaM2: 1, pctObserved: 1, upstreamKey: 'k' }] }))).toThrow();
		expect(() => writeWanted(s, { generatedAt: '2026-10-27T04:00:00.000Z', waterbodies: ['zzzzza0001', 'zzzzza0001'], outlines: [] })).toThrow();
		// A file under one key that names another is refused on read.
		await s.set(observationKey('waterbodies', 'zzzzza0002'), new TextEncoder().encode(JSON.stringify(file())));
		await expect(readObservationFile(s, 'waterbodies', 'zzzzza0002')).rejects.toBeInstanceOf(FeedFormatError);
		await s.set(WANTED_KEY, new TextEncoder().encode('{nope'));
		await expect(readWanted(s)).rejects.toBeInstanceOf(FeedFormatError);
	});
});

describe('the Sentinel sources (issue #624)', () => {
	it('keeps s2 and s1 files, statuses and a wanted outline’s sinceBy, each under its own key', async () => {
		const s = store();
		expect(observationKey('s2', FID)).toBe(`/dams/s2/${FID}.json`);
		expect(statusKey('s1')).toBe('/dams/s1-status.json');
		for (const source of ['s2', 's1'] as const) {
			await writeObservationFile(s, file({ source, key: FID, rows: [{ date: '2026-10-20', wetAreaM2: 300, pctObserved: 100, upstreamKey: `${source}-item` }] }));
			expect((await readObservationFile(s, source, FID))!.source).toBe(source);
			await writeStatus(s, { source, ranAt: '2026-10-27T04:00:00.000Z', stopped: false, perKey: { [FID]: { lastGood: '2026-10-27T04:00:00.000Z', newest: '2026-10-20' } } });
			expect((await readStatus(s, source))!.source).toBe(source);
			// A Sentinel file is keyed by a dam, never a waterbody uid.
			expect(() => writeObservationFile(s, file({ source, key: 'zzzzza0001' }))).toThrow();
		}
		// The WOfS file isn't the Sentinel-2 one.
		expect(await readObservationFile(s, 'wofs', FID)).toBeNull();
		const outline = { featureId: FID, geometry: { type: 'Polygon' as const, coordinates: [square] }, since: '1984-01-01', sinceBy: { s2: '2026-10-21' } };
		await writeWanted(s, { generatedAt: '2026-10-27T04:00:00.000Z', waterbodies: [], outlines: [outline] });
		expect((await readWanted(s))!.outlines[0]).toEqual(outline);
		expect(() => writeWanted(s, { generatedAt: '2026-10-27T04:00:00.000Z', waterbodies: [], outlines: [{ ...outline, sinceBy: { wofs: '2026-10-21' } as never }] })).toThrow();
		expect(() => writeWanted(s, { generatedAt: '2026-10-27T04:00:00.000Z', waterbodies: [], outlines: [{ ...outline, sinceBy: { s2: '2026-02-31' } }] })).toThrow();
	});

	it('runs a Sentinel pass only with its own flag on (unset is off), and refuses anything but on or off', () => {
		expect(damSourceOn('s2', {})).toBe(false);
		expect(damSourceOn('s2', { DAM_OBSERVATIONS_S2: 'off' })).toBe(false);
		expect(damSourceOn('s2', { DAM_OBSERVATIONS_S2: ' on ' })).toBe(true);
		expect(damSourceOn('s1', { DAM_OBSERVATIONS_S2: 'on' })).toBe(false);
		expect(damSourceOn('s1', { DAM_OBSERVATIONS_S1: 'on' })).toBe(true);
		expect(() => damSourceOn('s2', { DAM_OBSERVATIONS_S2: 'true' })).toThrow(/unknown DAM_OBSERVATIONS_S2/);
		expect(() => damSourceOn('s2', { DAM_OBSERVATIONS_S2: 'measure' })).toThrow(/unknown DAM_OBSERVATIONS_S2/);
	});

	it('reads radar\'s stage: off (unset), measure or on, and runs its pass in measure and on alike (issue #624 open question 3)', () => {
		expect(damS1Mode({})).toBe('off');
		expect(damS1Mode({ DAM_OBSERVATIONS_S1: ' ' })).toBe('off');
		expect(damS1Mode({ DAM_OBSERVATIONS_S1: 'off' })).toBe('off');
		expect(damS1Mode({ DAM_OBSERVATIONS_S1: ' measure ' })).toBe('measure');
		expect(damS1Mode({ DAM_OBSERVATIONS_S1: 'on' })).toBe('on');
		expect(damSourceOn('s1', { DAM_OBSERVATIONS_S1: 'off' })).toBe(false);
		expect(damSourceOn('s1', { DAM_OBSERVATIONS_S1: 'measure' })).toBe(true);
		expect(() => damS1Mode({ DAM_OBSERVATIONS_S1: 'true' })).toThrow(/unknown DAM_OBSERVATIONS_S1 "true" \(expected off, measure or on\)/);
		expect(() => damSourceOn('s1', { DAM_OBSERVATIONS_S1: 'yes' })).toThrow(/unknown DAM_OBSERVATIONS_S1/);
	});
});

describe('the pass metrics', () => {
	it('writes the heartbeat and the recency as one embedded-metric line, the recency only when known', () => {
		const line = JSON.parse(damPassMetricLine('wofs', 7, 1_000));
		expect(line._aws.CloudWatchMetrics[0]).toEqual({
			Namespace: DAM_METRIC_NAMESPACE,
			Dimensions: [['Source']],
			Metrics: [
				{ Name: DAM_PASS_METRIC, Unit: 'Count' },
				{ Name: DAM_RECENCY_METRIC, Unit: 'None' }
			]
		});
		expect(line).toMatchObject({ Source: 'wofs', [DAM_PASS_METRIC]: 1, [DAM_RECENCY_METRIC]: 7 });
		const none = JSON.parse(damPassMetricLine('waterbodies', null));
		expect(none._aws.CloudWatchMetrics[0].Metrics).toEqual([{ Name: DAM_PASS_METRIC, Unit: 'Count' }]);
		expect(none[DAM_RECENCY_METRIC]).toBeUndefined();
	});

	it('counts the recency from the newest date any key holds', () => {
		expect(recencyDays({ perKey: {} }, '2026-10-27')).toBeNull();
		expect(recencyDays({ perKey: { a: { newest: '2026-10-20' }, b: { newest: '2026-09-01' }, c: { error: 'x' } } }, '2026-10-27')).toBe(7);
	});
});

// CLAUDE.md rule 7: the dates here are UTC days whatever the server's zone.
// The clock is pinned late in the UTC day, where a zone far east is already
// on the next day and one far west still on this one.
describe.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago'])('under a skewed TZ (%s)', (tz) => {
	const zone = process.env.TZ;
	afterEach(() => {
		vi.useRealTimers();
		process.env.TZ = zone;
	});
	const at = (iso: string) => {
		vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(iso) });
		process.env.TZ = tz;
	};
	const row = (date: string) => file({ rows: [{ date, wetAreaM2: 1, pctObserved: 1, upstreamKey: 'k' }] });

	it('takes an observation dated up to tomorrow (UTC) and refuses the day after, at 23:30 UTC', async () => {
		at('2026-10-27T23:30:00Z');
		const s = store();
		await writeObservationFile(s, row('2026-10-28'));
		expect((await readObservationFile(s, 'waterbodies', 'zzzzza0001'))!.rows[0]!.date).toBe('2026-10-28');
		expect(() => writeObservationFile(s, row('2026-10-29'))).toThrow();
		// A file already in the bucket with that date is refused on read too.
		await s.set(observationKey('waterbodies', 'zzzzza0001'), new TextEncoder().encode(JSON.stringify(row('2026-10-29'))));
		await expect(readObservationFile(s, 'waterbodies', 'zzzzza0001')).rejects.toBeInstanceOf(FeedFormatError);
	});

	it('moves tomorrow’s bound at 00:00 UTC, not at local midnight', async () => {
		at('2026-10-28T00:30:00Z');
		const s = store();
		await writeObservationFile(s, row('2026-10-29'));
		expect(() => writeObservationFile(s, row('2026-10-30'))).toThrow();
	});

	it('counts the recency in UTC days', () => {
		at('2026-10-27T23:30:00Z');
		expect(recencyDays({ perKey: { a: { newest: '2026-10-20' } } }, '2026-10-27')).toBe(7);
	});
});
