// The A-pan grid layer (geo/evaporationLayerRoutes.ts, docs/maps.md § A-pan
// grid): GET /projects/:id/map/evaporation-grid over invented grids written
// here (an A-pan grid of 0.1° cells, a fine A-pan grid to overflow one
// answer) beside the committed synthetic grid, which is reference ET and
// never listed. A viewer reads one kind's dataset:
// each cell's centre and the year's total (the 12 months summed), or one
// month's value when asked; the A-pan listing says "modelled" for the Atlas's
// grid; a box holding more of the grid's cells than one answer carries comes
// back tooDense; an unknown dataset is 404; a bad kind (et0, or the S-pan
// kind removed on 2026-11-09), month or bbox 400 with no SQL in the answer; a non-member gets 404 and
// a farmer 403, with a member's read as the positive control.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSyntheticEvaporation } from '../../scripts/import-evaporation.js';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { ATLAS_APAN, atlasApanMethodFor } from './evaporationGrid.js';
import { EVAPORATION_GRID_BBOX_MAX_DEG, EVAPORATION_GRID_LAYER_MAX } from './evaporationLayerRoutes.js';

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;

const outlet = node('Weir', null);
const farm = node('Farm E', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };

const APAN = 'layer-test-apan';
const FINE = 'layer-test-apan-fine';
/** Oct … Sep, invented: 1 800 mm a year. */
const ROW = [180, 210, 240, 250, 210, 180, 120, 90, 70, 75, 75, 100];

const url = (q: Record<string, string>, id = projectId) => `/projects/${id}/map/evaporation-grid?${new URLSearchParams(q)}`;
/** The four 0.1° cells round 21.35° E, 33.65° S. */
const BOX = '21.3,-33.7,21.4,-33.6';

async function dataset(name: string, kind: 'apan', cellDeg: number, origin: number, extra: { source?: string; attribution?: string; method?: string } = {}) {
	await asOwner(
		`INSERT INTO evaporation_dataset (dataset, kind, source, version, method, attribution, first_year, last_year, cell_deg, origin_lon, origin_lat)
		 VALUES ($1, $2, $3, 'v1', $4, $5, 1950, 1999, $6, $7, $7)`,
		[name, kind, extra.source ?? `Invented ${kind} grid`, extra.method ?? 'Invented.', extra.attribution ?? 'none', cellDeg, origin]
	);
}

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['ELowner', 'ELviewer', 'ELfarmer', 'ELstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Evaporation grid layers' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [crop], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	// The reference ET grid: loaded, never one of the layers' datasets.
	await loadSyntheticEvaporation(process.env.TEST_MIGRATION_DATABASE_URL!);
	await asOwner('DELETE FROM evaporation_dataset WHERE dataset = ANY($1::text[])', [[APAN, FINE]]);
	// Corners on whole tenths (origin 0): rows −337 and −338 are centred on −33.65° and −33.75°, columns 212 and 213 on 21.25° and 21.35°.
	await dataset(APAN, 'apan', 0.1, 0, { source: ATLAS_APAN.source, attribution: ATLAS_APAN.attribution, method: atlasApanMethodFor(0.1, 1950, 1999) });
	await asOwner(`INSERT INTO evaporation_cell_reference (dataset, row_idx, col_idx, monthly_mm) SELECT $1, r, c, $2::real[] FROM unnest(ARRAY[-337, -338]) r, unnest(ARRAY[212, 213]) c`, [APAN, ROW]);
	// A 0.01° grid, loaded earlier so the 0.1° one stays the default (the newest load first).
	await dataset(FINE, 'apan', 0.01, 0);
	await asOwner(`UPDATE evaporation_dataset SET loaded_at = now() - interval '1 day' WHERE dataset = $1`, [FINE]);
	await asOwner(`INSERT INTO evaporation_cell_reference (dataset, row_idx, col_idx, monthly_mm) VALUES ($1, -3365, 2135, $2::real[])`, [FINE, ROW]);
}, 60_000);

afterAll(async () => {
	await asOwner('DELETE FROM evaporation_dataset WHERE dataset = ANY($1::text[])', [[APAN, FINE]]);
});

describe('GET /projects/:id/map/evaporation-grid', () => {
	it('gives a viewer the default A-pan grid’s cells in the box, each its centre and the year’s total, listing only A-pan grids', async () => {
		const res = await viewer.call('GET', url({ kind: 'apan', bbox: '21.2,-33.8,21.4,-33.6' }));
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ kind: 'apan', month: null, tooDense: false, max: EVAPORATION_GRID_LAYER_MAX });
		expect(res.body.dataset).toMatchObject({ dataset: APAN, kind: 'apan', cellDeg: 0.1, firstYear: 1950, lastYear: 1999, synthetic: false, attribution: ATLAS_APAN.attribution });
		// The Atlas's grid is said to be modelled wherever it is named.
		expect(res.body.dataset.label).toMatch(/modelled.*not a measured pan/);
		expect(res.body.dataset).not.toHaveProperty('grid');
		// No reference ET (the synthetic grid) among the A-pan layer's datasets.
		expect(res.body.datasets.map((d: { dataset: string }) => d.dataset)).toEqual([APAN, FINE]);
		expect(res.body.cells).toEqual([
			[21.25, -33.75, 1800],
			[21.35, -33.75, 1800],
			[21.25, -33.65, 1800],
			[21.35, -33.65, 1800]
		]);
	});

	it('gives one month’s mean total when asked (a calendar month, read from the Oct … Sep row)', async () => {
		const jan = await viewer.call('GET', url({ kind: 'apan', bbox: BOX, month: '1' }));
		expect(jan.status).toBe(200);
		expect(jan.body.month).toBe(1);
		expect(jan.body.cells).toEqual([[21.35, -33.65, 250]]);
		expect((await viewer.call('GET', url({ kind: 'apan', bbox: BOX, month: '10' }))).body.cells).toEqual([[21.35, -33.65, 180]]);
		expect((await viewer.call('GET', url({ kind: 'apan', bbox: BOX, month: '9' }))).body.cells).toEqual([[21.35, -33.65, 100]]);
	});

	it('says tooDense, with no cells, when the box holds more of the grid’s cells than one answer carries', async () => {
		// 1° × 1° of 0.01° cells is 10 000 > 5 000.
		const res = await viewer.call('GET', url({ kind: 'apan', bbox: '21,-34,22,-33', dataset: FINE }));
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ tooDense: true, cells: [] });
		const near = await viewer.call('GET', url({ kind: 'apan', bbox: '21.3,-33.7,21.4,-33.6', dataset: FINE }));
		expect(near.body).toMatchObject({ tooDense: false, cells: [[21.355, -33.645, 1800]] });
	});

	it('refuses an unknown dataset (404) and a bad kind, month or bbox (400), with no SQL in the answer', async () => {
		expect((await viewer.call('GET', url({ kind: 'apan', bbox: BOX, dataset: 'nope' }))).status).toBe(404);
		for (const q of <Record<string, string>[]>[
			{ kind: 'et0', bbox: BOX },
			{ kind: 'span', bbox: BOX },
			{ bbox: BOX },
			{ kind: 'apan', bbox: BOX, month: '13' },
			{ kind: 'apan', bbox: BOX, month: '0' },
			{ kind: 'apan', bbox: BOX, month: 'jan' },
			{ kind: 'apan', bbox: '21,-33' },
			{ kind: 'apan', bbox: '21.5,-33.7,21.4,-33.6' },
			{ kind: 'apan', bbox: `21,-34,${21 + EVAPORATION_GRID_BBOX_MAX_DEG + 0.1},-33` }
		]) {
			const res = await viewer.call('GET', url(q));
			expect(res.status, JSON.stringify(q)).toBe(400);
			expect(JSON.stringify(res.body)).not.toMatch(/evaporation_|SELECT/);
		}
	});

	it('is closed to a non-member (404) and to a farmer (403); the owner reads it (control)', async () => {
		expect((await stranger.call('GET', url({ kind: 'apan', bbox: BOX }))).status).toBe(404);
		expect((await farmer.call('GET', url({ kind: 'apan', bbox: BOX }))).status).toBe(403);
		const mine = await owner.call('GET', url({ kind: 'apan', bbox: BOX }));
		expect(mine.status).toBe(200);
		expect(mine.body.cells).toHaveLength(1);
	});
});
