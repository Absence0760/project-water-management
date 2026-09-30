// The evidence pack's reproduction bundle (issue #71, docs/evidence-pack.md §
// Reproduction): built from real engine runs of a small synthetic catchment
// (testing/packBundle.ts), it checks clean and re-runs to the same results
// digest; the same pack gives the same bytes; and each kind of tampering fails
// its own check, each beside a positive control. The series CSV and the
// results digest are pinned too.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RunInputsSnapshot } from '../compare';
import { canonicalJson } from '../manifest';
import { packBundleFixture, PACK_FIXTURE_ID } from '../testing/packBundle';
import { ENGINE_VERSION } from '../version';
import { crc32, storedZip, zip, ZipArchive } from '../zip';
import {
	BUNDLE_ZIP_LIMITS,
	buildPackBundle,
	checkPackBundle,
	PACK_BUNDLE_VERSION,
	parseSeriesCsv,
	runResultsDigest,
	runResultsText,
	seriesCsv,
	type PackBundleIndex
} from './bundle';
import { packManifestText, packShortCode } from './pack';

const hash = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex');
const packInput = (opts: { application?: boolean } = {}) => packBundleFixture(hash, opts);

/** Open a bundle, change its entries, fix bundle.json's hashes (unless `keepIndex`), and zip it again. */
async function rezip(bytes: Uint8Array<ArrayBuffer>, edit: (files: Map<string, string>) => void, keepIndex = false): Promise<Uint8Array<ArrayBuffer>> {
	const archive = await ZipArchive.open(bytes);
	const files = new Map<string, string>();
	for (const n of archive.names) files.set(n, new TextDecoder().decode(await archive.read(n)));
	edit(files);
	if (!keepIndex) {
		const index = JSON.parse(files.get('bundle.json')!) as PackBundleIndex;
		index.files = {};
		for (const n of [...files.keys()].sort()) if (n !== 'bundle.json') index.files[n] = hash(files.get(n)!);
		files.set('bundle.json', canonicalJson(index));
	}
	return zip([...files.keys()].sort().map((name) => ({ name, data: new TextEncoder().encode(files.get(name)!) })));
}

const failing = (r: Awaited<ReturnType<typeof checkPackBundle>>) => r.checks.filter((c) => !c.ok).map((c) => c.id);

describe('buildPackBundle + checkPackBundle', () => {
	const input = packInput();

	it('builds a bundle that checks clean and re-runs both runs to the same results digest', async () => {
		const built = await buildPackBundle(input, hash);
		expect(built.sha256).toBe(hash(built.bytes));
		const manifestSha256 = hash(packManifestText(input.manifest));
		expect(built.index.version).toBe(PACK_BUNDLE_VERSION);
		expect(built.index.pack).toEqual({ id: PACK_FIXTURE_ID, version: 1, manifestSha256, shortCode: packShortCode(manifestSha256) });
		expect(Object.keys(built.index.files).sort()).toEqual(
			[
				'README.md',
				'manifest.json',
				'runs/application/input.json',
				'runs/application/results.json',
				'runs/baseline/input.json',
				'runs/baseline/results.json',
				'scenario.json',
				// Both runs share their rain: one file.
				`series/${input.baseline.inputs.series.rain_catchment_mm!.valuesSha256}.csv`
			].sort()
		);
		const r = await checkPackBundle(built.bytes, { hash, expectManifestSha256: manifestSha256 });
		expect(failing(r)).toEqual([]);
		expect(r.ok).toBe(true);
		expect(r.checks.map((c) => c.id)).toEqual(['archive', 'files', 'manifest', 'runs', 'inputs:baseline', 'inputs:application', 'changes', 'scenario', 'results:baseline', 'results:application', 'reproduce:baseline', 'reproduce:application']);
		expect(r.pack).toEqual(built.index.pack);
		expect(r.engine).toEqual({ here: ENGINE_VERSION, runs: [ENGINE_VERSION, ENGINE_VERSION] });
		// manifest.json IS the manifest's canonical text: its SHA-256 is the pack's hash.
		const archive = await ZipArchive.open(built.bytes);
		expect(hash(await archive.read('manifest.json'))).toBe(manifestSha256);
		expect(new TextDecoder().decode(await archive.read('README.md'))).toContain(`pnpm reproduce:pack path/to/pack-${packShortCode(manifestSha256)}.zip`);
	});

	it('is deterministic: the same pack gives the same bytes and SHA-256', async () => {
		const a = await buildPackBundle(input, hash);
		const b = await buildPackBundle(JSON.parse(JSON.stringify(input)), hash);
		expect(b.sha256).toBe(a.sha256);
		expect(b.bytes).toEqual(a.bytes);
	});

	it('builds a baseline pack without a scenario.json or an application run', async () => {
		const built = await buildPackBundle(packInput({ application: false }), hash);
		expect(built.index.runs.application).toBeNull();
		expect(Object.keys(built.index.files)).not.toContain('scenario.json');
		const r = await checkPackBundle(built.bytes, { hash });
		expect(failing(r)).toEqual([]);
		expect(r.checks.map((c) => c.id)).toEqual(['archive', 'files', 'manifest', 'runs', 'inputs:baseline', 'results:baseline', 'reproduce:baseline']);
	});

	it('skips the re-run with rerun: false', async () => {
		const r = await checkPackBundle((await buildPackBundle(input, hash)).bytes, { hash, rerun: false });
		expect(r.ok).toBe(true);
		expect(r.checks.some((c) => c.id.startsWith('reproduce:'))).toBe(false);
	});

	it('refuses to build from input values that fail their SHA-256', async () => {
		const bad = structuredClone(input);
		bad.baseline.values = { ...bad.baseline.values, rain_catchment_mm: [99, ...bad.baseline.values.rain_catchment_mm!.slice(1)] };
		await expect(buildPackBundle(bad, hash)).rejects.toThrow(/fails its SHA-256 check/);
	});

	describe('tampering', () => {
		it('a file changed without bundle.json: files fails', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const r = await checkPackBundle(await rezip(bytes, (f) => f.set('README.md', f.get('README.md') + 'x'), true), { hash });
			expect(r.ok).toBe(false);
			expect(failing(r)).toEqual(['files']);
			// Positive control: the same rezip with no change checks clean.
			expect((await checkPackBundle(await rezip(bytes, () => {}, true), { hash, rerun: false })).ok).toBe(true);
		});

		it('an entry bundle.json does not list: archive fails', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const r = await checkPackBundle(await rezip(bytes, (f) => f.set('extra.txt', 'hi'), true), { hash });
			expect(failing(r)).toEqual(['archive']);
		});

		it('another manifest hash than expected: manifest fails', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const r = await checkPackBundle(bytes, { hash, expectManifestSha256: 'a'.repeat(64) });
			expect(failing(r)).toEqual(['manifest']);
		});

		it('a manifest edited with its hashes fixed: manifest fails (it no longer hashes to the pack’s hash)', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const r = await checkPackBundle(await rezip(bytes, (f) => f.set('manifest.json', f.get('manifest.json')!.replace('"Catchment"', '"Katchment"'))), { hash });
			expect(failing(r)).toEqual(['manifest']);
		});

		it('an input value changed, bundle.json fixed: the series fails its SHA-256, and nothing is re-run', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const file = `series/${input.baseline.inputs.series.rain_catchment_mm!.valuesSha256}.csv`;
			const r = await checkPackBundle(
				await rezip(bytes, (f) => {
					const lines = f.get(file)!.split('\n');
					lines[1] = lines[1]!.replace(/,.*$/, ',77');
					f.set(file, lines.join('\n'));
				}),
				{ hash }
			);
			expect(failing(r)).toEqual(['inputs:baseline', 'inputs:application', 'reproduce:baseline', 'reproduce:application']);
			expect(r.checks.find((c) => c.id === 'inputs:baseline')!.detail).toMatch(/fail their SHA-256 check/);
		});

		it('a baseline setting changed in input.json: inputs fails against the manifest', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const r = await checkPackBundle(
				await rezip(bytes, (f) => {
					const snap = JSON.parse(f.get('runs/baseline/input.json')!) as RunInputsSnapshot;
					(snap.settings as Record<string, unknown>).gr4j = { x1: 421, x2: 0, x3: 85, x4: 2.1, warmupDays: 90 };
					f.set('runs/baseline/input.json', canonicalJson(snap));
				}),
				{ hash }
			);
			expect(failing(r)).toContain('inputs:baseline');
			expect(r.checks.find((c) => c.id === 'inputs:baseline')!.detail).toMatch(/settings aren't the manifest's \(gr4j\.x1\)/);
		});

		it('scenario ops edited: scenario fails', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const r = await checkPackBundle(
				await rezip(bytes, (f) => f.set('scenario.json', f.get('scenario.json')!.replace('600000', '700000'))),
				{ hash, rerun: false }
			);
			expect(failing(r)).toEqual(['scenario']);
		});

		it('stored results the engine does not reproduce: results check, re-run fails and names the output', async () => {
			// A run whose stored daily output was altered before the bundle was built (so every hash agrees).
			const tampered = structuredClone(input);
			const out = tampered.baseline.series.find((s) => s.key === 'simulated_outflow')!;
			out.values = out.values.map((v, i) => (i === 100 && v !== null ? v + 1 : v));
			const built = await buildPackBundle(tampered, hash);
			const r = await checkPackBundle(built.bytes, { hash });
			expect(failing(r)).toEqual(['reproduce:baseline']);
			expect(r.checks.find((c) => c.id === 'reproduce:baseline')!.detail).toMatch(/1 daily output differs \(simulated_outflow\)/);
			// Positive control: the untampered pack reproduces.
			expect((await checkPackBundle((await buildPackBundle(input, hash)).bytes, { hash })).ok).toBe(true);
		});

		it('a stored summary other than the manifest’s: results fails', async () => {
			const tampered = structuredClone(input);
			(tampered.baseline.summary as Record<string, unknown>).tampered = 1;
			const r = await checkPackBundle((await buildPackBundle(tampered, hash)).bytes, { hash });
			expect(failing(r)).toEqual(['results:baseline', 'reproduce:baseline']);
		});

		it('a hostile many-entry zip is refused at its directory, beside a valid bundle (control)', async () => {
			const enc = new TextEncoder();
			const tiny = enc.encode('x');
			const crc = crc32(tiny);
			const many = storedZip([{ name: 'bundle.json', data: enc.encode('{}'), crc: crc32(enc.encode('{}')) }, ...Array.from({ length: 50_000 }, (_, i) => ({ name: `f${i}`, data: tiny, crc }))]);
			const r = await checkPackBundle(many, { hash });
			expect(failing(r)).toEqual(['archive']);
			expect((await checkPackBundle((await buildPackBundle(input, hash)).bytes, { hash, rerun: false })).ok).toBe(true);
		});

		it('many unlisted entries within the cap, and an index listing more files than a bundle holds, fail with a short message', async () => {
			const bytes = (await buildPackBundle(input, hash)).bytes;
			const flooded = await rezip(
				bytes,
				(f) => {
					for (let i = 0; i < BUNDLE_ZIP_LIMITS.maxEntries - 20; i++) f.set(`junk/${i}`, 'x');
				},
				true
			);
			const r = await checkPackBundle(flooded, { hash });
			expect(failing(r)).toEqual(['archive']);
			expect(r.checks[0]!.detail).toMatch(/and \d+ more/);
			expect(r.checks[0]!.detail.length).toBeLessThan(500);
			const bloated = await rezip(
				bytes,
				(f) => {
					const index = JSON.parse(f.get('bundle.json')!) as PackBundleIndex;
					for (let i = 0; i <= BUNDLE_ZIP_LIMITS.maxEntries; i++) index.files[`ghost/${i}`] = 'a'.repeat(64);
					f.set('bundle.json', canonicalJson(index));
				},
				true
			);
			expect(failing(await checkPackBundle(bloated, { hash }))).toEqual(['archive']);
		});

		it('not a zip: archive fails, never throws', async () => {
			const r = await checkPackBundle(new TextEncoder().encode('nope'), { hash });
			expect(r.ok).toBe(false);
			expect(r.pack).toBeNull();
			expect(failing(r)).toEqual(['archive']);
		});
	});
});

describe('seriesCsv / parseSeriesCsv', () => {
	it('round-trips values exactly, a missing day empty', () => {
		const values = [0, 0.1 + 0.2, null, 1e-7, -3.5, 123456789.123];
		const csv = seriesCsv('2000-02-28', values);
		expect(csv.split('\n').slice(0, 4)).toEqual(['date,value', '2000-02-28,0', '2000-02-29,0.30000000000000004', '2000-03-01,']);
		expect(parseSeriesCsv(csv)).toEqual({ startDate: '2000-02-28', values });
		expect(parseSeriesCsv('date,value\n')).toEqual({ startDate: null, values: [] });
	});

	it('refuses a gap in the dates, a bad number and another header', () => {
		expect(() => parseSeriesCsv('date,value\n2000-01-01,1\n2000-01-03,2\n')).toThrow(/doesn't follow/);
		expect(() => parseSeriesCsv('date,value\n2000-01-01,abc\n')).toThrow(/not a number/);
		expect(() => parseSeriesCsv('date,value\n2000-01-01, 1\n')).toThrow(/not a number/);
		expect(() => parseSeriesCsv('day,value\n')).toThrow(/header/);
	});
});

describe('runResultsText / runResultsDigest', () => {
	const r = {
		startDate: '2000-01-01',
		summary: { mar: 1.5, nan: Number.NaN },
		series: [
			{ nodeId: 'b', key: 'k', label: 'B', values: [1, 2] },
			{ nodeId: null, key: 'flow', label: 'Flow', values: [Number.POSITIVE_INFINITY, 3] }
		]
	};

	it('ignores labels and order, and stores NaN and infinity as null', async () => {
		const a = await runResultsDigest(r, hash);
		const b = await runResultsDigest({ ...r, summary: { nan: null, mar: 1.5 }, series: [{ ...r.series[1]!, label: 'x', values: [null, 3] }, r.series[0]!] }, hash);
		expect(b.sha256).toBe(a.sha256);
		expect(a.series.map((s) => s.nodeId)).toEqual([null, 'b']);
		expect(hash(runResultsText({ ...r, series: a.series }))).toBe(a.sha256);
	});

	it('changes with a value, the first day or the summary', async () => {
		const a = (await runResultsDigest(r, hash)).sha256;
		expect((await runResultsDigest({ ...r, series: [{ ...r.series[0]!, values: [1, 2.0000001] }, r.series[1]!] }, hash)).sha256).not.toBe(a);
		expect((await runResultsDigest({ ...r, startDate: '2000-01-02' }, hash)).sha256).not.toBe(a);
		expect((await runResultsDigest({ ...r, summary: { mar: 1.6 } }, hash)).sha256).not.toBe(a);
	});
});
