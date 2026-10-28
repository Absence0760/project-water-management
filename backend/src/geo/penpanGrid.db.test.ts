// A modelled Class-A pan grid (PenPan, issue #646 item 7) against Postgres:
//  - `pnpm import:evaporation <penpan.json> --dataset …` loads apan_grid.py's
//    file (its committed synthetic output) as an A-pan dataset whose source
//    says "Modelled Class-A pan (PenPan)" and whose method says modelled, not
//    measured;
//  - proposed from the map, its 12 values go into the A-pan row, and the
//    revision's reason carries the modelled label (never a measured pan);
//  - production refuses it: the same file through the migrate Lambda's load
//    (loadReferenceText, kind evaporation) is refused before anything is
//    written, and the release gate (map-data-gates.mjs) refuses a PenPan key
//    or label before the approval (control: dPET's passes).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importEvaporation, parseEvaporationArgs, SYNTHETIC_PENPAN_FILE as PENPAN_FIXTURE } from '../../scripts/import-evaporation.js';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { PENPAN } from './evaporationGrid.js';
import { LoadError, loadReferenceText, parseLoadRequest, readReferenceText, type ReadObject } from './referenceLoad.js';

const GATES = new URL('../../../scripts/release/map-data-gates.mjs', import.meta.url).href;
const DS = 'test-penpan';
const PROD = 'test-penpan-prod';
type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let projectId: string;
const outlet = node('Weir', null);
const at = (p: string) => `/projects/${projectId}${p}`;

const cleanup = () => asOwner('DELETE FROM evaporation_dataset WHERE dataset = ANY($1::text[])', [[DS, PROD]]);

beforeAll(async () => {
	await cleanup();
	owner = await signUp('Ppenpan');
	projectId = (await owner.call('POST', '/projects', { name: 'PenPan from the map' })).body.project.id;
	expect((await owner.call('PUT', at('/model'), { nodes: [outlet], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	// Inside the fixture's box (20.5–22.5° E, 34.5–32.5° S), over the cells whose nearest POWER point is 21.25, -33.75.
	const ring = [
		[21.21, -33.79],
		[21.29, -33.79],
		[21.29, -33.71],
		[21.21, -33.71],
		[21.21, -33.79]
	];
	const b = await owner.call('POST', at('/map/features'), { kind: 'catchment_boundary', name: 'Catchment', geometry: { type: 'Polygon', coordinates: [ring] } });
	expect(b.status, JSON.stringify(b.body)).toBe(201);
}, 60_000);

afterAll(cleanup);

describe('a PenPan grid, locally', () => {
	it('loads as a modelled A-pan dataset and proposes into the A-pan row, labelled modelled', async () => {
		const args = parseEvaporationArgs([PENPAN_FIXTURE, '--dataset', DS]);
		if (typeof args === 'string' || args.mode !== 'load') throw new Error(String(args));
		const { written } = await importEvaporation(process.env.TEST_MIGRATION_DATABASE_URL!, args);
		expect(written).toBe(400);
		const [row] = await asOwner('SELECT kind, source, version, method, attribution, first_year, last_year FROM evaporation_dataset WHERE dataset = $1', [DS]);
		expect(row).toMatchObject({ kind: 'apan', source: PENPAN.source, version: PENPAN.version, attribution: PENPAN.attribution, first_year: 2020, last_year: 2020 });
		expect(row!.method).toMatch(/^Modelled, not measured: PenPan/);

		// The cell centred on 21.25, -33.75 (the four 0.1° cells round it share the point's values).
		const fixture = JSON.parse(readFileSync(PENPAN_FIXTURE, 'utf8')) as { cells: [number, number, number[]][] };
		const values = fixture.cells.find((c) => c[0] === 21.25 && c[1] === -33.75)![2];
		const p = await owner.call('GET', at(`/evaporation-proposals?dataset=${DS}`));
		expect(p.status, JSON.stringify(p.body)).toBe(200);
		expect(p.body.target).toBe('apan');
		p.body.proposal.monthlyMm.forEach((v: number, i: number) => expect(v).toBeCloseTo(values[i]!, 0));
		const res = await owner.call('POST', at('/evaporation-from-map'), { dataset: DS });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.target).toBe('apan');
		const [{ reason }] = (await asOwner('SELECT reason FROM model_revision WHERE project_id = $1 ORDER BY id DESC LIMIT 1', [projectId])) as [{ reason: string }];
		expect(reason).toMatch(/Modelled Class-A pan \(PenPan\)/);
		expect(reason).toMatch(/not a measured pan/);
		// The provenance row keeps the whole method (the reason is cut at 500 characters).
		const [acc] = await asOwner('SELECT kind, method FROM evaporation_accepted WHERE project_id = $1', [projectId]);
		expect(acc).toMatchObject({ kind: 'apan', method: expect.stringMatching(/^Modelled, not measured: PenPan/) });
	});
});

describe('a PenPan grid, in production', () => {
	it('the migrate Lambda’s load refuses it and writes nothing', async () => {
		const bytes = gzipSync(readFileSync(PENPAN_FIXTURE));
		const req = parseLoadRequest({ kind: 'evaporation', key: 'reference/evaporation/grid.json.gz', dataset: PROD, sha256: createHash('sha256').update(bytes).digest('hex') });
		const read: ReadObject = async () => ({ contentLength: bytes.byteLength, bytes: async () => bytes });
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			const err = await loadReferenceText(client, req, await readReferenceText(req, read)).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(LoadError);
			expect((err as LoadError).code).toBe('refused');
			expect((err as LoadError).publicReason).toMatch(/only a reference-ET grid/);
		} finally {
			await client.end();
		}
		expect(await asOwner('SELECT dataset FROM evaporation_dataset WHERE dataset = $1', [PROD])).toEqual([]);
	});

	it('the release gate refuses a PenPan key or label before the approval (control: dPET passes)', async () => {
		const { loadProblems } = (await import(GATES)) as { loadProblems: (env: Record<string, string>, hasText: () => boolean) => string[] };
		const base = { LOAD_KIND: 'evaporation', LOAD_SHA256: 'a'.repeat(64), LOAD_SOURCE: '', LOAD_MIN_ORDER: '1' };
		const lacks = () => false;
		expect(loadProblems({ ...base, LOAD_KEY: 'reference/evaporation/dpet.json.gz', LOAD_DATASET: 'dPET-1991-2020' }, lacks)).toEqual([]);
		expect(loadProblems({ ...base, LOAD_KEY: 'reference/evaporation/penpan.json.gz', LOAD_DATASET: 'PenPan-1991-2020' }, lacks)).toEqual([
			expect.stringMatching(/modelled Class-A pan, PenPan\) is blocked in production/)
		]);
	});
});
