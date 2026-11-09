// A copied project takes its registered volumes with it (POST /projects/:id/copy,
// copyAllocations.ts): the rows and their import file under new ids, each
// matched to the copy's node, the registered users' names the copier could
// read, and the owners' viewer-units choice (162). The original is unchanged,
// a stranger reads neither, and who sees what doesn't widen: a viewer of the
// original (who reads each volume, the owners having allowed it, but no name)
// copies the volumes without the names.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Allocation = { id: string; nodeId: string | null; nodeName: string | null; sourceId: string | null; registrationNo: string; holder: string | null; volumeM3PerYear: number; waterSource: string };
type Listing = { allocations: Allocation[]; sources: { id: string; fileName: string; sha256: string }[]; canSeeHolders: boolean; viewerUnits: boolean; unitsHidden: boolean };

const FIXTURE = readFileSync(new URL('../allocations/fixtures/warms-synthetic.csv', import.meta.url), 'utf8');

async function projectWithAllocations(owner: User) {
	const outlet = node('Weir', null);
	const farms = ['Farm A', 'Farm B', 'Farm C', 'Farm D', 'Farm E'].map((name) => node(name, outlet.id));
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const projectId = (await owner.call('POST', '/projects', { name: 'Registered' })).body.project.id as string;
	const model = { nodes: [outlet, ...farms], crops: [crop], cropAreas: farms.map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 60_000 })), transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	const commit = await owner.call('POST', `/projects/${projectId}/allocations/import/commit`, {
		kind: 'warms_extract',
		fileName: 'warms-synthetic.csv',
		text: FIXTURE,
		reference: 'Synthetic extract, test letter'
	});
	expect(commit.status, JSON.stringify(commit.body)).toBe(201);
	// A row typed into the app, with its holder.
	const typed = await owner.call('POST', `/projects/${projectId}/allocations`, {
		nodeId: farms[1]!.id,
		registrationNo: 'SYN-TYPED',
		holder: 'Invented Typed Holder',
		authorisation: 'licence',
		waterSource: 'surface',
		volumeM3PerYear: 42_000
	});
	expect(typed.status, JSON.stringify(typed.body)).toBe(201);
	expect((await owner.call('PUT', `/projects/${projectId}/allocations/viewer-units`, { on: true })).status).toBe(200);
	return { projectId, farms };
}

const listing = async (u: User, projectId: string) => {
	const res = await u.call('GET', `/projects/${projectId}/allocations`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body as Listing;
};
/** Each row by what it says, ids aside: registration, unit, holder, volume. */
const shape = (l: Listing) => l.allocations.map((a) => `${a.registrationNo}|${a.nodeName}|${a.holder}|${a.waterSource}|${a.volumeM3PerYear}|${a.sourceId ? 'file' : 'typed'}`).sort();

describe('copying a project copies its registered volumes', () => {
	it('copies rows, their file and the names with new ids, matched to the copy’s nodes, and leaves the original alone', async () => {
		const owner = await signUp('CopyAllocOwner');
		const stranger = await signUp('CopyAllocStranger');
		const { projectId, farms } = await projectWithAllocations(owner);
		const before = await listing(owner, projectId);
		expect(before.allocations.length).toBeGreaterThan(5);
		expect(before.allocations.some((a) => a.holder)).toBe(true);

		const copy = await owner.call('POST', `/projects/${projectId}/copy`, { name: 'Registered copy' });
		expect(copy.status, JSON.stringify(copy.body)).toBe(201);
		const copyId = copy.body.project.id as string;
		const dup = await listing(owner, copyId);
		const dupNodes = (await owner.call('GET', `/projects/${copyId}/model`)).body.nodes as { id: string; name: string }[];

		// The same rows, names included (the owner reads them in both), under new ids.
		expect(shape(dup)).toEqual(shape(before));
		expect(dup.canSeeHolders).toBe(true);
		const oldIds = new Set(before.allocations.map((a) => a.id));
		expect(dup.allocations.some((a) => oldIds.has(a.id))).toBe(false);
		// Matched to the copy's nodes, never the original's.
		const farmIds = new Set<string>(farms.map((f) => f.id));
		for (const a of dup.allocations.filter((x) => x.nodeId)) {
			expect(farmIds.has(a.nodeId!)).toBe(false);
			expect(dupNodes.find((n) => n.id === a.nodeId)?.name).toBe(a.nodeName);
		}
		// The file, under a new id, with its hash.
		expect(dup.sources).toHaveLength(1);
		expect(dup.sources[0]).toMatchObject({ fileName: 'warms-synthetic.csv', sha256: before.sources[0]!.sha256 });
		expect(dup.sources[0]!.id).not.toBe(before.sources[0]!.id);
		for (const a of dup.allocations.filter((x) => x.sourceId)) expect(a.sourceId).toBe(dup.sources[0]!.id);
		// The owners' choice to let viewers read each volume came across.
		expect(dup.viewerUnits).toBe(true);

		// The original is untouched.
		const after = await listing(owner, projectId);
		expect(after.allocations.map((a) => a.id).sort()).toEqual(before.allocations.map((a) => a.id).sort());
		expect(shape(after)).toEqual(shape(before));

		// A stranger reads neither project's volumes (the owner reading both above is the positive control).
		expect((await stranger.call('GET', `/projects/${copyId}/allocations`)).status).toBe(404);
		expect((await stranger.call('GET', `/projects/${projectId}/allocations`)).status).toBe(404);
	});

	it('gives a viewer’s copy the volumes they read in the original, without the names they couldn’t', async () => {
		const owner = await signUp('CopyAllocOwner2');
		const viewer = await signUp('CopyAllocViewer');
		const { projectId } = await projectWithAllocations(owner);
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		const seen = await listing(viewer, projectId);
		// Positive control: the viewer reads each volume (the owner allowed it), but no name.
		expect(seen.allocations.length).toBe((await listing(owner, projectId)).allocations.length);
		expect(seen.canSeeHolders).toBe(false);
		expect(seen.allocations.every((a) => a.holder === null)).toBe(true);

		const copy = await viewer.call('POST', `/projects/${projectId}/copy`, { name: 'Viewer’s registered copy' });
		expect(copy.status, JSON.stringify(copy.body)).toBe(201);
		const copyId = copy.body.project.id as string;
		const dup = await listing(viewer, copyId);
		expect(dup.allocations).toHaveLength(seen.allocations.length);
		expect(dup.canSeeHolders).toBe(true);
		expect(dup.allocations.every((a) => a.holder === null)).toBe(true);
		const names = await withUser(viewer.id, async (db) => (await db.query('SELECT 1 FROM allocation_holder WHERE project_id = $1', [copyId])).rows);
		expect(names).toHaveLength(0);
		// The original's owner isn't a member of the viewer's copy.
		expect((await owner.call('GET', `/projects/${copyId}/allocations`)).status).toBe(404);
	});
});
