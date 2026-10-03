// pnpm reproduce:pack (issue #71, docs/evidence-pack.md § Reproduction): on a
// real bundle of the engine's pack fixture it reproduces and exits 0; a
// tampered bundle, another expected hash or a missing file each exit non-zero
// with the failing check named; --no-run and --json; the arguments. Run by the
// backend's unit project (backend/vitest.config.ts), whose tsx runs it.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPackBundle } from '../../packages/engine/src/evidence/bundle';
import { packManifestText } from '../../packages/engine/src/evidence/pack';
import { packBundleFixture } from '../../packages/engine/src/testing/packBundle';
import { zip, ZipArchive } from '../../packages/engine/src/zip';
import { main, parseArgs } from './reproduce-pack';

const hash = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex');

let dir: string;
let good: string;
let tampered: string;
let manifestSha256: string;

/** Run the command, collecting what it writes. */
async function run(argv: string[], env: NodeJS.ProcessEnv = { INIT_CWD: dir }) {
	let out = '';
	const code = await main(argv, env, (s) => (out += s));
	return { code, out };
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'reproduce-pack-'));
	const input = packBundleFixture(hash);
	manifestSha256 = hash(packManifestText(input.manifest));
	const built = await buildPackBundle(input, hash);
	good = join(dir, 'pack.zip');
	await writeFile(good, built.bytes);
	// The same bundle with one stored daily output changed before it was built: every hash agrees, the re-run doesn't.
	const bad = structuredClone(input);
	const out = bad.application!.series.find((s) => s.key === 'simulated_outflow')!;
	out.values = out.values.map((v, i) => (i === 200 && v !== null ? v * 2 + 1 : v));
	tampered = join(dir, 'tampered.zip');
	await writeFile(tampered, (await buildPackBundle(bad, hash)).bytes);
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('reproduce:pack', () => {
	it('reproduces a good bundle: every check ok, exit 0, the bundle’s SHA-256 printed', async () => {
		const { code, out } = await run(['pack.zip', '--expect', manifestSha256.toUpperCase()]);
		expect(code, out).toBe(0);
		expect(out).toMatch(/^Evidence pack [0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}, version 1/);
		expect(out).toMatch(/ok\s+reproduce:baseline /);
		expect(out).toMatch(/ok\s+reproduce:application /);
		expect(out).not.toMatch(/FAIL/);
		expect(out).toContain('Reproduced: every file matches, and each run re-runs to the same results.');
		expect(out).toContain(`Bundle SHA-256: ${hash(await readFile(good))}`);
	});

	it('fails a bundle whose stored results the engine doesn’t reproduce: exit 1, the run named', async () => {
		const { code, out } = await run([tampered]);
		expect(code).toBe(1);
		expect(out).toMatch(/FAIL\s+reproduce:application\s+re-run with engine .*1 daily output differs \(simulated_outflow\)/);
		expect(out).toMatch(/ok\s+reproduce:baseline /);
		expect(out).toContain('NOT reproduced: 1 check failed.');
	});

	it('fails another expected manifest hash, and a file changed without its index', async () => {
		expect((await run([good, '--expect', 'a'.repeat(64)])).code).toBe(1);
		const archive = await ZipArchive.open(new Uint8Array(await readFile(good)));
		const entries = [];
		for (const name of archive.names) {
			const data = await archive.read(name);
			entries.push({ name, data: name === 'README.md' ? new TextEncoder().encode('changed') : new Uint8Array(data) });
		}
		await writeFile(join(dir, 'edited.zip'), await zip(entries));
		const { code, out } = await run(['edited.zip']);
		expect(code).toBe(1);
		expect(out).toMatch(/FAIL\s+files\s+.*README\.md/);
	});

	it('reports a malformed bundle whose files match their hashes as a failing check, exit 1, never a crash', async () => {
		const archive = await ZipArchive.open(new Uint8Array(await readFile(good)));
		const files = new Map<string, Uint8Array<ArrayBuffer>>();
		for (const name of archive.names) files.set(name, new Uint8Array(await archive.read(name)));
		const notJson = new TextEncoder().encode('not json');
		files.set('manifest.json', notJson);
		const index = JSON.parse(new TextDecoder().decode(files.get('bundle.json')!));
		index.files['manifest.json'] = hash(notJson);
		files.set('bundle.json', new TextEncoder().encode(JSON.stringify(index)));
		await writeFile(join(dir, 'malformed.zip'), await zip([...files].map(([name, data]) => ({ name, data }))));
		const { code, out } = await run(['malformed.zip']);
		expect(code).toBe(1);
		expect(out).toMatch(/^Reproduction bundle /);
		expect(out).toMatch(/ok\s+files\s/);
		expect(out).toMatch(/FAIL\s+structure\s+the bundle is malformed: /);
		expect(out).toContain('NOT reproduced: 1 check failed.');
	});

	it('draws an evidence-12 pack’s locality map again and checks its SVG against the manifest (figure:locality); a wrong hash fails it', async () => {
		await writeFile(join(dir, 'locality.zip'), (await buildPackBundle(packBundleFixture(hash, { locality: true }), hash)).bytes);
		const ok = await run(['locality.zip', '--no-run']);
		expect(ok.code, ok.out).toBe(0);
		expect(ok.out).toMatch(/ok\s+figure:locality\s+the locality map drawn again from the manifest's 4 map features hashes to [0-9a-f]{64}/);
		await writeFile(join(dir, 'locality-bad.zip'), (await buildPackBundle(packBundleFixture(hash, { locality: { svgSha256: 'd'.repeat(64) } }), hash)).bytes);
		const bad = await run(['locality-bad.zip', '--no-run']);
		expect(bad.code).toBe(1);
		expect(bad.out).toMatch(/FAIL\s+figure:locality\s+the locality map drawn again hashes to [0-9a-f]{64}, not the d{64}/);
		// Positive control for an older pack: the good bundle above has no figure, and no such check.
		expect((await run([good, '--no-run'])).out).not.toContain('figure:locality');
	});

	it('checks without re-running with --no-run, and prints JSON with --json', async () => {
		const noRun = await run([good, '--no-run']);
		expect(noRun.code).toBe(0);
		expect(noRun.out).not.toContain('reproduce:');
		expect(noRun.out).toContain('not re-run: --no-run');
		const json = await run([good, '--json', '--no-run']);
		expect(json.code).toBe(0);
		const parsed = JSON.parse(json.out);
		expect(parsed).toMatchObject({ ok: true, file: good, pack: { manifestSha256, version: 1 } });
		expect(parsed.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it('exits 2 on a usage error or a file it can’t read', async () => {
		expect((await run([])).code).toBe(2);
		expect((await run(['a.zip', 'b.zip'])).code).toBe(2);
		expect((await run([good, '--expect', 'abc'])).code).toBe(2);
		expect((await run([good, '--bogus'])).code).toBe(2);
		const missing = await run(['nope.zip']);
		expect(missing.code).toBe(2);
		expect(missing.out).toContain(join(dir, 'nope.zip'));
	});

	it('reads its arguments', () => {
		expect(parseArgs(['x.zip'])).toEqual({ file: 'x.zip', expect: null, rerun: true, json: false });
		expect(parseArgs(['--no-run', 'x.zip', '--json', '--expect', 'F'.repeat(64)])).toEqual({ file: 'x.zip', expect: 'f'.repeat(64), rerun: false, json: true });
		expect(parseArgs(['--expect'])).toHaveProperty('error');
	});
});
