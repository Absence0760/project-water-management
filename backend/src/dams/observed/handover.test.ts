import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FeedFormatError } from '../../feeds/errors.js';
import { openStore } from '../../mirror/store.js';
import {
	DAM_METRIC_NAMESPACE,
	DAM_PASS_METRIC,
	DAM_RECENCY_METRIC,
	damPassMetricLine,
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
		const status = { source: 'waterbodies' as const, ranAt: '2026-10-27T04:00:00.000Z', stopped: false, perKey: { zzzzza0001: { lastGood: '2026-10-27T04:00:00.000Z', newest: '2023-09-17' } } };
		await writeStatus(s, status);
		expect(await readStatus(s, 'waterbodies')).toEqual(status);
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
