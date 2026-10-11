// The scenario page's note for a base run that still keeps the EWR (issue #523 B4).
import { describe, expect, it } from 'vitest';
import { baseEwrRulesLead } from './baseEwrRules';

describe('baseEwrRulesLead', () => {
	it('says the base run, not the scenario, keeps the EWR, in the singular and the plural', () => {
		expect(baseEwrRulesLead(1)).toMatch(/^The base run carries a rule that keeps water for the EWR.*runs with it without a change of its own.*without it:$/);
		expect(baseEwrRulesLead(3)).toMatch(/^The base run carries 3 rules that keep water for the EWR.*runs with them.*without them:$/);
	});
});
