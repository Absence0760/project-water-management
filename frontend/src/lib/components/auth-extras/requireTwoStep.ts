// The words around a project's or team's "Require two-step sign-in" switch
// (204_mfa_opt_in; docs/security.md § Two-step sign-in, docs/ui.md). Opt-in
// since the operator's decision of 2026-10-08: off by default, an owner (a
// team admin) turns it on. Pure, so the words are tested without a page.
// English only: the project and team pages are the workspace.

export type TwoStepScope = 'project' | 'team';

/** What the switch does, in plain words. */
export function requirementText(scope: TwoStepScope): string {
	return scope === 'project'
		? 'Members who manage this project need two-step sign-in: its owners give a code (from an authenticator app or by email) when they sign in before they manage members, invites, share links, API keys or data feeds, or delete the project, and so does anyone who signs a run.'
		: 'Members who manage this team need two-step sign-in: its admins give a code (from an authenticator app or by email) when they sign in before they manage the team or its members, and before an owner’s actions on every team project.';
}

/** The actions that need it whatever the switch says (they reach farmers, the public or a licence decision). */
export const ALWAYS_TEXT = 'Publishing to farmers, deciding applications, endorsing a baseline and signing or issuing an evidence pack always need it, whatever this says.';

/**
 * A project's note when its team requires it (`mfaRequired` without its own
 * `requireMfa`): the switch here can't lift it. Null otherwise. `teamName`
 * is null for someone shared the project directly, who can't see the team.
 */
export function inheritedText(own: boolean, effective: boolean, teamName: string | null): string | null {
	if (own || !effective) return null;
	return `${teamName ? `Its team, ${teamName},` : 'Its team'} requires two-step sign-in for every team project, whatever this says.`;
}

/**
 * Why turning it on would be refused, said before the switch is used: the
 * person turning it on must be signed in with a second factor, so it can't
 * lock everyone out. Null when it's on already, or when they are (or it
 * isn't known yet: the server still says so if it refuses). "Account page"
 * is a link to its Two-step sign-in panel, so the hint isn't a dead end.
 */
export function turnOnHint(on: boolean, sessionVerified: boolean | null): TurnOnHint | null {
	if (on || sessionVerified !== false) return null;
	return {
		before: 'To turn it on, sign in with a code first (set up two-step sign-in on your ',
		link: 'Account page',
		after: '), so it can’t lock everyone out.'
	};
}

/** The hint's words around its link to the Account page's two-step panel (ACCOUNT_TWO_STEP). */
export interface TurnOnHint {
	before: string;
	link: string;
	after: string;
}

/** Where the hint's link goes: the Account page's Two-step sign-in panel (account/TwoStepSignIn.svelte), resolved against the base path. */
export const ACCOUNT_TWO_STEP = 'account#two-step';
