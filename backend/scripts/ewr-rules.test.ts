// list:ewr-rules (issue #507): reads a project document's model and settings
// and reports the rules that move water for the EWR. The rule-by-rule cases
// are packages/engine's ewrReleaseRules.test.ts; this covers the file side.
import { defaultProjectSettings, newNetworkNode } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { rulesOf, toText } from './ewr-rules';

const nodes = () => [{ ...newNetworkNode('a', 0, 'g'), name: 'Upper', damCapacityM3: 1000 }, { ...newNetworkNode('g', 1, null), name: 'Outlet' }];

describe('list:ewr-rules', () => {
	it('an export with every rule at its default reports none', () => {
		const doc = { format: 'water-management/project', version: 1, name: 'x', settings: defaultProjectSettings(), model: { nodes: nodes(), crops: [], cropAreas: [], transfers: [] }, series: [] };
		const rules = rulesOf(doc);
		expect(rules).toEqual([]);
		expect(toText(rules, 'export.json')).toMatch(/^export\.json: no rule moves water for the EWR/);
	});

	it('positive control: a switched-on rule is reported, and a document without transfers or settings still reads', () => {
		const doc = { model: { nodes: [{ ...nodes()[0], damReleaseRule: 'passInflow' }, nodes()[1]] } };
		const rules = rulesOf(doc);
		expect(rules.map((r) => r.kind)).toEqual(['damPassInflow']);
		expect(toText(rules, 'p.json')).toBe('p.json: 1 rule switched on, 1 of 1 runs as stored:\n- unit "Upper": dam release: pass inflow, keeps the EWR required there\n');
	});

	it('refuses a file that is not a project document', () => {
		expect(() => rulesOf({ runs: [] })).toThrow(/not a project document/);
		expect(() => rulesOf(null)).toThrow(/not a project document/);
	});
});
