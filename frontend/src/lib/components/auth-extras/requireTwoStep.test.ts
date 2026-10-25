import { describe, expect, it } from 'vitest';
import { ACCOUNT_TWO_STEP, inheritedText, requirementText, turnOnHint } from './requireTwoStep';

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
		const hint = turnOnHint(false, false)!;
		expect(hint.before + hint.link + hint.after).toBe('To turn it on, sign in with a code first (set up two-step sign-in on your Account page), so it can’t lock everyone out.');
		expect(turnOnHint(false, true)).toBeNull();
		expect(turnOnHint(false, null)).toBeNull();
		// Turning it off needs no warning: the server steps it up under the setting.
		expect(turnOnHint(true, false)).toBeNull();
	});

	it('links “Account page” to its Two-step sign-in panel, not a dead end (issue #586)', () => {
		expect(turnOnHint(false, false)!.link).toBe('Account page');
		// The panel's id on the Account page (account/TwoStepSignIn.svelte), where the page lands on it.
		expect(ACCOUNT_TWO_STEP).toBe('account#two-step');
	});
});
