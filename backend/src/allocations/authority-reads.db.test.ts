// The members acting for the responsible authority always read each
// registered volume, how it is held and who holds it, whatever the project's
// viewer settings (issue #523 G6; 231_authority_reads_allocations.sql,
// docs/allocations.md § Who sees what). One place decides who reads what:
// app_user_reads_allocation_units / _holders, whose first line is the
// authority's clause; the policies, the History, a report's with_volumes, who
// its link goes to and the API all read it.
//  - the authority's member reads every row, its authorisation and its
//    holder's name, through the API and past it, with the switch off;
//  - a viewer is still kept from them (negative), and reads each row (never a
//    name) once an owner switches it on (positive control);
//  - the guards: the policies and functions call the one rule, its first line
//    is the authority's, and nothing else reads the viewers' switch.
import { readdirSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { actForAuthority, app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { membersAmong } from '../reports/store.js';
import { allocationUnitsHidden } from './viewerUnits.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let assessor: User; // a direct editor the authority confirmed (229)
let editor: User; // a plain editor: the control that the authority's clause isn't the only way in
let viewer: User;
let projectId: string;
let runId: string;

const P = () => `/projects/${projectId}`;
const outlet = node('Weir', null);
const farms = ['G6 Farm A', 'G6 Farm B', 'G6 Farm C', 'G6 Farm D', 'G6 Farm E'].map((name) => node(name, outlet.id));
// How each is held: every authorisation D3's review names (licence, verified ELU, unverified registration, GA, Schedule 1).
const HELD = [
	{ authorisation: 'licence', holder: 'G6 Holder Licence', volumeM3PerYear: 41_111 },
	{ authorisation: 'existing_lawful_use', holder: 'G6 Holder Verified', volumeM3PerYear: 42_222 },
	{ authorisation: 'registration', holder: 'G6 Holder Registered', volumeM3PerYear: 43_333 },
	{ authorisation: 'general_authorisation', holder: 'G6 Holder General', volumeM3PerYear: 44_444 },
	{ authorisation: 'schedule_1', holder: 'G6 Holder Schedule', volumeM3PerYear: 45_555 }
] as const;

const rowsAs = async (u: User, sql: string, params: unknown[] = []) => withUser(u.id, async (db) => (await db.query(sql, params)).rows);
const csvAs = async (u: User) => {
	const r = await app.request(`${P()}/allocations/export.csv`, { headers: { cookie: u.cookie, origin: 'http://localhost:7777' } });
	return { status: r.status, text: await r.text() };
};
const setSwitch = async (on: boolean) => expect((await owner.call('PUT', `${P()}/allocations/viewer-units`, { on })).status).toBe(200);

beforeAll(async () => {
	[owner, assessor, editor, viewer] = (await Promise.all(['G6owner', 'G6assessor', 'G6editor', 'G6viewer'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Authority reads' })).body.project.id;
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = { nodes: [outlet, ...farms], crops: [crop], cropAreas: farms.map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 50_000 })), transfers: [] };
	expect((await owner.call('PUT', `${P()}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(180) } })).status).toBe(200);
	const rain = Array.from({ length: 120 }, (_, i) => (i % 8 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	for (const [u, role] of [
		[assessor, 'editor'],
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status).toBe(201);
	await actForAuthority(owner, projectId, assessor.id);
	for (const [i, h] of HELD.entries()) {
		const res = await owner.call('POST', `${P()}/allocations`, {
			nodeId: farms[i]!.id,
			registrationNo: `G6-${i + 1}`,
			waterSource: 'surface',
			validFrom: '2000-01-01',
			...h
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
	}
	const run = await owner.call('POST', `${P()}/runs`, { label: 'With the volumes' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	runId = run.body.run.id;
	// The default, said out loud: viewers are kept from each volume.
	await setSwitch(false);
}, 60_000);

describe('a member acting for the authority reads every volume, how it is held and the name (#523 G6)', () => {
	it('is one: a confirmed delegate', async () => {
		expect((await assessor.call('GET', P())).body.project.actsForAuthority).toBe(true);
		expect((await editor.call('GET', P())).body.project.actsForAuthority).toBe(false);
	});

	it('GET …/allocations: every row with its authorisation, volume and holder, with the viewers’ switch off', async () => {
		const res = await assessor.call('GET', `${P()}/allocations`);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ viewerUnits: false, unitsHidden: false, canSeeHolders: true, totals: null });
		const got = (res.body.allocations as { authorisation: string; holder: string | null; volumeM3PerYear: number }[])
			.map(({ authorisation, holder, volumeM3PerYear }) => ({ authorisation, holder, volumeM3PerYear }))
			.sort((a, b) => a.volumeM3PerYear - b.volumeM3PerYear);
		expect(got).toEqual(HELD.map((h) => ({ ...h })));
	});

	it('past the API: RLS gives the rows and the names, and the one rule answers yes', async () => {
		expect(await rowsAs(assessor, 'SELECT app_reads_allocation_units($1) AS units, app_reads_allocation_holders($1) AS holders', [projectId])).toEqual([
			{ units: true, holders: true }
		]);
		expect(await rowsAs(assessor, 'SELECT count(*)::int AS n FROM allocation WHERE project_id = $1', [projectId])).toEqual([{ n: HELD.length }]);
		const names = (await rowsAs(assessor, 'SELECT user_display FROM allocation_holder WHERE project_id = $1 ORDER BY user_display', [projectId])).map((r) => r.user_display);
		expect(names).toEqual(HELD.map((h) => h.holder).sort());
		expect(await withUser(assessor.id, (db) => allocationUnitsHidden(db, projectId, 'editor'))).toBe(false);
	});

	it('the run’s copy of the volumes, the export’s holder column and the History’s registration numbers', async () => {
		const own = (await owner.call('GET', `${P()}/runs/${runId}`)).body.run;
		const theirs = (await assessor.call('GET', `${P()}/runs/${runId}`)).body.run;
		expect(own.model.allocations.length).toBeGreaterThan(0);
		expect(theirs.model.allocations).toEqual(own.model.allocations);
		const csv = await csvAs(assessor);
		expect(csv.status).toBe(200);
		const text = csv.text;
		expect(text.split('\n')[0]).toContain('holder');
		for (const h of HELD) expect(text).toContain(h.holder);
		const created = (await rowsAs(assessor, `SELECT app_audit_subject(project_id, kind, subject) AS s FROM audit_event WHERE project_id = $1 AND kind = 'allocation.created'`, [projectId])).map(
			(r) => r.s as Record<string, unknown>
		);
		expect(created.length).toBe(HELD.length);
		for (const s of created) expect(s.registrationNo).toMatch(/^G6-/);
	});

	it('a report printed with the volumes is emailed to them; the viewer only once the switch is on (positive control)', async () => {
		const to = (u: User) => withUser(owner.id, (db) => membersAmong(db, projectId, [assessor.id, editor.id, viewer.id], { withVolumes: true })).then((r) => r.map((m) => m.id).includes(u.id));
		expect(await to(assessor)).toBe(true);
		expect(await to(editor)).toBe(true);
		expect(await to(viewer)).toBe(false);
		await setSwitch(true);
		try {
			expect(await to(viewer)).toBe(true);
		} finally {
			await setSwitch(false);
		}
	});
});

describe('a viewer is still kept from them (the negative, with its positive control)', () => {
	it('switch off: no row, no name, totals instead, and the one rule answers no', async () => {
		const res = await viewer.call('GET', `${P()}/allocations`);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ allocations: [], unitsHidden: true, canSeeHolders: false });
		expect(await rowsAs(viewer, 'SELECT app_reads_allocation_units($1) AS units, app_reads_allocation_holders($1) AS holders', [projectId])).toEqual([
			{ units: false, holders: false }
		]);
		expect(await rowsAs(viewer, 'SELECT count(*)::int AS n FROM allocation WHERE project_id = $1', [projectId])).toEqual([{ n: 0 }]);
		expect(await rowsAs(viewer, 'SELECT count(*)::int AS n FROM allocation_holder WHERE project_id = $1', [projectId])).toEqual([{ n: 0 }]);
		expect(await withUser(viewer.id, (db) => allocationUnitsHidden(db, projectId, 'viewer'))).toBe(true);
		expect((await viewer.call('GET', `${P()}/runs/${runId}`)).body.run.model.allocations).toEqual([]);
		expect((await csvAs(viewer)).status).toBe(403);
		const subjects = (await rowsAs(viewer, `SELECT app_audit_subject(project_id, kind, subject) AS s FROM audit_event WHERE project_id = $1 AND kind = 'allocation.created'`, [projectId])).map(
			(r) => r.s as Record<string, unknown>
		);
		expect(subjects.length).toBe(HELD.length);
		for (const s of subjects) expect(s).not.toHaveProperty('registrationNo');
	});

	it('switch on: each row and how it is held, never a name (positive control for the rows; names stay the authority’s and editors’)', async () => {
		await setSwitch(true);
		try {
			const res = await viewer.call('GET', `${P()}/allocations`);
			expect(res.body).toMatchObject({ unitsHidden: false, canSeeHolders: false });
			expect((res.body.allocations as { authorisation: string }[]).map((a) => a.authorisation).sort()).toEqual(HELD.map((h) => h.authorisation).sort());
			for (const a of res.body.allocations as { holder: string | null }[]) expect(a.holder).toBeNull();
			expect(await rowsAs(viewer, 'SELECT count(*)::int AS n FROM allocation_holder WHERE project_id = $1', [projectId])).toEqual([{ n: 0 }]);
		} finally {
			await setSwitch(false);
		}
	});

	it('the authority’s member keeps reading through every switch position', async () => {
		for (const on of [true, false]) {
			await setSwitch(on);
			const res = await assessor.call('GET', `${P()}/allocations`);
			expect(res.body).toMatchObject({ unitsHidden: false, canSeeHolders: true });
			expect((res.body.allocations as { holder: string | null }[]).every((a) => a.holder !== null)).toBe(true);
		}
	});
});

describe('one place decides (the guards)', () => {
	const def = async (name: string) => ((await asOwner(`SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p WHERE p.proname = $1`, [name])) as { d: string }[]).map((r) => r.d);

	it('the policies read the one rule', async () => {
		const policies = (await asOwner(
			`SELECT tablename, policyname, qual FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('allocation', 'allocation_holder') AND cmd = 'SELECT' ORDER BY policyname`
		)) as { tablename: string; policyname: string; qual: string }[];
		const by = Object.fromEntries(policies.map((p) => [p.policyname, p.qual]));
		expect(by.allocation_select).toMatch(/^app_reads_allocation_units\(project_id\)$/);
		expect(by.allocation_holder_select).toContain('app_reads_allocation_holders(project_id)');
		// The farmer's own farm is the other permissive policy, untouched.
		expect(by.allocation_select_farmer).toContain('app_farm_nodes');
		expect(Object.keys(by).sort()).toEqual(['allocation_holder_select', 'allocation_select', 'allocation_select_farmer']);
	});

	it('its first line is the authority’s, in both functions, and both stay closed to the app', async () => {
		for (const name of ['app_user_reads_allocation_units', 'app_user_reads_allocation_holders']) {
			const [d] = await def(name);
			expect(d, name).toBeDefined();
			const auth = d!.indexOf('app_authority_member(p_project, p_user)');
			expect(auth, name).toBeGreaterThan(0);
			// Nothing but the null check comes before it: no role, no switch.
			for (const later of ['app_member_role', 'app_allocations_viewer_units', 'app_has_role']) {
				const at = d!.indexOf(later);
				if (at >= 0) expect(at, `${name}: ${later} before the authority's clause`).toBeGreaterThan(auth);
			}
			expect(d!.slice(auth - 40, auth)).toMatch(/IF\s+$/);
			const [g] = (await asOwner(`SELECT has_function_privilege('water_app', $1, 'EXECUTE') AS g`, [`${name}(uuid, uuid)`])) as { g: boolean }[];
			expect(g!.g, name).toBe(false);
		}
	});

	it('nothing else in the database reads the viewers’ switch or decides by role on allocations (the History and report_enqueue read the rule)', async () => {
		const readers = ((await asOwner(
			`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			 WHERE n.nspname = 'public' AND p.prosrc LIKE '%app_allocations_viewer_units%' ORDER BY 1`
		)) as { proname: string }[]).map((r) => r.proname);
		expect(readers).toEqual(['app_user_reads_allocation_units']);
		const policies = (await asOwner(`SELECT policyname FROM pg_policies WHERE qual LIKE '%app_allocations_viewer_units%' OR with_check LIKE '%app_allocations_viewer_units%'`)) as unknown[];
		expect(policies).toEqual([]);
		for (const name of ['app_audit_subject', 'report_enqueue']) {
			const [d] = await def(name);
			expect(d, name).toContain('app_reads_allocation_units(');
		}
	});

	it('nor does the API: no backend module reads the switch to decide, or ranks a role for holder names', () => {
		const root = new URL('../', import.meta.url);
		const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('__tests__'));
		const switchReaders: string[] = [];
		for (const f of files) {
			const src = readFileSync(new URL(f, root), 'utf8');
			if (src.includes('app_allocations_viewer_units(')) switchReaders.push(f.replaceAll('\\', '/'));
		}
		// The Allocations route reports the switch's position (viewerUnits) to the owner's toggle; it decides nothing with it.
		expect(switchReaders).toEqual(['allocations/routes.ts']);
		const route = readFileSync(new URL('allocations/routes.ts', root), 'utf8');
		expect(route).not.toMatch(/canSeeHolders:\s*rank/);
		expect(route).not.toMatch(/withNames\s*=\s*rank/);
	});
});
