// The baseline forms show the rules that keep water for the EWR as a
// scenario's (issue #523 B4): a unit's "Also leave the EWR in the river" and a
// dam's "Pass up to the EWR required here" are disabled while off, with the
// scenario-only note, and one already on can only be switched off. Choosing
// pass inflow starts from a set flow, not the EWR. Rendered with Svelte's
// server renderer; the browser flows are e2e/tests/supply.spec.ts and
// dam-storage.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { newNetworkNode, type NetworkNode } from '@water-management/engine';
import { EWR_SCENARIO_ONLY_NOTE, ewrSwitchDisabled } from './ewrScenarioOnly';
import DamStorageFields from './DamStorageFields.svelte';
import SupplyFields from './SupplyFields.svelte';

// The field history lines read the project's history through the app's API; nothing here needs it.
vi.mock('#lib/api/index.js', () => ({ api: {} }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));

/** The checkbox whose label follows it, as rendered. */
function box(html: string, label: string): string {
	const at = html.indexOf(label);
	expect(at, label).toBeGreaterThan(-1);
	const open = html.lastIndexOf('<input', at);
	return html.slice(open, html.indexOf('>', open) + 1);
}
const disabled = (tag: string) => /\sdisabled(?=[\s>=])/.test(tag);

const farm = (over: Partial<NetworkNode> = {}): NetworkNode => ({ ...newNetworkNode('f', 0, 'g'), name: 'Farm A', kind: 'farm', damCapacityM3: 10_000, ...over });

describe('ewrSwitchDisabled', () => {
	it('in the baseline lets an editor switch one off, never on; a viewer neither; Override mode both', () => {
		expect(ewrSwitchDisabled(false, false, true)).toBe(true);
		expect(ewrSwitchDisabled(false, true, true)).toBe(false);
		expect(ewrSwitchDisabled(true, true, true)).toBe(true);
		expect(ewrSwitchDisabled(false, false, false)).toBe(false);
		expect(ewrSwitchDisabled(true, false, false)).toBe(true);
	});
});

describe('a unit’s hands-off EWR (SupplyFields)', () => {
	const LABEL = 'Also leave the EWR in the river';

	it('is disabled while off, with the scenario-only note', () => {
		const html = render(SupplyFields, { props: { node: farm(), nodes: [farm()], readonly: false, baseline: true } }).body;
		expect(disabled(box(html, LABEL))).toBe(true);
		expect(html).toContain(EWR_SCENARIO_ONLY_NOTE);
	});

	it('one already on can be switched off', () => {
		const n = farm({ handsOffEwr: true });
		expect(disabled(box(render(SupplyFields, { props: { node: n, nodes: [n], readonly: false, baseline: true } }).body, LABEL))).toBe(false);
	});

	it('positive control: the set hands-off flow beside it stays editable', () => {
		const html = render(SupplyFields, { props: { node: farm(), nodes: [farm()], readonly: false, baseline: true } }).body;
		expect(disabled(box(html, 'Leave a set flow in the river, by month'))).toBe(false);
	});
});

describe('a dam’s pass-inflow release (DamStorageFields)', () => {
	const LABEL = 'Pass up to the EWR required here';

	it('with a set flow, the EWR target is disabled, with the scenario-only note', () => {
		const n = farm({ damReleaseRule: 'passInflow', damReleaseM3Day: new Array(12).fill(5) });
		const html = render(DamStorageFields, { props: { node: n, readonly: false, baseline: true } }).body;
		expect(disabled(box(html, LABEL))).toBe(true);
		expect(html).toContain(EWR_SCENARIO_ONLY_NOTE);
		expect(html).toContain('Flow to keep below the dam, m³/day, per month');
	});

	it('one stored with the EWR target can be switched to a set flow', () => {
		const n = farm({ damReleaseRule: 'passInflow', damReleaseM3Day: null });
		expect(disabled(box(render(DamStorageFields, { props: { node: n, readonly: false, baseline: true } }).body, LABEL))).toBe(false);
	});
});

describe('Override mode reuses the forms without `baseline` (issue #523 B4)', () => {
	it('the unit’s and the dam’s EWR switches work, with no scenario-only note', () => {
		const supply = render(SupplyFields, { props: { node: farm(), nodes: [farm()], readonly: false } }).body;
		expect(disabled(box(supply, 'Also leave the EWR in the river'))).toBe(false);
		expect(supply).not.toContain(EWR_SCENARIO_ONLY_NOTE);
		const n = farm({ damReleaseRule: 'passInflow', damReleaseM3Day: new Array(12).fill(5) });
		const dam = render(DamStorageFields, { props: { node: n, readonly: false } }).body;
		expect(disabled(box(dam, 'Pass up to the EWR required here'))).toBe(false);
		expect(dam).not.toContain(EWR_SCENARIO_ONLY_NOTE);
	});
});
