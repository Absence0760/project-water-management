import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { buildMirrorFixture, MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';

const slow = Number(process.env.COVERAGE_SLOWDOWN ?? 1);

/** Every file under `dir`, by path: JSON as text, a chunk as its gunzipped bytes (the gzip bytes depend on the zlib). */
function contents(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else {
				const bytes = readFileSync(p);
				out.set(relative(dir, p), p.endsWith('.json') ? bytes.toString('utf8') : gunzipSync(bytes).toString('hex'));
			}
		}
	};
	walk(dir);
	return out;
}

/** The differences between two copies, one line per file. */
function differences(a: Map<string, string>, b: Map<string, string>): string[] {
	const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
	return keys.filter((k) => a.get(k) !== b.get(k)).map((k) => (!a.has(k) ? `${k}: only committed` : !b.has(k) ? `${k}: not committed` : `${k}: differs`));
}

describe('the committed synthetic rain data copy (backend/fixtures/mirror)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mirror-fixture-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it(
		'holds what the generator writes (re-run `pnpm gen:mirror-fixture` after changing the feed fixtures or the layout)',
		async () => {
			await buildMirrorFixture(dir);
			const committed = contents(MIRROR_FIXTURE_DIR);
			expect(committed.size).toBeGreaterThan(40);
			expect(differences(contents(dir), committed)).toEqual([]);

			// Positive control: one changed value in one chunk is a difference.
			const chunk = join(dir, 'rnl/c/43/0/15/15');
			const raw = gunzipSync(readFileSync(chunk));
			raw[0] = raw[0]! ^ 1;
			writeFileSync(chunk, gzipSync(raw));
			expect(differences(contents(dir), committed)).toEqual(['rnl/c/43/0/15/15: differs']);
		},
		120_000 * slow
	);
});
