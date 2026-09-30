// The applicant's pack answer (applicantPacks.ts toApplicantPack): the
// database's allowlist (app_applicant_pack, 131_applicant_packs.sql) applied
// again field by field, so a key the database starts returning never leaves by
// default. The database side is applicant-packs.db.test.ts.
import { describe, expect, it } from 'vitest';
import { toApplicantPack, toApplicantPackMeta, type ApplicantPackRow } from './applicantPacks.js';

const PACK = '11111111-1111-4111-8111-111111111111';
const SCENARIO = '22222222-2222-4222-8222-222222222222';
const OTHER_NODE = '33333333-3333-4333-8333-333333333333';
const HASH = 'ab'.repeat(32);
const LEAKS = ['Neighbour Farm', 'holder@example.com', 'Jane Holder', OTHER_NODE, 'manifest-secret'];

const row = (over: Partial<ApplicantPackRow> = {}): ApplicantPackRow => ({
	pack: {
		id: PACK,
		scenarioId: SCENARIO,
		title: 'Raise my dam',
		mode: 'application',
		version: 2,
		status: 'issued',
		issuedAt: '2026-09-30T10:00:00Z',
		manifestSha256: HASH,
		supersedesId: null,
		supersededById: null,
		withdrawnReason: 'not for an issued pack',
		isOwner: true,
		canShare: true,
		manifest: 'manifest-secret',
		createdBy: 'Jane Holder'
	},
	verify: {
		status: 'issued',
		version: 2,
		issuedAt: '2026-09-30T10:00:00Z',
		catchment: 'Catchment',
		engineVersion: '1.50.0',
		reportVersion: 'evidence-8',
		manifestSha256: HASH,
		pdfSha256: null,
		bundleSha256: null,
		successorSha256: null,
		withdrawnReason: null,
		methodology: { version: 'm1', sha256: null },
		errata: [],
		signers: [{ fullName: 'Dr A Signer', registrationBody: 'sacnasp', registrationNo: '400123/10', signedAt: 'x', email: 'holder@example.com' }],
		users: ['Neighbour Farm']
	},
	figures: { identity: { title: 'Raise my dam', mode: 'application', baseline: {}, application: null }, volumes: false, rows: [{ id: 'userSupply', subject: 'Neighbour Farm' }], river: [], byMonth: null, users: ['Neighbour Farm'] },
	units: {
		own: [{ name: 'My farm', kind: 'farm', onlyIn: null, suppliedA: 0.8, suppliedB: 0.9, change: { run: 10, band: { n: 3, p5: 1, p50: 2, p95: 3, min: 0 }, worse: null, bandNote: 'Jane Holder' }, nodeId: OTHER_NODE }],
		others: [
			{ kind: 'farm', n: 1, changePts: -4.4, name: 'Neighbour Farm', nodeId: OTHER_NODE },
			{ kind: 'user', n: 1, changePts: -0.2 },
			{ kind: 'farm', n: 'x', changePts: 1 }
		],
		holders: ['Jane Holder']
	},
	...over
});

describe('toApplicantPack', () => {
	it('keeps only the allowlisted fields, whatever the row carries', () => {
		const v = toApplicantPack(row());
		expect(v.pack).toEqual({
			id: PACK,
			scenarioId: SCENARIO,
			title: 'Raise my dam',
			mode: 'application',
			version: 2,
			status: 'issued',
			issuedAt: '2026-09-30T10:00:00Z',
			manifestSha256: HASH,
			shortCode: 'abab-abab-abab',
			verifyPath: '/verify/abab-abab-abab',
			supersedesId: null,
			supersededById: null,
			withdrawnReason: null,
			isOwner: true,
			canShare: true
		});
		expect(v.figures?.rows).toEqual([]);
		expect(v.units?.own).toEqual([
			{
				name: 'My farm',
				kind: 'farm',
				onlyIn: null,
				suppliedA: 0.8,
				suppliedB: 0.9,
				timeReliabilityA: null,
				timeReliabilityB: null,
				annualReliabilityA: null,
				annualReliabilityB: null,
				change: { run: 10, band: { n: 3, p5: 1, p50: 2, p95: 3 }, worse: null }
			}
		]);
		// Whole points (never −0), and a row without a number dropped.
		expect(v.units?.others).toEqual([
			{ kind: 'farm', n: 1, changePts: -4 },
			{ kind: 'user', n: 1, changePts: 0 }
		]);
		expect(Object.is(v.units?.others[1]?.changePts, -0)).toBe(false);
		const text = JSON.stringify(v);
		for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
	});

	it('never offers sharing a pack that no longer stands, and keeps the withdrawal reason only when withdrawn', () => {
		expect(toApplicantPackMeta({ ...row().pack, status: 'superseded', canShare: true }).canShare).toBe(false);
		const w = toApplicantPackMeta({ ...row().pack, status: 'withdrawn', canShare: true, withdrawnReason: 'An error' });
		expect(w).toMatchObject({ status: 'withdrawn', canShare: false, withdrawnReason: 'An error' });
	});

	it('passes a withheld units block through as null', () => {
		expect(toApplicantPack(row({ units: null })).units).toBeNull();
		expect(toApplicantPack(row({ figures: null })).figures).toBeNull();
	});
});
