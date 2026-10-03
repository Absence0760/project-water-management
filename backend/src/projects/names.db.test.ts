// Team and project names are cleaned and refused as display names are
// (http/visibleName.ts, issue #383): whitespace runs made one space, control
// and bidi embedding/override/isolate characters dropped, and a name that
// would show as nothing refused, on every route that writes one.
import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';

/** Shows as "Bergadmin" in a member list or invite: the override reverses what follows it. */
const SPOOF = 'Berg‮nimda';
const INVISIBLE = ['​', '‮⁦⁩', '⁠﻿', '  \n '];

function doc(name: string) {
	const outlet = node('Outlet gauge', null);
	return { name, description: '', settings: { apanMm: monthly(150) }, model: { nodes: [outlet], crops: [], cropAreas: [], transfers: [] }, series: [] };
}

describe('team names', () => {
	it('stores a cleaned name on create and rename, and refuses one that shows as nothing (positive control: a plain one saves)', async () => {
		const admin = await signUp('NamesTeamAdmin');
		const created = await admin.call('POST', '/teams', { name: `  ${SPOOF}\n Consultants ` });
		expect(created.status).toBe(201);
		expect(created.body.team.name).toBe('Bergnimda Consultants');
		const id = created.body.team.id as string;

		for (const name of INVISIBLE) {
			expect((await admin.call('POST', '/teams', { name })).status, JSON.stringify(name)).toBe(400);
			expect((await admin.call('PATCH', `/teams/${id}`, { name })).status, JSON.stringify(name)).toBe(400);
		}
		expect((await admin.call('GET', `/teams/${id}`)).body.team.name).toBe('Bergnimda Consultants');

		const renamed = await admin.call('PATCH', `/teams/${id}`, { name: '⁦Upper Berg⁩' });
		expect(renamed.status).toBe(200);
		expect(renamed.body.team.name).toBe('Upper Berg');
	});
});

describe('project names', () => {
	it('stores a cleaned name on create, rename and copy, and refuses one that shows as nothing (positive control: a plain one saves)', async () => {
		const owner = await signUp('NamesProjectOwner');
		const created = await owner.call('POST', '/projects', { name: SPOOF });
		expect(created.status).toBe(201);
		expect(created.body.project.name).toBe('Bergnimda');
		const id = created.body.project.id as string;

		for (const name of INVISIBLE) {
			expect((await owner.call('POST', '/projects', { name })).status, JSON.stringify(name)).toBe(400);
			expect((await owner.call('PATCH', `/projects/${id}`, { name })).status, JSON.stringify(name)).toBe(400);
			expect((await owner.call('POST', `/projects/${id}/copy`, { name })).status, JSON.stringify(name)).toBe(400);
		}
		expect((await owner.call('GET', `/projects/${id}`)).body.project.name).toBe('Bergnimda');

		const renamed = await owner.call('PATCH', `/projects/${id}`, { name: 'Upper\tBerg‪' });
		expect(renamed.status).toBe(200);
		expect(renamed.body.project.name).toBe('Upper Berg');

		const copy = await owner.call('POST', `/projects/${id}/copy`, { name: '⁦Upper Berg⁩ (copy)' });
		expect(copy.status).toBe(201);
		expect(copy.body.project.name).toBe('Upper Berg (copy)');
	});

	it('cleans and checks an imported project document’s name the same way', async () => {
		const owner = await signUp('NamesImportOwner');
		const ok = await owner.call('POST', '/projects/import', doc(`${SPOOF} import`));
		expect(ok.status).toBe(201);
		expect(ok.body.project.name).toBe('Bergnimda import');
		for (const name of INVISIBLE) {
			expect((await owner.call('POST', '/projects/import', doc(name))).status, JSON.stringify(name)).toBe(400);
		}
		const names = (await owner.call('GET', '/projects')).body.projects.map((p: { name: string }) => p.name);
		expect(names).toEqual(['Bergnimda import']);
	});
});
