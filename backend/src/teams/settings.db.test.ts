// A team's portfolio thresholds (055_team_settings; WP-2.14, D11): only a team
// admin changes them (API and RLS, each with a positive control), the API and
// the database both validate them, and each change is an audit event on every
// team project.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let admin: User;
let member: User;
let viewer: User;
let stranger: User;
let teamId: string;
let teamProjects: string[];
let personal: string;

const thresholds = (t: { green: number; amber: number } | null) => ({ settings: { portfolio: { thresholds: t } } });
const events = (projectId: string) =>
	asOwner(`SELECT kind, actor_label, subject FROM audit_event WHERE project_id = $1 AND kind = 'team_thresholds.changed' ORDER BY id`, [projectId]);

beforeAll(async () => {
	[admin, member, viewer, stranger] = (await Promise.all(['TsAdmin', 'TsMember', 'TsViewer', 'TsStranger'].map((n) => signUp(n)))) as [User, User, User, User];
	teamId = (await admin.call('POST', '/teams', { name: 'Threshold WUA' })).body.team.id;
	expect((await admin.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' })).status).toBe(201);
	expect((await admin.call('POST', `/teams/${teamId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	teamProjects = [];
	for (const name of ['Ts one', 'Ts two']) teamProjects.push((await admin.call('POST', '/projects', { name, teamId })).body.project.id);
	personal = (await admin.call('POST', '/projects', { name: 'Ts personal' })).body.project.id;
});

describe('PATCH /teams/:id settings', () => {
	it('a new team uses the defaults, and every member reads which apply', async () => {
		for (const u of [admin, member, viewer]) {
			const r = await u.call('GET', `/teams/${teamId}`);
			expect(r.status).toBe(200);
			expect(r.body.team.settings).toEqual({});
			expect(r.body.team.portfolioThresholds).toEqual({ green: 5, amber: 20, source: 'default' });
		}
		const list = (await viewer.call('GET', '/teams')).body.teams;
		expect(list.find((t: { id: string }) => t.id === teamId).portfolioThresholds).toEqual({ green: 5, amber: 20, source: 'default' });
	});

	it('only a team admin changes them: a member and a viewer get 403, a stranger 404', async () => {
		expect((await member.call('PATCH', `/teams/${teamId}`, thresholds({ green: 10, amber: 30 }))).status).toBe(403);
		expect((await viewer.call('PATCH', `/teams/${teamId}`, thresholds({ green: 10, amber: 30 }))).status).toBe(403);
		expect((await stranger.call('PATCH', `/teams/${teamId}`, thresholds({ green: 10, amber: 30 }))).status).toBe(404);
		expect((await viewer.call('GET', `/teams/${teamId}`)).body.team.portfolioThresholds.source).toBe('default');
		// Positive control: the admin can.
		const r = await admin.call('PATCH', `/teams/${teamId}`, thresholds({ green: 10, amber: 30 }));
		expect(r.status).toBe(200);
		expect(r.body.team.settings).toEqual({ portfolio: { thresholds: { green: 10, amber: 30 } } });
		expect(r.body.team.portfolioThresholds).toEqual({ green: 10, amber: 30, source: 'team' });
		expect(r.body.team.name).toBe('Threshold WUA');
		expect((await viewer.call('GET', `/teams/${teamId}`)).body.team.portfolioThresholds).toEqual({ green: 10, amber: 30, source: 'team' });
	});

	it('records the change on every team project, never on a project outside the team', async () => {
		for (const pid of teamProjects) {
			const rows = await events(pid);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				actor_label: 'TsAdmin',
				subject: { teamId, team: 'Threshold WUA', from: { green: 5, amber: 20, source: 'default' }, to: { green: 10, amber: 30, source: 'team' } }
			});
		}
		expect(await events(personal)).toEqual([]);
		// The project's history shows it to a viewer (the History tab's source).
		const history = await viewer.call('GET', `/projects/${teamProjects[0]}/history`);
		expect(history.status).toBe(200);
		expect(JSON.stringify(history.body)).toContain('team_thresholds.changed');
	});

	it('a save that changes nothing records nothing; going back to the defaults does', async () => {
		expect((await admin.call('PATCH', `/teams/${teamId}`, thresholds({ green: 10, amber: 30 }))).status).toBe(200);
		expect(await events(teamProjects[0]!)).toHaveLength(1);
		const reset = await admin.call('PATCH', `/teams/${teamId}`, thresholds(null));
		expect(reset.status).toBe(200);
		expect(reset.body.team.settings).toEqual({});
		expect(reset.body.team.portfolioThresholds).toEqual({ green: 5, amber: 20, source: 'default' });
		const rows = await events(teamProjects[0]!);
		expect(rows).toHaveLength(2);
		expect(rows[1].subject).toMatchObject({ from: { green: 10, amber: 30, source: 'team' }, to: { green: 5, amber: 20, source: 'default' } });
		// Resetting again is a no-op.
		expect((await admin.call('PATCH', `/teams/${teamId}`, thresholds(null))).status).toBe(200);
		expect(await events(teamProjects[0]!)).toHaveLength(2);
	});

	it('rejects invalid thresholds and bodies with 400, and changes nothing', async () => {
		for (const body of [
			thresholds({ green: 20, amber: 20 }),
			thresholds({ green: 30, amber: 10 }),
			thresholds({ green: -1, amber: 10 }),
			thresholds({ green: 5, amber: 101 }),
			{ settings: { portfolio: { thresholds: { green: 5 } } } },
			{ settings: { portfolio: { thresholds: { green: 5, amber: 20, red: 40 } } } },
			{ settings: { portfolio: { thresholds: { green: '5', amber: 20 } } } },
			{ settings: { colour: 'blue' } },
			{ settings: {} },
			{},
			{ name: 'x', extra: 1 }
		]) {
			const r = await admin.call('PATCH', `/teams/${teamId}`, body);
			expect(r.status, JSON.stringify(body)).toBe(400);
		}
		expect((await admin.call('GET', `/teams/${teamId}`)).body.team.settings).toEqual({});
		expect(await events(teamProjects[0]!)).toHaveLength(2);
	});

	it('renames and sets thresholds in one request, and a rename alone still works', async () => {
		const r = await admin.call('PATCH', `/teams/${teamId}`, { name: 'Threshold WUA 2', ...thresholds({ green: 2.5, amber: 12.5 }) });
		expect(r.status).toBe(200);
		expect(r.body.team).toMatchObject({ name: 'Threshold WUA 2', portfolioThresholds: { green: 2.5, amber: 12.5, source: 'team' } });
		const renamed = await admin.call('PATCH', `/teams/${teamId}`, { name: 'Threshold WUA' });
		expect(renamed.status).toBe(200);
		expect(renamed.body.team.portfolioThresholds).toEqual({ green: 2.5, amber: 12.5, source: 'team' });
	});
});

describe('team.settings in the database', () => {
	it('RLS: only a team admin updates the row, as water_app (positive control: the admin)', async () => {
		const set = `UPDATE team SET settings = '{"portfolio":{"thresholds":{"green":1,"amber":2}}}' WHERE id = $1`;
		for (const u of [member, viewer, stranger]) {
			expect((await withUser(u.id, (db) => db.query(set, [teamId]))).rowCount).toBe(0);
		}
		expect((await asOwner('SELECT settings FROM team WHERE id = $1', [teamId]))[0].settings.portfolio.thresholds).toEqual({ green: 2.5, amber: 12.5 });
		expect((await withUser(admin.id, (db) => db.query(set, [teamId]))).rowCount).toBe(1);
		// Every member reads it; a stranger doesn't see the row at all.
		expect((await withUser(viewer.id, (db) => db.query('SELECT settings FROM team WHERE id = $1', [teamId]))).rows[0].settings).toEqual({
			portfolio: { thresholds: { green: 1, amber: 2 } }
		});
		expect((await withUser(stranger.id, (db) => db.query('SELECT settings FROM team WHERE id = $1', [teamId]))).rowCount).toBe(0);
	});

	it('the CHECK holds the shape for any writer, even the owner', async () => {
		for (const bad of [
			'[]',
			'{"colour":"blue"}',
			'{"portfolio":[]}',
			'{"portfolio":{"other":1}}',
			'{"portfolio":{"thresholds":{"green":20,"amber":20}}}',
			'{"portfolio":{"thresholds":{"green":-1,"amber":20}}}',
			'{"portfolio":{"thresholds":{"green":5,"amber":100.5}}}',
			'{"portfolio":{"thresholds":{"green":"5","amber":20}}}',
			'{"portfolio":{"thresholds":{"green":5}}}',
			'{"portfolio":{"thresholds":{"green":5,"amber":20,"red":50}}}'
		]) {
			await expect(asOwner('UPDATE team SET settings = $2::jsonb WHERE id = $1', [teamId, bad]), bad).rejects.toThrow(/team_settings_valid/);
		}
		// Positive controls: the valid shapes.
		for (const good of ['{}', '{"portfolio":{}}', '{"portfolio":{"thresholds":{"green":0,"amber":100}}}']) {
			await asOwner('UPDATE team SET settings = $2::jsonb WHERE id = $1', [teamId, good]);
		}
	});
});
