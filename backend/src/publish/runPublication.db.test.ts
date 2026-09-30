// One run's place in its project's publications (issue #70): the report's
// published-by line and notice, and the changes since the publication before.
// Every refusal has its positive control (a viewer reads it).
import { beforeAll, describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
const outlet = node('Weir', null);
const farm = node('Upper farm', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };

const run = async (label: string) => {
	const res = await owner.call('POST', `/projects/${projectId}/runs`, { label });
	expect(res.status).toBe(201);
	return res.body.run.id as string;
};
const publish = async (runId: string, restriction?: unknown) => {
	const res = await owner.call('POST', `/projects/${projectId}/publication`, { runId, ...(restriction ? { restriction } : {}) });
	expect(res.status).toBe(201);
	return res.body.publication.id as string;
};
const context = (u: User, runId: string) => u.call('GET', `/projects/${projectId}/runs/${runId}/publication`);

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['RPowner', 'RPviewer', 'RPfarmer', 'RPstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Run publication' })).body.project.id as string;
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 100_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
	const rain = Array.from({ length: 120 }, (_, i) => (i % 9 === 0 ? 25 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2022-10-01', values: rain })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
}, 60_000);

describe('GET /projects/:id/runs/:runId/publication', () => {
	it('before anything is published, says so and has nothing to compare with', async () => {
		const first = await run('First');
		const res = await context(viewer, first);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ publication: null, previous: null });
	});

	it('gives a published run its notice, and the changes since the publication before it, with who made them', async () => {
		const first = await run('Baseline');
		await publish(first);
		// A saved change, then a second run published with a notice.
		const changed = { nodes: [outlet, { ...farm, damCapacityM3: farm.damCapacityM3 + 50_000 }], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 100_000 }], transfers: [] };
		expect((await owner.call('PUT', `/projects/${projectId}/model`, changed)).status).toBe(200);
		const second = await run('Bigger dam');
		await publish(second, { level: 'restricted', pct: 20, notice: { en: 'Irrigate at night.' } });

		const res = await context(viewer, second);
		expect(res.status).toBe(200);
		expect(res.body.publication).toMatchObject({ publishedBy: 'RPowner', supersededAt: null, restriction: { level: 'restricted', pct: 20, notice: { en: 'Irrigate at night.' } } });
		const prev = res.body.previous;
		expect(prev).toMatchObject({ runId: first, runLabel: 'Baseline', publishedBy: 'RPowner' });
		expect(prev.changes.map((c: { area: string; text?: string }) => c.area)).toContain('network');
		// The one saved change, attributed to the revision that made it.
		expect(prev.attribution.revisions).toHaveLength(1);
		expect(prev.attribution.revisions[0].actor).toBe('RPowner');
		expect(prev.attribution.changedBy.some((id: string | null) => id === prev.attribution.revisions[0].id)).toBe(true);

		// The superseded run keeps its own publication, now superseded; nothing before it.
		const old = await context(viewer, first);
		expect(old.body.publication.supersededAt).not.toBeNull();
		expect(old.body.previous).toBeNull();
	});

	it('compares a run never published with what stakeholders see now', async () => {
		const scratch = await run('Scratch');
		const res = await context(viewer, scratch);
		expect(res.body.publication).toBeNull();
		expect(res.body.previous).toMatchObject({ runLabel: 'Bigger dam' });
		expect(res.body.previous.changes).toEqual([]);
	});

	it('refuses a farmer (403) and a stranger (404), and a run of no project (404)', async () => {
		const runId = await run('Access');
		expect((await context(viewer, runId)).status).toBe(200); // positive control
		expect((await context(farmer, runId)).status).toBe(403);
		expect((await context(stranger, runId)).status).toBe(404);
		expect((await context(viewer, crypto.randomUUID())).status).toBe(404);
		expect((await context(viewer, 'not-a-uuid')).status).toBe(404);
	});
});
