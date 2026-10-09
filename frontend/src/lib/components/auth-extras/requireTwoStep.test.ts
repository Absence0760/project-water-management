import { describe, expect, it } from 'vitest';
import { inheritedText, requirementText, turnOnHint } from './requireTwoStep';

describe('the two-step requirement switch’s words (204_mfa_opt_in)', () => {
	it('says in plain words what it does, for a project and a team', () => {
		expect(requirementText('project')).toMatch(/^Members who manage this project need two-step sign-in/);
		expect(requirementText('team')).toMatch(/^Members who manage this team need two-step sign-in/);
	});

	it('says when the team requires it and the project’s own switch is off, naming the team when it can', () => {
		expect(inheritedText(false, true, 'Upper WUA')).toBe('Its team, Upper WUA, requires two-step sign-in for every team project, whatever this says.');
		expect(inheritedText(false, true, null)).toBe('Its team requires two-step sign-in for every team project, whatever this says.');
		// Its own switch on, or nothing requiring it: nothing to add.
		expect(inheritedText(true, true, 'Upper WUA')).toBeNull();
		expect(inheritedText(false, false, 'Upper WUA')).toBeNull();
	});

	it('warns before turning it on only when this session is known to have signed in without a code', () => {
		expect(turnOnHint(false, false)).toMatch(/sign in with a code first/);
		expect(turnOnHint(false, true)).toBeNull();
		expect(turnOnHint(false, null)).toBeNull();
		// Turning it off needs no warning: the server steps it up under the setting.
		expect(turnOnHint(true, false)).toBeNull();
	});
});
