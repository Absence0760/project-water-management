// Licence data never drives the baseline (issue #507, docs/allocations.md §
// Allocation modes): a project's own settings compare registered volumes
// only. A save that caps or fully allocates the baseline is refused
// (allocations/conditions.db.test.ts); settings arriving any other way (a
// project file, a copy of a project stored before 213, a restore of an older
// revision or an older run's inputs) come in comparing only, and the
// revision that records them says so. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';
const NOTE = /^Allocation mode “Cap use at the registered volume” set to compare only: licence data never drives the baseline/;

let owner: User;

beforeAll(async () => {
	owner = await signUp('Basemode');
});

const outlet = node('Outlet gauge', null);
const farm = node('Farm A', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 40_000 }], transfers: [] };

async function importDoc(settings: Record<string, unknown>): Promise<string> {
	const res = await app.request('/projects/import', {
		method: 'POST',
		headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: owner.cookie },
		body: JSON.stringify({ name: `Imported ${crypto.randomUUID().slice(0, 8)}`, settings, model, series: [] })
	});
	const body = (await res.json()) as { project: { id: string } };
	expect(res.status, JSON.stringify(body)).toBe(201);
	return body.project.id;
}

const storedMode = async (id: string) => ((await asOwner('SELECT settings FROM project WHERE id = $1', [id]))[0]!.settings as Record<string, unknown>).allocationMode;
const revisions = async (id: string) =>
	(await owner.call('GET', `/projects/${id}/history?kind=revision`)).body.items as { id: string; source: string; reason: string | null }[];

describe('a baseline allocation mode from outside a save becomes compare only (issue #507)', () => {
	it('a project file that caps the baseline imports comparing only, and the import’s revision says so', async () => {
		const id = await importDoc({ apanMm: monthly(150), allocationMode: 'cap', allocationTolerance: 0.2 });
		expect(await storedMode(id)).toBe('none');
		// The rest of the settings stay as the file gave them.
		expect((await owner.call('GET', `/projects/${id}`)).body.project.settings.allocationTolerance).toBe(0.2);
		const [rev] = await revisions(id);
		expect(rev!.source).toBe('import');
		expect(rev!.reason).toMatch(NOTE);
	});

	it('a file that compares only, or says nothing, imports as it was with no note (positive control)', async () => {
		for (const settings of [{ allocationMode: 'none' }, {}]) {
			const id = await importDoc({ apanMm: monthly(150), ...settings });
			expect(await storedMode(id)).toBe(settings.allocationMode);
			expect((await revisions(id))[0]!.reason).toBeNull();
		}
	});

	it('a copy of a project stored with a cap compares only, and its revision says so', async () => {
		const id = await importDoc({ apanMm: monthly(150) });
		// As a project stored before 213 would be.
		await asOwner(`UPDATE project SET settings = settings || '{"allocationMode": "fullAllocation"}' WHERE id = $1`, [id]);
		const copy = await owner.call('POST', `/projects/${id}/copy`, { name: 'The copy' });
		expect(copy.status, JSON.stringify(copy.body)).toBe(201);
		expect(await storedMode(copy.body.project.id)).toBe('none');
		const [rev] = await revisions(copy.body.project.id);
		expect(rev!.source).toBe('copy');
		expect(rev!.reason).toMatch(/^Copied from "Imported [^"]+"\. Allocation mode “Full allocation: every user takes their registered volume” set to compare only/);
	});

	it('restoring a revision that capped the baseline restores it comparing only, and the restore’s reason says so', async () => {
		const id = await importDoc({ apanMm: monthly(150) });
		expect((await owner.call('PATCH', `/projects/${id}`, { settings: { allocationTolerance: 0.3 } })).status).toBe(200);
		const [target] = await revisions(id);
		// A revision recorded before 213, when the baseline could cap.
		await asOwner(`UPDATE model_revision SET snapshot = jsonb_set(snapshot, '{settings,allocationMode}', '"cap"') WHERE id = $1`, [target!.id]);
		expect((await owner.call('PATCH', `/projects/${id}`, { settings: { allocationTolerance: 0.4 } })).status).toBe(200);
		const res = await owner.call('POST', `/projects/${id}/history/revisions/${target!.id}/restore`, { reason: 'Back to the 30 % band' });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const project = (await owner.call('GET', `/projects/${id}`)).body.project;
		expect([project.settings.allocationMode, project.settings.allocationTolerance]).toEqual(['none', 0.3]);
		expect(res.body.revision.reason).toMatch(/^Back to the 30 % band\. Allocation mode “Cap use at the registered volume” set to compare only/);
	});
});
