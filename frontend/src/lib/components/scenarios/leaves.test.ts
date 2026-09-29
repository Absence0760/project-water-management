import { describe, expect, it } from 'vitest';
import { leavesScenario, leavesScenariosTab } from './leaves';

const u = (s: string) => new URL(s, 'http://app.test');
const from = u('/projects/p1?tab=scenarios&scenario=s1');

describe('leavesScenario', () => {
	it('another scenario, tab or page leaves; another parameter stays', () => {
		expect(leavesScenario(from, u('/projects/p1?tab=scenarios&scenario=s2'))).toBe(true);
		expect(leavesScenario(from, u('/projects/p1?tab=network'))).toBe(true);
		expect(leavesScenario(from, u('/'))).toBe(true);
		expect(leavesScenario(from, u('/projects/p1?tab=scenarios&scenario=s1&new=1'))).toBe(false);
	});
});

describe('leavesScenariosTab', () => {
	it('another tab or page leaves; another scenario stays', () => {
		expect(leavesScenariosTab(from, u('/projects/p1?tab=runs'))).toBe(true);
		expect(leavesScenariosTab(from, u('/teams'))).toBe(true);
		expect(leavesScenariosTab(from, u('/projects/p1?tab=scenarios&scenario=s2'))).toBe(false);
	});
});
