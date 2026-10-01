// Sending an issued evidence pack to the members acting for the responsible
// authority (licensing build item 13; provisional position, pre-counsel
// research, 2026-10-01; docs/evidence-pack.md § Sending it to the
// authority). Every "cannot" has its positive control:
//
//   - who sends: an editor or owner (control), never a viewer or an applicant;
//   - to whom: only members the owner marked as acting for the authority,
//     editors and up, never the sender; an id that isn't one is one refusal;
//   - what: only an issued pack, of this project;
//   - the mail: the pack's page and the verify page, never a file or a
//     download link; the history names the recipients by id.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { outbox } from '../mail/transport.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User; // the host's assessor, who sends
let authorityA: User; // editor, acting for the authority
let authorityB: User; // editor, acting for the authority
let plainEditor: User; // editor, not marked
let viewer: User;
let applicant: User;
let projectId: string;
let otherProject: string;
let issued: string;
let withdrawn: string;
let foreign: string;

const P = () => `/projects/${projectId}`;
/** The pack-sent mails to an address (signing up and joining mail them too). */
const sentTo = (to: string) => outbox.filter((m) => m.to === to && m.kind === 'pack_sent');
const mailCount = (to: string) => sentTo(to).length;
const lastMailTo = (to: string) => sentTo(to).at(-1);
const send = (u: User, pack: string, body: unknown = {}) => u.call('POST', `${P()}/packs/${pack}/send`, body);

async function plantPack(project: string, status: 'issued' | 'withdrawn', title: string): Promise<string> {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL session_replication_role = replica');
		const { rows: run } = await client.query<{ id: string }>(
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, '1.50.0', '2000-10-01', '2020-09-30', '{}') RETURNING id::text`,
			[project, owner.id]
		);
		const id = randomUUID();
		const manifest = { pack: { id, version: 1 }, project: { id: project, name: 'Sending' }, engine: { version: '1.50.0' }, report: { mode: 'baseline', identity: { title } } };
		await client.query(
			`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, status, status_reason, manifest, manifest_sha256, report_version, engine_version, created_by, issued_at, issued_by)
			 VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'evidence-8', '1.50.0', $8, now(), $8)`,
			[id, project, run[0]!.id, status, status === 'withdrawn' ? 'An error in the rule table' : null, JSON.stringify(manifest), createHash('sha256').update(id).digest('hex'), owner.id]
		);
		await client.query('COMMIT');
		return id;
	} finally {
		await client.end();
	}
}

beforeAll(async () => {
	[owner, editor, authorityA, authorityB, plainEditor, viewer, applicant] = (await Promise.all(
		['Spowner', 'Speditor', 'Spauthoritya', 'Spauthorityb', 'Spplain', 'Spviewer', 'Spapplicant'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Sending' })).body.project.id;
	otherProject = (await owner.call('POST', '/projects', { name: 'Elsewhere' })).body.project.id;
	for (const [u, role] of [
		[editor, 'editor'],
		[authorityA, 'editor'],
		[authorityB, 'editor'],
		[plainEditor, 'editor'],
		[viewer, 'viewer'],
		[applicant, 'contributor']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status).toBe(201);
	expect((await owner.call('PATCH', P(), { settings: { responsibleAuthority: { name: 'Breede-Olifants CMA', kind: 'cma', office: 'Worcester' } } })).status).toBe(200);
	issued = await plantPack(projectId, 'issued', 'Baseline evidence');
	withdrawn = await plantPack(projectId, 'withdrawn', 'Withdrawn evidence');
	foreign = await plantPack(otherProject, 'issued', 'Another catchment');
});

describe('sending an issued pack to the responsible authority', () => {
	it('needs a member acting for the authority first', async () => {
		const res = await send(editor, issued);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/acts for the responsible authority/);
	});

	it('is an editor’s: a viewer and an applicant are refused (control: the editor below sends)', async () => {
		for (const u of [authorityA, authorityB]) expect((await owner.call('PATCH', `${P()}/members/${u.id}`, { actsForAuthority: true })).status).toBe(200);
		expect((await send(viewer, issued)).status).toBe(403);
		expect((await send(applicant, issued)).status).toBe(403);
		expect(mailCount(authorityA.email)).toBe(0);
	});

	it('emails every member acting for the authority a link to the pack’s page, never a file, and records it by id', async () => {
		const res = await send(editor, issued, { note: 'For the licence assessment of the Upper dam.' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.recipients.map((r: { userId: string }) => r.userId).sort()).toEqual([authorityA.id, authorityB.id].sort());
		expect(res.body).toMatchObject({ sent: 2, failed: 0 });
		// Never the unmarked editor, the viewer or the applicant.
		for (const u of [plainEditor, viewer, applicant, editor]) expect(mailCount(u.email), u.email).toBe(0);
		const mail = lastMailTo(authorityA.email)!;
		expect(mail.kind).toBe('pack_sent');
		expect(mail.subject).toContain('Breede-Olifants CMA');
		expect(mail.text).toContain(`/projects/${projectId}/packs/${issued}`);
		expect(mail.text).toContain('/verify/');
		expect(mail.text).toContain('For the licence assessment of the Upper dam.');
		// No file, no download, no signed URL: the page asks the reader to sign in.
		expect(mail.text).not.toMatch(/\/pdf|\/bundle|X-Amz|Signature=/);
		const [event] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'pack.sent' ORDER BY id DESC LIMIT 1`, [projectId]);
		expect(event!.subject).toMatchObject({ packId: issued, version: 1, authority: 'Breede-Olifants CMA', note: true });
		expect([...(event!.subject.recipients as string[])].sort()).toEqual([authorityA.id, authorityB.id].sort());
		expect(JSON.stringify(event)).not.toContain('Upper dam');
	});

	it('goes only to the members named, each acting for the authority; any other id is one refusal', async () => {
		const before = mailCount(authorityB.email);
		const one = await send(owner, issued, { userIds: [authorityA.id] });
		expect(one.status).toBe(200);
		expect(one.body.recipients).toEqual([{ userId: authorityA.id, displayName: 'Spauthoritya' }]);
		expect(mailCount(authorityB.email)).toBe(before);
		for (const id of [plainEditor.id, viewer.id, randomUUID()]) expect((await send(owner, issued, { userIds: [authorityA.id, id] })).status, id).toBe(422);
	});

	it('never mails the sender, even one acting for the authority', async () => {
		const res = await send(authorityA, issued);
		expect(res.status).toBe(200);
		expect(res.body.recipients.map((r: { userId: string }) => r.userId)).toEqual([authorityB.id]);
	});

	it('sends only an issued pack of this project', async () => {
		expect((await send(editor, withdrawn)).status).toBe(409);
		expect((await send(editor, foreign)).status).toBe(404);
		expect((await send(editor, 'not-a-pack')).status).toBe(404);
	});
});
