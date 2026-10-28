// A modelled Class-A pan grid (PenPan, issue #646 item 7) through the
// operator's load: the file ingest/apan_grid.py writes (its committed
// synthetic output, ingest/fixtures/apan/penpan.synthetic.json, which
// test_apan_grid.py keeps equal to its generator) reads as kind "apan" with
// its model; its source always says "Modelled Class-A pan (PenPan)" (an
// operator's --source is put after it); the method text says modelled, not
// measured, with the screen and albedo; a model on a reference-ET grid, or a
// malformed one, is refused; an A-pan grid with no model must name its
// source and attribution (dPET's lines are never put on it); --out keeps the
// model; a .json.gz loads.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEvaporationArgs, readEvaporationFiles, SYNTHETIC_PENPAN_FILE as PENPAN_FIXTURE, writeEvaporationJson } from '../../scripts/import-evaporation.js';
import { DPET, evaporationFromJson, evaporationMethodFor, MODELLED_APAN_LABEL, modelledApanSource, PENPAN } from './evaporationGrid.js';
import { evaporationLabel } from './evaporation.js';

const fixture = () => JSON.parse(readFileSync(PENPAN_FIXTURE, 'utf8')) as Record<string, unknown> & { cells: unknown[]; model: Record<string, unknown> };

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'penpan-grid-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const loadArgs = (file: string, extra: string[] = []) => {
	const a = parseEvaporationArgs([file, '--dataset', 'penpan-test', ...extra], { INIT_CWD: '/' } as NodeJS.ProcessEnv);
	if (typeof a === 'string' || a.mode !== 'load') throw new Error(String(a));
	return a;
};

describe('the PenPan grid’s form', () => {
	it('reads apan_grid.py’s file as kind apan with its model, every cell kept', () => {
		const got = evaporationFromJson(fixture());
		if (typeof got === 'string') throw new Error(got);
		expect(got.kind).toBe('apan');
		expect(got.problems).toEqual([]);
		expect(got.climatology.cells).toHaveLength(400);
		expect(got.climatology.originLat).toBeCloseTo(0, 9);
		expect(got.meta.model).toEqual({ name: 'penpan', groundAlbedo: 0.23, screen: 1, inputs: expect.stringMatching(/NASA POWER point/) });
		expect(got.meta.source).toBe(PENPAN.source);
		expect(got.meta.attribution).toBe(PENPAN.attribution);
	});

	it('refuses a model on a reference-ET grid and a malformed model', () => {
		const f = fixture();
		expect(evaporationFromJson({ ...f, kind: 'et0' })).toMatch(/only an A-pan grid .* carries a "model"/);
		expect(evaporationFromJson({ ...f, model: { ...f.model, name: 'penman' } })).toMatch(/not \{"name": "penpan"/);
		expect(evaporationFromJson({ ...f, model: { ...f.model, screen: 2 } })).toMatch(/"screen" is not 0.5–1/);
		expect(evaporationFromJson({ ...f, model: { ...f.model, groundAlbedo: -0.1 } })).toMatch(/"groundAlbedo" is not 0–1/);
		expect(evaporationFromJson({ ...f, model: { ...f.model, inputs: ' ' } })).toMatch(/names no "inputs"/);
	});

	it('the method says modelled, not measured, with its screen and albedo', () => {
		const m = { name: 'penpan' as const, groundAlbedo: 0.23, screen: 1, inputs: 'POWER weather' };
		const text = evaporationMethodFor(0.1, 1991, 2020, 'apan', m);
		expect(text).toMatch(/^Modelled, not measured: PenPan \(Rotstayn et al\. 2006; McMahon et al\. 2013, Supplement S6, eqs\. S6\.1–S6\.6\) for an unscreened US Class-A pan, ground albedo 0\.23, from POWER weather/);
		expect(text).toMatch(/averaged over 1991–2020/);
		expect(evaporationMethodFor(0.1, 1991, 2020, 'apan', { ...m, screen: 0.93 })).toMatch(/for a screened \(× 0\.93\) US Class-A pan/);
		// Without a model, the measured wording stays.
		expect(evaporationMethodFor(0.1, 1991, 2020, 'apan')).toMatch(/^Pre-summarised at import: each 0\.1° cell's daily A-pan evaporation/);
	});

	it('a PenPan source always starts with the modelled label', () => {
		expect(modelledApanSource(PENPAN.source)).toBe(PENPAN.source);
		expect(modelledApanSource('my own POWER pull')).toBe(`${MODELLED_APAN_LABEL}: my own POWER pull`);
	});
});

describe('the operator’s load of a PenPan grid', () => {
	it('takes the file’s lines, prefixes an operator’s --source, and writes the PenPan method', async () => {
		const read = await readEvaporationFiles(loadArgs(PENPAN_FIXTURE));
		expect(read.meta).toMatchObject({ dataset: 'penpan-test', kind: 'apan', source: PENPAN.source, version: PENPAN.version, attribution: PENPAN.attribution });
		expect(read.meta.method).toMatch(/^Modelled, not measured: PenPan/);
		const own = await readEvaporationFiles(loadArgs(PENPAN_FIXTURE, ['--source', 'POWER 1991–2020, my run']));
		expect(own.meta.source).toBe('Modelled Class-A pan (PenPan): POWER 1991–2020, my run');
		// Without the file's lines, PenPan's own defaults, never dPET's.
		const bare = join(dir, 'bare.json');
		const { source: _s, version: _v, attribution: _a, ...rest } = fixture();
		writeFileSync(bare, JSON.stringify(rest));
		const b = await readEvaporationFiles(loadArgs(bare));
		expect(b.meta).toMatchObject({ source: PENPAN.source, version: PENPAN.version, attribution: PENPAN.attribution });
		expect(b.meta.attribution).not.toBe(DPET.attribution);
	});

	it('an A-pan grid with no model names its source and attribution, else it is refused', async () => {
		const { model: _m, source: _s, attribution: _a, ...rest } = fixture();
		const f = join(dir, 'apan-unnamed.json');
		writeFileSync(f, JSON.stringify(rest));
		await expect(readEvaporationFiles(loadArgs(f))).rejects.toThrow(/an A-pan grid names its source and attribution/);
		const ok = await readEvaporationFiles(loadArgs(f, ['--source', 'Station pans, interpolated', '--attribution', 'DWS']));
		expect(ok.meta).toMatchObject({ kind: 'apan', source: 'Station pans, interpolated', attribution: 'DWS' });
		expect(ok.meta.method).toMatch(/^Pre-summarised at import/);
	});

	it('--out keeps the model, and a .json.gz loads', async () => {
		const gz = join(dir, 'penpan.json.gz');
		writeFileSync(gz, gzipSync(readFileSync(PENPAN_FIXTURE)));
		const out = join(dir, 'out.json.gz');
		const { written } = await writeEvaporationJson({ ...loadArgs(gz), out });
		expect(written).toBe(400);
		const back = JSON.parse(gunzipSync(readFileSync(out)).toString('utf8'));
		expect(back.kind).toBe('apan');
		expect(back.model).toEqual(fixture().model);
		expect(back.source).toBe(PENPAN.source);
	});
});

describe('the words for a dataset’s values', () => {
	it('say modelled for a PenPan grid, and leave a measured pan grid and ET₀ as they were', () => {
		expect(evaporationLabel({ kind: 'apan', source: PENPAN.source })).toBe('modelled Class-A pan evaporation (PenPan, not a measured pan)');
		expect(evaporationLabel({ kind: 'apan', source: modelledApanSource('my own POWER pull') })).toMatch(/^modelled /);
		expect(evaporationLabel({ kind: 'apan', source: 'A measured pan grid' })).toBe('Class-A pan evaporation');
		expect(evaporationLabel({ kind: 'et0', source: DPET.source })).toBe('reference evapotranspiration (FAO-56 Penman-Monteith ET₀)');
	});
});
