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
	});
});
