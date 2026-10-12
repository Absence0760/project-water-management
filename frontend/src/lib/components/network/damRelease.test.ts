// The dam release rule's wording (issue #507): pass inflow with no monthly
// amounts releases water for the EWR and keeps the unit's pump, river
// abstractions and off-takes off that flow, which only a scenario may do
// (issue #523 B4), so the baseline's pass inflow keeps a set flow and the
// hint says so plainly. The browser
// flow is e2e/tests/dam-storage.spec.ts.
import { describe, expect, it } from 'vitest';
import { RULE_LABEL, releaseHint } from './damRelease';

describe('dam release rule wording', () => {
	it('labels pass inflow as keeping a set flow below the dam (the EWR is a scenario’s)', () => {
		expect(RULE_LABEL.passInflow).toBe('Pass inflow: keep a set flow in the river below');
		expect(RULE_LABEL.passInflow).not.toContain('EWR');
	});

	it('with the EWR as the target, says it releases water for the EWR, what else leaves that flow, and that only a scenario keeps it', () => {
		const h = releaseHint('passInflow', true);
		expect(h).toMatch(/^This releases water for the EWR: /);
		expect(h).toContain("This unit's river pump, river abstractions and river off-takes leave that flow in the river too.");
		expect(h).toContain('Only a scenario keeps the EWR: untick it to give the monthly flow to keep below the dam.');
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
