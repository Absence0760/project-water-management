// The dam release rule's wording (issue #507): pass inflow with no monthly
// amounts releases water for the EWR and keeps the unit's pump, river
// abstractions and off-takes off that flow, which a baseline of the river as
// used today normally doesn't want, so the hint says so plainly. The browser
// flow is e2e/tests/dam-storage.spec.ts.
import { describe, expect, it } from 'vitest';
import { RULE_LABEL, releaseHint } from './damRelease';

describe('dam release rule wording', () => {
	it('labels pass inflow as a release for the river below', () => {
		expect(RULE_LABEL.passInflow).toBe('Pass inflow: release for the river below (the EWR unless amounts are set)');
	});

	it('with the EWR as the target, says it releases water for the EWR, what else leaves that flow, and that a baseline leaves it off', () => {
		const h = releaseHint('passInflow', true);
		expect(h).toMatch(/^This releases water for the EWR: /);
		expect(h).toContain("This unit's river pump, river abstractions and river off-takes leave that flow in the river too.");
		expect(h).toContain('Release rules are off by default and no import sets one, so a baseline of the river as used today normally leaves this at None.');
	});

	it('with monthly amounts, names the pump, abstractions and off-takes but not the EWR', () => {
		const h = releaseHint('passInflow', false);
		expect(h).not.toContain('EWR');
		expect(h).toContain("up to the month's flow to keep below the dam");
		expect(h).toContain('river off-takes leave that flow in the river too');
	});

	it('says nothing about the EWR for a fixed release or none', () => {
		expect(releaseHint('fixed', false)).not.toContain('EWR');
		expect(releaseHint('none', false)).toContain('pick a rule to model one');
	});
});
