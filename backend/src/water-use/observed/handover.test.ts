// The observed ET handover's files (handover.ts, issue #623): each is checked
// against its schema on read, since what crosses the bucket is untrusted on
// the other side.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FeedFormatError } from '../../feeds/errors.js';
import { fixtureMirrorUrl } from '../../mirror/source.js';
import { openStore } from '../../mirror/store.js';
import {
	ET_METRIC_NAMESPACE,
	type EtFile,
	etFileKey,
	etPassMetricLine,
	etStore,
	readEtFile,
	readStatus,
	readWanted,
	recencyDays,
	statusKey,
	WANTED_KEY,
	writeEtFile,
	writeStatus,
	writeWanted
} from './handover.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function store() {
	const dir = mkdtempSync(join(tmpdir(), 'wm-et-'));
	dirs.push(dir);
	return openStore(pathToFileURL(`${dir}/`).href);
}
const put = (s: ReturnType<typeof store>, key: string, v: unknown) => s.set(key as never, new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v)));
const UNIT = '6f1c1d6e-4a7b-4d65-9a0c-1b2c3d4e5f60';
const square: [number, number][] = [
	[21.3, -33.7],
	[21.31, -33.7],
	[21.31, -33.69],
	[21.3, -33.69],
	[21.3, -33.7]
];
const unit = { unitKey: UNIT, parcels: { type: 'MultiPolygon' as const, coordinates: [[square]] } };
const file = (o: Partial<EtFile> = {}): EtFile => ({
	source: 'wapor',
	unitKey: UNIT,
	fetchedAt: '2026-10-20T10:00:00.000Z',
	parcelsAt: '2026-10-20T09:00:00.000Z',
	version: 'WAPOR-3',
	mask: 'cropland',
	rows: [{ dekad: '2026-09-01', etaMmDay: 3.2, validShare: 0.95, areaM2: 120_000, file: 'WAPOR-3.L2-AETI-D.2026-09-D1.tif', etag: '"e1"' }],
	...o
});

describe('the handover files', () => {
	it('round-trips the wanted list, a unit’s file and the status', async () => {
		const s = store();
		const wanted = { generatedAt: '2026-10-20T09:00:00.000Z', units: [{ ...unit, changedAt: '2026-10-19T09:00:00.000Z', cropland: { dataset: 'synthetic', cellDeg: 0.0025, cells: [[-13480, 8520, 0.4]] as [number, number, number][] } }] };
		await writeWanted(s, wanted);
		expect(await readWanted(s)).toEqual(wanted);
		await writeEtFile(s, file());
		expect(await readEtFile(s, 'wapor', UNIT)).toEqual(file());
		const status = { source: 'wapor' as const, ranAt: '2026-10-20T10:00:00.000Z', stopped: false, perKey: { [UNIT]: { lastGood: '2026-10-20T10:00:00.000Z', newest: '2026-09-01' } } };
		await writeStatus(s, status);
		expect(await readStatus(s, 'wapor')).toEqual(status);
		expect(await readWanted(store())).toBeNull();
		expect(await readEtFile(s, 'wapor', '00000000-0000-4000-8000-000000000000')).toBeNull();
	});

	it('refuses a wanted list that isn’t one: a unit listed twice, a key that isn’t a node id, a ring that doesn’t close in four points, a share over 1', async () => {
		for (const bad of [
			{ generatedAt: '2026-10-20T09:00:00Z', units: [unit, unit] },
			{ generatedAt: '2026-10-20T09:00:00Z', units: [{ ...unit, unitKey: '../../etc' }] },
			{ generatedAt: '2026-10-20T09:00:00Z', units: [{ ...unit, parcels: { type: 'MultiPolygon', coordinates: [[square.slice(0, 3)]] } }] },
			{ generatedAt: '2026-10-20T09:00:00Z', units: [{ ...unit, cropland: { dataset: 'x', cellDeg: 0.0025, cells: [[1, 1, 1.5]] } }] },
			{ generatedAt: '2026-10-20T09:00:00Z', units: [{ ...unit, name: 'Farm A' }] },
			'not json'
		]) {
			const s = store();
			await put(s, WANTED_KEY, bad);
			await expect(readWanted(s)).rejects.toBeInstanceOf(FeedFormatError);
		}
		// The writer refuses it too, so the worker never hands over what the pass would refuse.
		await expect(writeWanted(store(), { generatedAt: '2026-10-20T09:00:00Z', units: [unit, unit] })).rejects.toThrow();
	});

	it('refuses a unit’s file that isn’t one: another unit’s, a day that isn’t a dekad’s first, a dekad twice, a mean past 50 mm/day, a future dekad', async () => {
		const s = store();
		await put(s, etFileKey('wapor', UNIT), { ...file(), unitKey: '00000000-0000-4000-8000-000000000001' });
		await expect(readEtFile(s, 'wapor', UNIT)).rejects.toThrow(/another unit/);
		const row = file().rows[0]!;
		for (const rows of [
			[{ ...row, dekad: '2026-09-02' }],
			[row, row],
			[{ ...row, etaMmDay: 51 }],
			[{ ...row, validShare: -0.1 }],
			[{ ...row, areaM2: 0 }],
			[{ ...row, dekad: '2199-01-01' }],
			[{ ...row, file: 'a file' }],
			[{ ...row, etag: ' "e" ' }]
		]) {
			await put(s, etFileKey('wapor', UNIT), { ...file(), rows });
			await expect(readEtFile(s, 'wapor', UNIT)).rejects.toBeInstanceOf(FeedFormatError);
		}
		await put(s, statusKey('wapor'), { source: 'wapor', ranAt: 'yesterday', stopped: false, perKey: {} });
		await expect(readStatus(s, 'wapor')).rejects.toBeInstanceOf(FeedFormatError);
	});

	it('goes through a bucket of its own, never the committed synthetic copy', () => {
		expect(() => etStore({})).toThrow(/MIRROR_URL/);
		expect(() => etStore({ MIRROR_URL: fixtureMirrorUrl() })).toThrow(/never written/);
		expect(etStore({ MIRROR_URL: 'file:///tmp/wm-et-scratch/' })).toBeTruthy();
	});
});

describe('the pass’s metrics', () => {
	it('publishes the heartbeat always and the recency when a unit holds a dekad', () => {
		const line = JSON.parse(etPassMetricLine('wapor', 12, 0));
		expect(line).toMatchObject({ Source: 'wapor', EtPassCompleted: 1, EtObservationAgeDays: 12 });
		expect(line._aws.CloudWatchMetrics[0]).toMatchObject({ Namespace: ET_METRIC_NAMESPACE, Dimensions: [['Source']] });
		expect(JSON.parse(etPassMetricLine('wapor', null, 0))).not.toHaveProperty('EtObservationAgeDays');
		expect(recencyDays({ perKey: { a: { newest: '2026-10-01' }, b: { newest: '2026-10-11' }, c: {} } }, '2026-10-29')).toBe(18);
		expect(recencyDays({ perKey: {} }, '2026-10-29')).toBeNull();
	});
});
