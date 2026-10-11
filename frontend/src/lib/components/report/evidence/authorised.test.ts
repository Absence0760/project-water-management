import { describe, expect, it } from 'vitest';
import { authorisedUnavailable } from '@water-management/engine';
import { authorisedRow, mixLines } from './authorised';

describe('the board against full authorised use (evidence-14)', () => {
	it('says why there is none, in a fixed row', () => {
		expect(authorisedRow(authorisedUnavailable('notBuilt'))).toMatch(/^Not assessed: the baseline and the application haven’t been run with every holder/);
		expect(authorisedRow(authorisedUnavailable('noAllocations'))).toMatch(/no registered or licensed volumes/);
		expect(authorisedRow(authorisedUnavailable('stale', 'it was run on engine 1.0.0'))).toBe('Not assessed: the run at full authorised use is out of date: it was run on engine 1.0.0.');
		expect(authorisedRow({ ...authorisedUnavailable('notBuilt'), status: 'ok' })).toBeNull();
	});

	it('lists the mix by how it is held, entitlements marked, with the totals', () => {
		const m = mixLines({
			rows: [
				{ authorisation: 'licence', volumeM3PerYear: 150_000, entitlement: true },
				{ authorisation: 'registration', volumeM3PerYear: 400_000.4, entitlement: false },
				{ authorisation: 'unknown', volumeM3PerYear: 10, entitlement: false }
			],
			entitlementM3PerYear: 150_000,
			totalM3PerYear: 550_010.4
		});
		expect(m.lines.map((l) => [l.label, l.entitlement])).toEqual([
			['Licence', true],
			['Registration (WARMS)', false],
			['Not recorded (the volume’s row is gone)', false]
		]);
		expect(m.lines[1]!.volume).toMatch(/^400.000 m³\/a$/);
		expect(m.total).toMatch(/^550.010 m³\/a$/);
		expect(m.entitlement).toMatch(/^150.000 m³\/a$/);
		expect(m.leftOut).toBeNull();
	});

	it('words a folded mix: the pooled row, a row with the others merged in, and who is left out, counted only at 5 or more (evidence-17, #523 G1)', () => {
		const m = mixLines({
			rows: [
				{ authorisation: 'registration', volumeM3PerYear: 500, entitlement: false },
				{ authorisation: 'existing_lawful_use_claimed', volumeM3PerYear: 160, entitlement: false, withOthers: true },
				{ authorisation: 'other', volumeM3PerYear: 108, entitlement: false }
			],
			entitlementM3PerYear: 0,
			totalM3PerYear: 768,
			folded: true,
			leftOutHolders: 6
		});
		expect(m.lines.map((l) => l.label)).toEqual([
			'Registration (WARMS)',
			'Existing lawful use (claimed, not verified), with the ways of holding too few hold to show',
			'Other ways of holding (each held by fewer than 5 registered users)'
		]);
		expect(m.leftOut).toBe('6 registered users’ volumes are left out: no line gives fewer than 5 registered users’ volume.');
		expect(mixLines({ rows: [], entitlementM3PerYear: 0, totalM3PerYear: 0, folded: true, someLeftOut: true }).leftOut).toMatch(/^Some registered users’ volumes are left out/);
	});

	it('words a share-only folded mix (evidence-18, #523 H/J): each line a whole percent, the total 100 %, no m³', () => {
		const m = mixLines({
			rows: [
				{ authorisation: 'licence', sharePct: 59, entitlement: true },
				{ authorisation: 'existing_lawful_use', sharePct: 41, entitlement: false, withOthers: true }
			],
			entitlementPct: 59,
			folded: true,
			shares: true,
			leftOutHolders: 6
		});
		expect(m.shares).toBe(true);
		expect(m.lines.map((l) => [l.label, l.volume, l.entitlement])).toEqual([
			['Licence', '59 %', true],
			['Existing lawful use (verified under s35), with the ways of holding too few hold to show', '41 %', false]
		]);
		expect([m.total, m.entitlement]).toEqual(['100 %', '59 %']);
		expect(JSON.stringify(m)).not.toContain('m³');
		expect(mixLines({ rows: [], entitlementPct: 0, folded: true, shares: true, someLeftOut: true }).total).toBe('0 %');
	});
});
