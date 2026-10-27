// fetchManifest's one request per product (handlers/mirror-tick.ts): a
// conditional GET on S3 (If-None-Match with the ETag already handled, a 304
// is "unchanged"), a missing manifest as null, and any other failure thrown.
// The file:// path is covered by mirror-tick.db.test.ts. And nextBatch, what
// one apply call is given: nothing on first sight (the baseline), then only
// the unapplied tail of `changes`, in batches of at most 1000 at revision
// boundaries, never stuck on one revision of more.
import { describe, expect, it } from 'vitest';
import { MIRROR_MAX_CHANGES, type MirrorChange, type MirrorManifest } from '../../feeds/mirrorRevision.js';
import { fetchManifest, nextBatch } from './mirror-tick.js';

const env = { MIRROR_URL: 's3://wm-mirror-test/copy', CHIRPS_SOURCE: 'mirror' };
type Sent = { input: { Bucket: string; Key: string; IfNoneMatch?: string } };

function fakeS3(answer: (input: Sent['input']) => unknown) {
	const sent: Sent['input'][] = [];
	return {
		sent,
		s3: {
			async send(command: unknown) {
				const input = (command as Sent).input;
				sent.push(input);
				return answer(input);
			}
		}
	};
}
const body = (text: string) => ({ ETag: '"e1"', Body: { transformToByteArray: async () => new TextEncoder().encode(text) } });
const fail = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

describe('fetchManifest on S3', () => {
	it('GETs the product’s manifest, then asks with If-None-Match and takes a 304 as unchanged', async () => {
		const { s3, sent } = fakeS3((input) => {
			if (input.IfNoneMatch === '"e1"') throw fail('NotModified', 304);
			return body('{"product":"sat"}');
		});
		const first = await fetchManifest('sat', undefined, { s3, env });
		expect(first).toMatchObject({ tag: '"e1"' });
		expect(new TextDecoder().decode((first as { bytes: Uint8Array }).bytes)).toBe('{"product":"sat"}');
		expect(sent[0]).toEqual({ Bucket: 'wm-mirror-test', Key: 'copy/sat/manifest.json' });
		expect(await fetchManifest('sat', '"e1"', { s3, env })).toBe('unchanged');
		expect(sent[1]).toEqual({ Bucket: 'wm-mirror-test', Key: 'copy/sat/manifest.json', IfNoneMatch: '"e1"' });
		// Positive control: another tag known (the manifest moved) reads it again.
		expect(await fetchManifest('sat', '"e0"', { s3, env })).toMatchObject({ tag: '"e1"' });
	});

	it('a missing manifest is null; any other failure is thrown', async () => {
		expect(await fetchManifest('prelim', undefined, { s3: fakeS3(() => Promise.reject(fail('NoSuchKey', 404))).s3, env })).toBeNull();
		await expect(fetchManifest('rnl', undefined, { s3: fakeS3(() => Promise.reject(fail('AccessDenied', 403))).s3, env })).rejects.toThrow('AccessDenied');
	});
});

describe('nextBatch', () => {
	const day = (n: number) => new Date(Date.parse('2000-01-01') + n * 86_400_000).toISOString().slice(0, 10);
	const entry = (revision: number, n: number, extra: Partial<MirrorChange> = {}): MirrorChange => ({ revision, days: [day(n), day(n)], cellsChanged: 2, maxAbsDiff: 1, ...extra });
	const manifest = (revision: number, changes: MirrorChange[]): MirrorManifest => ({
		product: 'sat',
		revision,
		region: { w: 10, s: -35.5, e: 41, n: -8 },
		grid: { origin: { lat: -35.475, lon: 10.025 }, step: 0.05 },
		changes
	});
	/** Revisions 1…n, one entry each. */
	const oneEach = (n: number) => manifest(n, Array.from({ length: n }, (_, k) => entry(k + 1, k)));

	it('passes no entries on first sight (the function’s baseline marks everything), at the manifest’s revision', () => {
		const b = nextBatch(oneEach(1500), null);
		expect(b.revision).toBe(1500);
		expect(b.changes).toEqual([]);
	});

	it('passes only the entries above the stored revision: a 1500-entry list with five new ones is five', () => {
		const b = nextBatch(oneEach(1500), 1495);
		expect(b.revision).toBe(1500);
		expect(b.changes.map((c) => c.revision)).toEqual([1496, 1497, 1498, 1499, 1500]);
		// Nothing newer: nothing to pass.
		expect(nextBatch(oneEach(1500), 1500).changes).toEqual([]);
	});

	it('a backlog of more than 1000 goes in batches, each to the last revision it holds whole, until the manifest’s', () => {
		const m = oneEach(1500);
		const first = nextBatch(m, 100);
		expect(first.changes).toHaveLength(MIRROR_MAX_CHANGES);
		expect(first.revision).toBe(1100);
		expect(first.changes.at(-1)!.revision).toBe(1100);
		const second = nextBatch(m, first.revision);
		expect(second.revision).toBe(1500);
		expect(second.changes).toHaveLength(400);
	});

	it('cuts a batch before a revision whose entries straddle the limit', () => {
		// Revisions 1…998 one entry each, then revision 999 of five entries.
		const changes = [...Array.from({ length: 998 }, (_, k) => entry(k + 1, k)), ...Array.from({ length: 5 }, (_, k) => entry(999, 998 + k))];
		const b = nextBatch(manifest(999, changes), 0);
		expect(b.revision).toBe(998);
		expect(b.changes).toHaveLength(998);
		const rest = nextBatch(manifest(999, changes), 998);
		expect(rest.revision).toBe(999);
		expect(rest.changes).toHaveLength(5);
	});

	it('one revision of more than 1000 entries is covered year by year (more marked, never stuck)', () => {
		// Revision 2: 1200 one-day entries from 2000-01-01 (to 2003-04-14), one of no cells; a narrowed region is widened.
		const changes = [entry(1, 0), ...Array.from({ length: 1200 }, (_, k) => entry(2, k, k === 5 ? { cellsChanged: 0 } : k === 7 ? { region: { w: 10, s: -21, e: 41, n: -20 } } : {}))];
		const b = nextBatch(manifest(2, changes), 1);
		expect(b.revision).toBe(2);
		expect(b.changes).toEqual([
			{ revision: 2, days: ['2000-01-01', '2000-12-31'], cellsChanged: 2, maxAbsDiff: 1 },
			{ revision: 2, days: ['2001-01-01', '2001-12-31'], cellsChanged: 2, maxAbsDiff: 1 },
			{ revision: 2, days: ['2002-01-01', '2002-12-31'], cellsChanged: 2, maxAbsDiff: 1 },
			{ revision: 2, days: ['2003-01-01', day(1199)], cellsChanged: 2, maxAbsDiff: 1 }
		]);
		// An entry across a new year counts on both sides.
		const across = [entry(1, 0), ...Array.from({ length: 1001 }, () => entry(2, 0, { days: ['2004-12-30', '2005-01-02'] }))];
		expect(nextBatch(manifest(2, across), 1).changes.map((c) => c.days)).toEqual([
			['2004-12-30', '2004-12-31'],
			['2005-01-01', '2005-01-02']
		]);
	});
});
