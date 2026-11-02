import { describe, expect, it } from 'vitest';
import { DEFAULT_START, newProjectPath, START_CHOICES } from './newProject';

describe('newProjectPath', () => {
	it('opens the guided way on the Map’s Start sheet, and the empty way on the Summary', () => {
		expect(newProjectPath('p1', 'map')).toBe('/projects/p1?tab=map&start=1');
		expect(newProjectPath('p1', 'network')).toBe('/projects/p1');
	});

	it('encodes the id, so it can never add a query or a path of its own', () => {
		expect(newProjectPath('a/b?c', 'map')).toBe('/projects/a%2Fb%3Fc?tab=map&start=1');
	});

	it('defaults to the guided way, which is one of the choices offered', () => {
		expect(DEFAULT_START).toBe('map');
		expect(START_CHOICES.map((c) => c.value)).toEqual(['map', 'network']);
	});
});
