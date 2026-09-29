import { describe, expect, it } from 'vitest';
import { destinationName } from './destination';

const u = (s: string) => new URL(s, 'http://app.test');
const from = u('/projects/p1?tab=network');

describe('destinationName', () => {
	it('names the app’s pages as the sidebar does', () => {
		expect(destinationName(from, u('/'))).toBe('All projects');
		expect(destinationName(from, u('/teams'))).toBe('Teams');
		expect(destinationName(from, u('/teams/t1'))).toBe('the team’s page');
		expect(destinationName(from, u('/help/guides/x'))).toBe('Help');
		expect(destinationName(from, u('/account'))).toBe('your account');
		expect(destinationName(from, u('/somewhere'))).toBe('another page');
	});
	it('within the project, names the section; another project is another project', () => {
		expect(destinationName(from, u('/projects/p1'))).toBe('the Summary page');
		expect(destinationName(from, u('/projects/p1?tab=crops'))).toBe('the Crops & demand page');
		expect(destinationName(from, u('/projects/p1?tab=results'))).toBe('the Runs & results page');
		expect(destinationName(from, u('/projects/p2?tab=crops'))).toBe('another project');
	});
	it('another scenario, from the Scenarios tab', () => {
		const sc = u('/projects/p1?tab=scenarios&scenario=a');
		expect(destinationName(sc, u('/projects/p1?tab=scenarios&scenario=b'))).toBe('another scenario');
	});
	it('strips the base path', () => {
		expect(destinationName(u('/app/projects/p1'), u('/app/'), '/app')).toBe('All projects');
		expect(destinationName(u('/app/projects/p1'), u('/app/projects/p1?tab=dams'), '/app')).toBe('the Dams page');
	});
});
