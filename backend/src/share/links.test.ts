// The scenario link's answer (WP-3.15, share/links.ts toShareScenario): the
// database's allowlist (app_share_scenario, 115_scenario_share_notes.sql) is
// applied again field by field, so a key the database starts returning, or a
// summary field a later engine adds, never reaches a signed-out reader by
// default. A string scan in the spirit of WP-2.1's farmer-privacy guard:
// whatever sneaks into the row, no `user_display`, e-mail, member or other
// farm's name comes out. The database side is share/scenario-share.db.test.ts.
import { describe, expect, it } from 'vitest';
import type { Erratum } from '@water-management/engine';
import { ListQuery, shareUrl, toLink, toSharePack, toShareScenario, toVerify, type ShareLinkRow, type SharePackRow, type ShareScenarioRow } from './links.js';

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
		expect(shareUrl('tok', 'pack')).toMatch(/\/share#t=tok&k=pack$/);
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
		target_version: null,
		mine: true,
		...over
	});

	it('takes a scope or a scenario, not both', () => {
		expect(ListQuery.parse({ scope: 'all' })).toEqual({ scope: 'all' });
		expect(ListQuery.parse({})).toEqual({});
		expect(() => ListQuery.parse({ scope: 'every' })).toThrow();
		expect(() => ListQuery.parse({ scope: 'all', scenarioId: OTHER })).toThrow(/one of/);
		expect(ListQuery.parse({ packId: OTHER })).toEqual({ packId: OTHER });
		expect(() => ListQuery.parse({ packId: OTHER, scenarioId: OWN })).toThrow(/one of/);
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
		// A pack (128): its title, status and version; a scenario never carries a version.
		expect(toLink(linkRow({ target_kind: 'pack', target_id: OTHER, target_name: 'Raise', target_status: 'withdrawn', target_version: 2 })).target).toEqual({
			name: 'Raise',
			status: 'withdrawn',
			version: 2
		});
		expect(toLink(linkRow({ target_kind: 'scenario', target_id: OTHER, target_name: 'Raise', target_status: 'submitted', target_version: 3 })).target).toEqual({
			name: 'Raise',
			status: 'submitted'
		});
	});
});

// The pack link's answer (128_pack_share_notes.sql app_share_pack): the
// database's allowlist again, field by field, and the figures only while the
// pack is issued whatever the row carries.
describe('toSharePack', () => {
	const SHA = 'ab'.repeat(32);
	const figures = (extra: Record<string, unknown> = {}) => ({
		identity: {
			title: 'Raise Rooikloof',
			mode: 'application',
			baseline: { startDate: '2000-10-01', endDate: '2020-09-30', engineVersion: '1.50.0', runoffModel: 'gr4j', createdBy: 'Jane Holder' },
			application: { engineVersion: '1.50.0', proposals: 1, assumptions: 0, ownerName: 'Jane Holder' }
		},
		volumes: false,
		rows: [
			{ id: 'reserve', label: 'Reserve months met', basis: 'b', subject: 'Gauge X', unit: '%', higherIsWorse: false, baseline: 90, application: 80, change: { run: -10, band: { n: 30, p5: -12, p50: -10, p95: -8, min: -20, names: ['Neighbour Farm'] }, bandNote: null, worse: { k: 28, n: 30 } }, notAssessed: null, note: '10 of 12 months' },
			{ id: 'ewrDays', label: 'Days below the EWR', basis: 'b', subject: 'Neighbour Farm', unit: 'days', higherIsWorse: true, baseline: 10, application: 12, change: null, notAssessed: null, note: 'Neighbour Farm' },
			// A volume row the database let through although volumes is false, and rows it never sends.
			{ id: 'shortfall', label: 'Volume', basis: 'b', subject: null, unit: 'Mm³', higherIsWorse: true, baseline: 1, application: 2, change: null, notAssessed: null, note: null },
			{ id: 'userSupply', label: 'Supply', basis: 'b', subject: 'Neighbour Farm', unit: '%', higherIsWorse: false, baseline: 100, application: 50, change: null, notAssessed: null, note: null },
			{ id: 'otherApplications', label: 'Other', basis: 'b', subject: null, unit: 'days', higherIsWorse: true, baseline: null, application: null, change: null, notAssessed: null, note: 'Neighbour Farm application' }
		],
		river: [
			{ name: 'Neighbour Farm', isOutlet: true, category: 'C', monthsA: 12, rateA: 0.9, rateB: 0.8, longestA: 1, longestB: 2, lost: 1, gained: 0, key: OTHER, months: [{ deliveredA: 1 }] },
			{ name: 'Gauge X', isOutlet: false, category: null, monthsA: 12, rateA: 1, rateB: 1, longestA: 0, longestB: 0, lost: 0, gained: 0 }
		],
		byMonth: [{ month: 10, run: 1, band: null, nodeId: OTHER }],
		disclaimerVersion: 'v1',
		users: [{ name: 'Neighbour Farm' }],
		...extra
	});
	const verify = (status = 'issued', extra: Record<string, unknown> = {}) => ({
		status,
		version: 2,
		issuedAt: '2026-09-29T10:00:00Z',
		catchment: 'Catchment',
		engineVersion: '1.50.0',
		reportVersion: 'evidence-5',
		manifestSha256: SHA,
		pdfSha256: null,
		bundleSha256: SHA,
		successorSha256: null,
		withdrawnReason: status === 'withdrawn' ? 'Wrong baseline' : null,
		methodology: { version: 'm1', sha256: SHA },
		errata: [],
		signers: [{ fullName: 'Signer', registrationBody: 'sacnasp', registrationCategory: null, registrationField: null, registrationNo: '1', signedAt: '2026-09-29T09:00:00Z', email: 'holder@example.com' }],
		projectId: OTHER,
		...extra
	});
	const row = (over: Partial<SharePackRow> = {}): SharePackRow => ({
		pack: { id: OWN, projectId: OWN, title: 'Raise Rooikloof', mode: 'application', version: 2, createdBy: 'Jane Holder' },
		verify: verify(),
		figures: figures(),
		comments: [{ body: 'An objection', author: 'Ngo', createdAt: '2026-09-30T10:00:00Z', editedAt: null, authorId: OTHER }],
		...over
	});

	it('keeps only the allowlisted fields, whatever the row carries', () => {
		const out = toSharePack(row());
		const text = JSON.stringify(out);
		for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
		expect(out.pack).toEqual({ id: OWN, title: 'Raise Rooikloof', mode: 'application', version: 2, shortCode: 'abab-abab-abab' });
		expect(out.verify.shortCode).toBe('abab-abab-abab');
		expect(out.figures?.rows.map((r) => r.id)).toEqual(['reserve', 'ewrDays']);
		// A gauge names its reserve row; nothing else keeps a subject, and the outlet is unnamed.
		expect(out.figures?.rows[0]).toMatchObject({ subject: 'Gauge X', change: { band: { n: 30, p5: -12, p50: -10, p95: -8 }, worse: { k: 28, n: 30 } } });
		expect(out.figures?.rows[1]).toMatchObject({ subject: null, note: null });
		// No label or basis: the page words each row, and a basis quotes free text.
		expect(Object.keys(out.figures!.rows[0]!)).not.toContain('basis');
		expect(Object.keys(out.figures!.rows[0]!)).not.toContain('label');
		expect(out.figures?.river.map((s) => s.name)).toEqual([null, 'Gauge X']);
		expect(out.comments).toEqual([{ body: 'An objection', author: 'Ngo', createdAt: '2026-09-30T10:00:00Z', editedAt: null }]);
	});

	it('shows the volume rows only when the database says volumes', () => {
		expect(toSharePack(row({ figures: figures({ volumes: true }) })).figures?.rows.map((r) => r.id)).toEqual(['reserve', 'ewrDays', 'shortfall']);
	});

	it('drops the figures once the pack is superseded or withdrawn, even if the row carried them', () => {
		const withdrawn = toSharePack(row({ verify: verify('withdrawn') }));
		expect(withdrawn.figures).toBeNull();
		expect(withdrawn.verify).toMatchObject({ status: 'withdrawn', withdrawnReason: 'Wrong baseline' });
		const superseded = toSharePack(row({ verify: verify('superseded', { successorSha256: 'cd'.repeat(32), withdrawnReason: 'not shown' }) }));
		expect(superseded.figures).toBeNull();
		expect(superseded.verify).toMatchObject({ status: 'superseded', successorSha256: 'cd'.repeat(32), withdrawnReason: null });
	});

	it('lists the errata found since issue from the lookup’s runs, apart from the recorded ones, and never returns the runs (132)', () => {
		const list: Erratum[] = [
			{ id: 'ER-90', keyedOn: 'run', firstAffected: '1.40.0', fixedIn: null, severity: 'High', appliesWhen: 'always', summary: 'Recorded at draft', source: 's' },
			{ id: 'ER-91', keyedOn: 'run', firstAffected: '1.50.0', fixedIn: null, severity: 'High', appliesWhen: 'always', summary: 'Found later', source: 's' },
			{ id: 'ER-92', keyedOn: 'fit', firstAffected: '1.0.0', fixedIn: '1.45.0', severity: 'Low', appliesWhen: 'a fit', summary: 'Fit bug', source: 's' },
			{ id: 'ER-93', keyedOn: 'run', firstAffected: '1.0.0', fixedIn: '1.50.0', severity: 'Low', appliesWhen: 'always', summary: 'Fixed before', source: 's' }
		];
		const raw = verify('issued', {
			errata: [{ id: 'ER-90', summary: 'Recorded at draft' }],
			runs: [
				{ engineVersion: '1.50.0', fitEngineVersion: '1.44.0' },
				{ engineVersion: '1.50.0', fitEngineVersion: null }
			]
		});
		const out = toVerify(raw, list);
		expect(out.errata).toEqual([{ id: 'ER-90', summary: 'Recorded at draft' }]);
		expect(out.errataFoundSince).toEqual([
			{ id: 'ER-91', summary: 'Found later' },
			{ id: 'ER-92', summary: 'Fit bug' }
		]);
		expect(Object.keys(out)).not.toContain('runs');
		expect(JSON.stringify(out)).not.toContain('1.44.0');
		// The share link's verify is the same answer.
		expect(toSharePack(row({ verify: raw })).verify).toEqual(toVerify(raw));
		// No runs (a lookup from before 132, or a malformed row): nothing found since, never a throw.
		expect(toVerify(verify('issued', { runs: [{ engineVersion: 7 }, null] }), list).errataFoundSince).toEqual([]);
		expect(toVerify(verify(), list).errataFoundSince).toEqual([]);
	});
});
