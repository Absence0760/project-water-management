// The switch for the second-factor requirement (auth/stepUp.ts): on unless
// explicitly off, and never off on Lambda. The requirement itself is in
// stepUp.db.test.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mfaRequired } from './stepUp.js';

describe('mfaRequired', () => {
	it('is on when unset, empty or true', () => {
		expect(mfaRequired({})).toBe(true);
		expect(mfaRequired({ MFA_REQUIRED: '' })).toBe(true);
		expect(mfaRequired({ MFA_REQUIRED: 'true' })).toBe(true);
		expect(mfaRequired({ MFA_REQUIRED: 'true', AWS_LAMBDA_FUNCTION_NAME: 'api' })).toBe(true);
	});
	it('is off only when set to false off Lambda', () => {
		expect(mfaRequired({ MFA_REQUIRED: 'false' })).toBe(false);
		expect(() => mfaRequired({ MFA_REQUIRED: 'false', AWS_LAMBDA_FUNCTION_NAME: 'api' })).toThrow(/Lambda always requires/);
	});
	it('refuses anything else rather than guess', () => {
		for (const v of ['0', 'off', 'no', 'FALSE']) expect(() => mfaRequired({ MFA_REQUIRED: v }), v).toThrow(/true or false/);
	});
});

// The requirement sits in requireRole(…, 'owner') and requireTeamRole(…, 'admin').
// A route that compares the role itself ('owner', 'admin', rank.owner) skips
// both, so every such file must call requireStepUp, or be listed here with
// why its comparison gates no owner's or admin's action.

const HAND_ROLLED = /rank\.owner|[!=]==\s*'(owner|admin)'/;
const NOT_A_GATE: Record<string, string> = {
	'projects/access.ts': 'requireRole itself: it calls requireStepUp for owner',
	'teams/access.ts': 'requireTeamRole itself: it calls requireStepUp for admin',
	'alerts/rules.ts': 'a role’s default alert mode, not an action',
	'feeds/routes.ts': 'the canEdit flag the page shows; the feed writes go through requireRole(…, owner)',
	'evidence/notices.ts': 'who is emailed about a pack, not an action',
	'errata/notices.ts': 'who is emailed about a known engine bug (still an owner when it is sent), not an action'
};

describe('hand-rolled owner and admin checks', () => {
	const SRC = join(import.meta.dirname, '..');
	const files = (dir: string): string[] =>
		readdirSync(dir).flatMap((f) => {
			const p = join(dir, f);
			if (statSync(p).isDirectory()) return f === '__tests__' ? [] : files(p);
			return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
		});
	const found = files(SRC)
		.map((p) => ({ rel: relative(SRC, p), src: readFileSync(p, 'utf8') }))
		.filter((f) => HAND_ROLLED.test(f.src));

	it('finds them (positive control: the member removal and share-link routes)', () => {
		expect(found.map((f) => f.rel)).toEqual(expect.arrayContaining(['projects/routes.ts', 'share/routes.ts', 'teams/routes.ts']));
	});
	it('each calls requireStepUp, or is listed with why it gates nothing', () => {
		expect(found.filter((f) => !(f.rel in NOT_A_GATE) && !f.src.includes('requireStepUp(')).map((f) => f.rel)).toEqual([]);
		// Every listed file still has such a comparison.
		expect(Object.keys(NOT_A_GATE).filter((rel) => !found.some((f) => f.rel === rel))).toEqual([]);
	});
});
