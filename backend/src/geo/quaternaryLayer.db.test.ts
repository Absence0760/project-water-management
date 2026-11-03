// The quaternary outlines layer (issue #326 A6; geo/quaternaryLayer.ts):
// GET /projects/:id/map/quaternaries?bbox= over the committed synthetic
// dataset (six invented 0.25° cells in region Z). A viewer reads the codes
// and outlines whose box meets the bbox, marked synthetic, and no reference
// values; a bad or oversized bbox is refused; a non-member gets 404 and a
// farmer 403, with a member's read as the positive control.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { SYNTHETIC_FILE } from '../../scripts/import-quaternaries.js';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { quaternaryRecords, replaceDataset } from './loadQuaternaries.js';
import { SYNTHETIC_DATASET } from './quaternary.js';
import { QUATERNARY_BBOX_MAX_DEG } from './quaternaryLayer.js';

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;

const outlet = node('Weir', null);
const farm = node('Farm Q', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const url = (bbox: string, id = projectId) => `/projects/${id}/map/quaternaries?bbox=${encodeURIComponent(bbox)}`;

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['QLowner', 'QLviewer', 'QLfarmer', 'QLstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Quaternary layer' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [crop], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await replaceDataset(client, SYNTHETIC_DATASET, quaternaryRecords(JSON.parse(readFileSync(SYNTHETIC_FILE, 'utf8')), '').records);
	} finally {
		await client.end();
	}
}, 60_000);

describe('GET /projects/:id/map/quaternaries', () => {
	it('gives a viewer the outlines whose box meets the bbox, by code, marked synthetic, with no reference values', async () => {
		const res = await viewer.call('GET', url('21.3,-33.7,21.4,-33.6'));
		expect(res.status).toBe(200);
		expect(res.body.quaternaries.map((q: { code: string }) => q.code)).toEqual(['Z01B']);
		const [q] = res.body.quaternaries;
		expect(q).toEqual({ code: 'Z01B', dataset: 'synthetic', synthetic: true, geometry: { type: 'Polygon', coordinates: expect.any(Array) } });
		expect(res.body.truncated).toBe(false);
		expect(res.body.bbox).toEqual([21.3, -33.7, 21.4, -33.6]);
		expect(res.body.datasets).toEqual(expect.arrayContaining([{ dataset: 'synthetic', count: 6 }]));

		const wide = await viewer.call('GET', url('21.2,-33.8,21.6,-33.5'));
		expect(wide.body.quaternaries.map((q: { code: string }) => q.code)).toEqual(['Z01A', 'Z01B', 'Z01C', 'Z02A', 'Z02B', 'Z02C']);
	});

	it('answers an empty list where nothing is loaded', async () => {
		const res = await viewer.call('GET', url('28,-26.5,28.5,-26'));
		expect(res.status).toBe(200);
		expect(res.body.quaternaries).toEqual([]);
	});

	it('refuses a malformed, inverted, out-of-range or oversized bbox, and a missing one', async () => {
		for (const bbox of ['21,-33', '21,-33,a,-32', '21.5,-33.7,21.4,-33.6', '21,-91,22,-33', `21,-34,${21 + QUATERNARY_BBOX_MAX_DEG + 0.1},-33`]) {
			const res = await viewer.call('GET', url(bbox));
			expect(res.status, bbox).toBe(400);
			expect(JSON.stringify(res.body)).not.toMatch(/quaternary_reference|SELECT/);
		}
		expect((await viewer.call('GET', `/projects/${projectId}/map/quaternaries`)).status).toBe(400);
	});

	it('is closed to a non-member (404) and to a farmer (403); the owner reads it (control)', async () => {
		expect((await stranger.call('GET', url('21.3,-33.7,21.4,-33.6'))).status).toBe(404);
		expect((await farmer.call('GET', url('21.3,-33.7,21.4,-33.6'))).status).toBe(403);
		const mine = await owner.call('GET', url('21.3,-33.7,21.4,-33.6'));
		expect(mine.status).toBe(200);
		expect(mine.body.quaternaries).toHaveLength(1);
	});
});
