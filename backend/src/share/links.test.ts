// The scenario link's answer (WP-3.15, share/links.ts toShareScenario): the
// database's allowlist (app_share_scenario, 115_scenario_share_notes.sql) is
// applied again field by field, so a key the database starts returning, or a
// summary field a later engine adds, never reaches a signed-out reader by
// default. A string scan in the spirit of WP-2.1's farmer-privacy guard:
// whatever sneaks into the row, no `user_display`, e-mail, member or other
// farm's name comes out. The database side is share/scenario-share.db.test.ts.
import { describe, expect, it } from 'vitest';
import { ListQuery, shareUrl, toLink, toShareScenario, type ShareLinkRow, type ShareScenarioRow } from './links.js';

const OWN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const LEAKS = ['Neighbour Farm', 'holder@example.com', 'Jane Holder', 'Consultant Name', 'user_display', OTHER];

const run = (extra: Record<string, unknown> = {}) => ({
	engineVersion: '1.31.0',
	startDate: '2020-10-01',
	endDate: '2021-09-30',
	createdAt: '2026-09-29T10:00:00Z',
	ewrDaysNotMet: 12,
	ewrFractionDaysNotMet: 0.03,
	volumes: { meanNaturalFlowM3Day: 5000, meanSimulatedOutflowM3Day: 4000, farms: { count: 5, demandM3Day: 900, suppliedM3Day: 800, belowTarget: 1, names: ['Neighbour Farm'] } },
	ewrSites: [
		{ name: 'Neighbour Farm', isOutlet: true, months: 12, met: 10, rate: 0.83, longestNotMetRun: 2, deficitM3: 1000, byMonth: [{ month: 10, years: 1, met: 1, rate: 1, nodeId: OTHER }], nodeId: OTHER },
		{ name: 'Gauge X', isOutlet: false, months: 12, met: 12, rate: 1, longestNotMetRun: 0, deficitM3: 0, byMonth: [] }
	],
	farms: [{ name: 'Neighbour Farm', nodeId: OTHER }],
	user_display: 'Jane Holder',
	...extra
});

const row = (over: Partial<ShareScenarioRow> = {}): ShareScenarioRow => ({
	project_name: 'Catchment',
	scenario: {
		id: '33333333-3333-4333-8333-333333333333',
		projectId: '44444444-4444-4444-8444-444444444444',
		name: 'Raise my dam',
		description: 'A bigger dam',
		origin: 'applicant',
		status: 'submitted',
		submittedAt: '2026-09-28T10:00:00Z',
		decidedAt: null,
		outcome: null,
		decisionNote: '',
		ops: [{ op: 'node.set', nodeId: OWN, field: 'damCapacityM3', value: 120000 }],
		opsSha256: 'a'.repeat(64),
		ownedNodeIds: [OWN],
		opNames: [
			{ id: OWN, name: 'My Farm' },
			{ id: 'x', name: 'Neighbour Farm' }
		],
		members: [{ displayName: 'Consultant Name', email: 'holder@example.com' }],
		ownerUserId: OTHER
	},
	base_run: run(),
	base_stamp: Buffer.alloc(32),
	base_digest: Buffer.alloc(32),
	runs: [candidate('aa', ['proposal'])],
	comments: [{ body: 'Please protect the river', author: 'An NGO', createdAt: '2026-09-29T11:00:00Z', editedAt: null, email: 'holder@example.com', authorId: OTHER }],
	...over
});

const candidate = (stamp: string, classified: string[], extra: Record<string, unknown> = {}) => ({ projection: run(extra), classified, stamp, digest: 'ff', user_display: 'Jane Holder' });
const verified = () => true;

describe('toShareScenario', () => {
	it('passes only allowlisted fields: no member, e-mail, holder, id or other farm name', () => {
		const out = toShareScenario(row(), verified);
		const text = JSON.stringify(out);
		for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
		// Positive control: what the page needs is there.
		expect(out.scenario.opNames).toEqual([{ id: OWN, name: 'My Farm' }]);
		expect(out.results).toBe('ready');
		expect(out.run?.ewrSites.map((s) => s.name)).toEqual([null, 'Gauge X']);
		expect(out.run?.volumes?.farms).toEqual({ count: 5, demandM3Day: 900, suppliedM3Day: 800, belowTarget: 1 });
		expect(out.comments).toEqual([{ body: 'Please protect the river', author: 'An NGO', createdAt: '2026-09-29T11:00:00Z', editedAt: null }]);
		expect(Object.keys(out.scenario).sort()).toEqual(
			['classified', 'decidedAt', 'decisionNote', 'description', 'id', 'name', 'opNames', 'ops', 'opsSha256', 'origin', 'outcome', 'ownedNodeIds', 'status', 'submittedAt'].sort()
		);
	});

	it('drops every volume, a site deficit included, below the k rule', () => {
		const small = row({ base_run: run({ volumes: null }), runs: [candidate('aa', ['proposal'], { volumes: null })] });
		const out = toShareScenario(small, verified);
		expect(out.run?.volumes).toBeNull();
		expect(out.run?.ewrSites.every((s) => s.deficitM3 === null)).toBe(true);
		expect(out.run?.ewrDaysNotMet).toBe(12);
	});

	it('shows no result when a stamp fails, and says so; none when there is no run', () => {
		expect(toShareScenario(row(), (d, s) => d !== null && s !== null && false)).toMatchObject({ results: 'unverified', base: null, run: null });
		expect(toShareScenario(row({ runs: [] }), verified)).toMatchObject({ results: 'none', base: null, run: null });
	});

	it('shows the newest run whose stamp verifies, and its classes only; a newer unstamped row neither hides nor relabels it', () => {
		const good = candidate('aa', ['baseline'], { ewrDaysNotMet: 12 });
		const forged = candidate('bb', ['proposal'], { ewrDaysNotMet: 0 });
		const onlyGood = (digest: Buffer | null, stamp: Buffer | null) => !stamp || stamp.toString('hex') !== 'bb';
		const out = toShareScenario(row({ runs: [forged, good] }), onlyGood);
		expect(out.results).toBe('ready');
		expect(out.run?.ewrDaysNotMet).toBe(12);
		expect(out.scenario.classified).toEqual(['baseline']);
		// Nothing verifies: no result and no classes.
		expect(toShareScenario(row({ runs: [forged] }), onlyGood)).toMatchObject({ results: 'unverified', run: null, scenario: { classified: null } });
	});

	it('drops the base run’s volumes too when the shown run has none (a baseline assumption on another unit)', () => {
		const out = toShareScenario(row({ runs: [candidate('aa', ['baseline'], { volumes: null })] }), verified);
		expect(out.run?.volumes).toBeNull();
		expect(out.base?.volumes).toBeNull();
		expect(out.base?.ewrSites.every((x) => x.deficitM3 === null)).toBe(true);
	});
});

describe('shareUrl', () => {
	it('keeps the baseline link as it was, and names a targeted link’s kind in the fragment', () => {
		expect(shareUrl('tok')).toMatch(/\/share#t=tok$/);
		expect(shareUrl('tok', 'scenario')).toMatch(/\/share#t=tok&k=scenario$/);
	});
});

describe('the link list', () => {
	const linkRow = (over: Partial<ShareLinkRow> = {}): ShareLinkRow => ({
		id: OWN,
		label: 'Forum',
		created_at: new Date('2026-09-29T10:00:00Z'),
		created_by_name: 'Jo',
		expires_at: new Date('2026-10-29T10:00:00Z'),
		revoked_at: null,
		revoked_by_name: null,
		last_used_at: null,
		target_kind: null,
		target_id: null,
		target_name: null,
		target_status: null,
		mine: true,
		...over
	});

	it('takes a scope or a scenario, not both', () => {
		expect(ListQuery.parse({ scope: 'all' })).toEqual({ scope: 'all' });
		expect(ListQuery.parse({})).toEqual({});
		expect(() => ListQuery.parse({ scope: 'every' })).toThrow();
		expect(() => ListQuery.parse({ scope: 'all', scenarioId: OTHER })).toThrow(/not both/);
	});

	it('names a target only when the caller read it', () => {
		expect(toLink(linkRow()).target).toBeNull();
		expect(toLink(linkRow({ target_kind: 'scenario', target_id: OTHER, target_name: 'Raise', target_status: 'submitted' }))).toMatchObject({
			targetKind: 'scenario',
			targetId: OTHER,
			target: { name: 'Raise', status: 'submitted' }
		});
		// A target the caller can't read (RLS): kind and id stay, the name doesn't.
		expect(toLink(linkRow({ target_kind: 'scenario', target_id: OTHER })).target).toBeNull();
	});
});
