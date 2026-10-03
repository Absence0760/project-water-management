import { describe, expect, it } from 'vitest';
import { cleanName, nameProblemKind, workspaceNameProblem } from './visibleName';

// The same cases as the server's rule (backend/src/http/visibleName.test.ts).
describe('visibleName', () => {
	it('cleans a name as the server stores it', () => {
		expect(cleanName('  Upper\n\tBerg ')).toBe('Upper Berg');
		expect(cleanName('Berg‮nimda')).toBe('Bergnimda');
		expect(cleanName('⁦Ann⁩')).toBe('Ann');
		// Joiners and the plain direction marks stay.
		expect(cleanName('می‌خواهم')).toBe('می‌خواهم');
		expect(cleanName('‏שרה')).toBe('‏שרה');
	});

	it('calls a name that would show as nothing blank, and counts the length after cleaning', () => {
		for (const blank of ['', '   ', '​', '​‍', '‮', '⁦⁩', '́']) expect(nameProblemKind(blank, 200), JSON.stringify(blank)).toBe('blank');
		expect(nameProblemKind('x'.repeat(200), 200)).toBeNull();
		expect(nameProblemKind(`${'x'.repeat(200)}‮`, 200)).toBeNull();
		expect(nameProblemKind('x'.repeat(201), 200)).toBe('long');
	});

	it('words a team or project name problem for the workspace', () => {
		expect(workspaceNameProblem('Bergrivier 🌊', 'project')).toBeNull();
		expect(workspaceNameProblem('​', 'project')).toBe('The project needs a name.');
		expect(workspaceNameProblem('‮⁦', 'team')).toBe('The team needs a name.');
		expect(workspaceNameProblem('x'.repeat(201), 'team')).toBe('Use at most 200 characters for the team’s name.');
	});
});
