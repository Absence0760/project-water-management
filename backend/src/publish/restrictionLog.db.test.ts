// The restriction log (GET /projects/:id/restriction-log, restrictionLog.ts):
// every restriction decision, from the decision log's audit events, which
// outlive the 12 publications run_publication keeps. Who may read it is
// tested at both layers: the route (viewer and above) and RLS on audit_event,
// each "cannot see" beside a positive control.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { PUBLICATION_HISTORY_MAX } from './publish.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let run1: string;
let run2: string;
let pub1: string;
let pub2: string;

const outlet = node('Weir', null);
const farms = [node('Unit One', outlet.id), node('Unit Two', outlet.id)];
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const log = (u: User, query = '') => u.call('GET', `/projects/${projectId}/restriction-log${query}`);
const csv = async (u: User) => {
	const r = await app.request(`/projects/${projectId}/restriction-log/export.csv`, { headers: { cookie: u.cookie, origin: 'http://localhost:7777' } });
	return { status: r.status, text: await r.text(), type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition') };
};
/** A CSV body's records (no quoted line breaks in this test's cells), BOM and terminator dropped. */
const records = (text: string) => text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
const run = async (u: User) => {
	const res = await u.call('POST', `/projects/${projectId}/runs`, { label: 'r' });
	expect(res.status).toBe(201);
	return res.body.run.id as string;
};

beforeAll(async () => {
	[owner, editor, viewer, farmer, stranger] = (await Promise.all(['Rlowner', 'Rleditor', 'Rlviewer', 'Rlfarmer', 'Rlstranger'].map((n) => signUp(n)))) as [User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Restriction log' })).body.project.id as string;
	const model = {
		nodes: [outlet, ...farms],
		crops: [crop],
		cropAreas: farms.map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 120_000 })),
		transfers: []
	};
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
	const rain = Array.from({ length: 500 }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farms[0]!.id] })).status).toBe(201);

	// The season: publish with a restriction, change its level, change only the note (no decision), publish again.
	run1 = await run(editor);
	const p1 = await editor.call('POST', `/projects/${projectId}/publication`, {
		runId: run1,
		note: 'Dam levels low',
		restriction: { level: 'advisory', pct: 10, notice: { en: 'Please save water.', af: 'Spaar asseblief water.' } },
		nextExpectedOn: '2023-03-01'
	});
	expect(p1.status).toBe(201);
	pub1 = p1.body.publication.id;
	expect((await editor.call('PATCH', `/projects/${projectId}/publication/${pub1}`, { restriction: { level: 'restricted', pct: 25, notice: { en: 'Cut by a quarter.' } } })).status).toBe(200);
	expect((await editor.call('PATCH', `/projects/${projectId}/publication/${pub1}`, { note: 'Only the note' })).status).toBe(200);
	run2 = await run(owner);
	const p2 = await owner.call('POST', `/projects/${projectId}/publication`, { runId: run2 });
	expect(p2.status).toBe(201);
	pub2 = p2.body.publication.id;
}, 120_000);

afterAll(() => retirePendingJobs(projectId));

describe('the restriction log', () => {
	it('lists every decision newest first, with what, which run, when and who, and leaves a note-only change out', async () => {
		const res = await log(viewer);
		expect(res.status).toBe(200);
		expect(res.body.next).toBeNull();
		const items = res.body.items as Record<string, unknown>[];
		expect(items.map((i) => i.kind)).toEqual(['published', 'notice_changed', 'published']);
		expect(items[0]).toMatchObject({
			by: 'Rlowner',
			auto: false,
			publicationId: pub2,
			runId: run2,
			restriction: { level: 'none', pct: null, notice: {} },
			current: true,
			runKept: true
		});
		expect(items[1]).toMatchObject({
			by: 'Rleditor',
			publicationId: pub1,
			runId: run1,
			fields: ['restriction'],
			restriction: { level: 'restricted', pct: 25, notice: { en: 'Cut by a quarter.' } },
			nextExpectedOn: '2023-03-01',
			current: false
		});
		expect(items[2]).toMatchObject({
			by: 'Rleditor',
			publicationId: pub1,
			restriction: { level: 'advisory', pct: 10, notice: { en: 'Please save water.', af: 'Spaar asseblief water.' } },
			nextExpectedOn: '2023-03-01',
			note: 'Dam levels low',
			farms: 2,
			current: false,
			runKept: true
		});
		expect((items[2]!.season as { from: string }).from).toMatch(/^\d{4}-10-01$/);
		// Never the per-unit figures: those are History's.
		expect(JSON.stringify(items)).not.toContain('perFarm');
		for (const i of items) expect(Date.parse(i.at as string)).not.toBeNaN();
	});

	it('is read by viewers and above; a farmer gets 403 and a non-member 404, and RLS shows them no event either', async () => {
		// Positive controls: the owner, an editor and a viewer read the same three decisions.
		for (const u of [owner, editor, viewer]) {
			const res = await log(u);
			expect(res.status, u.email).toBe(200);
			expect(res.body.items, u.email).toHaveLength(3);
		}
		expect((await log(farmer)).status).toBe(403);
		expect((await log(stranger)).status).toBe(404);
		// RLS alone, the route's check aside: the member reads the events, the farmer and the stranger none.
		const events = (u: User) =>
			withUser(u.id, async (db) => (await db.query("SELECT id FROM audit_event WHERE project_id = $1 AND kind LIKE 'publication.%'", [projectId])).rows.length);
		expect(await events(viewer)).toBeGreaterThan(0);
		expect(await events(farmer)).toBe(0);
		expect(await events(stranger)).toBe(0);
	});

	it('keeps decisions whose publication run_publication has trimmed, and older events that kept only the level', async () => {
		// More superseded publications than run_publication keeps: written as the decision log does, with no row left
		// behind them (as after run_publication_cap), the oldest one in the shape from before issue #119.
		const extra = PUBLICATION_HISTORY_MAX + 2;
		for (let i = 0; i < extra; i++) {
			const subject =
				i === 0
					? { publicationId: crypto.randomUUID(), runId: crypto.randomUUID(), restriction: { level: 'restricted', pct: 40 }, farms: 2 }
					: { publicationId: crypto.randomUUID(), runId: crypto.randomUUID(), restriction: { level: 'advisory', pct: i, notice: { en: `Old notice ${i}` } }, nextExpectedOn: null, note: '', farms: 2 };
			await asOwner(
				`INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject, created_at)
				 VALUES ($1, $2, 'Rleditor', 'publication.published', $3, now() - make_interval(days => $4))`,
				[projectId, editor.id, JSON.stringify(subject), 400 - i]
			);
		}
		const res = await log(viewer, '?limit=100');
		expect(res.status).toBe(200);
		const items = res.body.items as Record<string, unknown>[];
		expect(items).toHaveLength(3 + extra);
		const oldest = items.at(-1)!;
		expect(oldest).toMatchObject({ kind: 'published', restriction: { level: 'restricted', pct: 40, notice: null }, current: false, runKept: false, season: null });
		expect('nextExpectedOn' in oldest).toBe(false);
		expect(items.at(-2)).toMatchObject({ restriction: { level: 'advisory', pct: 1, notice: { en: 'Old notice 1' } }, nextExpectedOn: null, runKept: false });
	});

	it('pages by cursor without skipping or repeating a decision', async () => {
		const all = ((await log(viewer, '?limit=100')).body.items as { id: string }[]).map((i) => i.id);
		const seen: string[] = [];
		let next: string | null = null;
		do {
			const res = await log(viewer, `?limit=4${next ? `&before=${encodeURIComponent(next)}` : ''}`);
			expect(res.status).toBe(200);
			seen.push(...(res.body.items as { id: string }[]).map((i) => i.id));
			next = res.body.next;
		} while (next);
		expect(seen).toEqual(all);
	});

	it('exports every decision as a CSV, the same rows the page pages through, with the notice per language and the staff note, never a unit’s figures', async () => {
		const all = (await log(viewer, '?limit=100')).body.items as { id: string; runId: string | null }[];
		const res = await csv(viewer);
		expect(res.status).toBe(200);
		expect(res.type).toBe('text/csv; charset=utf-8');
		expect(res.disposition).toMatch(/^attachment; filename="restriction-log_restriction-log_\d{4}-\d{2}-\d{2}\.csv"$/);
		const [head, ...rows] = records(res.text);
		expect(head).toBe(
			'decided_at_utc,decision,changed,by,automatic,level,restriction_pct,in_force,notice_en,notice_af,notice_recorded,next_expected_on,season_from,season_to,data_until,hydrological_units,staff_note,run_id,run_kept,publication_id'
		);
		// One row per decision, the whole log in one file (the page's 50 at a time aside), newest first.
		expect(rows).toHaveLength(all.length);
		expect(rows.map((r) => r.split(',').at(-3))).toEqual(all.map((d) => d.runId ?? ''));
		const cols = head!.split(',');
		const cell = (r: string, name: string) => r.split(',')[cols.indexOf(name)];
		// The newest: the second publication, in force.
		expect(cell(rows[0]!, 'decision')).toBe('published');
		expect(cell(rows[0]!, 'by')).toBe('Rlowner');
		expect(cell(rows[0]!, 'level')).toBe('none');
		expect(cell(rows[0]!, 'in_force')).toBe('yes');
		expect(cell(rows[0]!, 'publication_id')).toBe(pub2);
		expect(rows.slice(1).every((r) => cell(r, 'in_force') === 'no')).toBe(true);
		const changed = rows[1]!;
		expect(['decision', 'changed', 'by', 'automatic', 'level', 'restriction_pct', 'notice_en', 'notice_af', 'notice_recorded', 'next_expected_on'].map((n) => cell(changed, n))).toEqual([
			'notice_changed',
			'restriction',
			'Rleditor',
			'no',
			'restricted',
			'25',
			'Cut by a quarter.',
			'',
			'yes',
			'2023-03-01'
		]);
		const first = rows[2]!;
		expect(cell(first, 'notice_en')).toBe('Please save water.');
		expect(cell(first, 'notice_af')).toBe('Spaar asseblief water.');
		expect(cell(first, 'staff_note')).toBe('Dam levels low');
		expect(cell(first, 'hydrological_units')).toBe('2');
		expect(cell(first, 'run_kept')).toBe('yes');
		expect(cell(first, 'season_from')).toMatch(/^\d{4}-10-01$/);
		// The older event that kept only the level says so; nothing per unit anywhere.
		expect(cell(rows.at(-1)!, 'notice_recorded')).toBe('no');
		expect(res.text).not.toMatch(/perFarm|Unit One|Unit Two/);
	});

	it('exports to viewers and above only: a farmer gets 403, a non-member 404, and RLS gives neither an event', async () => {
		// Positive controls: the owner, an editor and a viewer get the same file.
		const mine = (await csv(viewer)).text;
		for (const u of [owner, editor]) {
			const res = await csv(u);
			expect(res.status, u.email).toBe(200);
			expect(records(res.text).slice(1), u.email).toEqual(records(mine).slice(1));
		}
		const f = await csv(farmer);
		expect(f.status).toBe(403);
		expect(f.text).not.toContain('Please save water.');
		const s = await csv(stranger);
		expect(s.status).toBe(404);
		expect(s.text).not.toContain('Please save water.');
	});

	it('refuses a malformed cursor or limit with 400', async () => {
		expect((await log(viewer, '?before=yesterday')).status).toBe(400);
		expect((await log(viewer, '?limit=0')).status).toBe(400);
		expect((await log(viewer, '?limit=101')).status).toBe(400);
	});
});
