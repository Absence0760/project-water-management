// The server's rule for names people read (backend/src/http/visibleName.ts):
// a display name, a team's name, a project's name. Whitespace runs become one
// space, control characters and the bidi embedding/override/isolate controls
// are dropped, and what is left must hold a letter, digit, symbol or
// punctuation mark and fit the column. Checked here so a name of only
// invisible characters is refused in the form rather than as a bare 400.

/** The name as the server stores it. */
export const cleanName = (raw: string): string => raw.replace(/\s+/g, ' ').replace(/[\p{Cc}‪-‮⁦-⁩]/gu, '').trim();

/** What is wrong with `raw` as a name of at most `max` characters: 'blank' (nothing visible), 'long', or null. */
export function nameProblemKind(raw: string, max: number): 'blank' | 'long' | null {
	const clean = cleanName(raw);
	if (!/[\p{L}\p{N}\p{S}\p{P}]/u.test(clean)) return 'blank';
	if (clean.length > max) return 'long';
	return null;
}

/** Team and project names: 1–200 characters (the columns' checks). */
export const TEAM_PROJECT_NAME_MAX = 200;

/** The workspace's message for a team or project name (the workspace is English), or null when it is fine. */
export function workspaceNameProblem(raw: string, what: 'team' | 'project'): string | null {
	const kind = nameProblemKind(raw, TEAM_PROJECT_NAME_MAX);
	if (kind === 'blank') return `The ${what} needs a name.`;
	if (kind === 'long') return `Use at most ${TEAM_PROJECT_NAME_MAX} characters for the ${what}’s name.`;
	return null;
}
