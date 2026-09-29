/**
 * How roles read in the UI (issue #162 item 27). The API keeps two sets of
 * values, project roles (`viewer` / `editor` / `owner`, plus `farmer` and
 * `contributor`) and team roles (`viewer` / `member` / `admin`), but a team
 * role *is* a project role on every team project (docs/data-model.md § Teams),
 * so people see one set of names everywhere: Viewer, Editor, Owner. A team
 * `member` shows as an editor and a team `admin` as an owner. Only the words
 * change; the stored and sent values stay as they are.
 */
import type { Role, TeamRole } from './types';

/** Every role value the API sends, project and team alike, as people read it (lower case, for use mid-sentence). */
export const ROLE_LABEL: Readonly<Record<Role | TeamRole, string>> = {
	farmer: 'farmer',
	contributor: 'applicant',
	viewer: 'viewer',
	editor: 'editor',
	owner: 'owner',
	member: 'editor',
	admin: 'owner'
};

/**
 * A role value, project or team, as people read it. A value this build
 * doesn't know (a newer API) shows as sent rather than disappearing.
 */
export function roleLabel(role: string | null | undefined): string {
	if (role == null) return '';
	return Object.hasOwn(ROLE_LABEL, role) ? ROLE_LABEL[role as Role | TeamRole] : role;
}

/** The same with a capital, for a heading, a list term or the start of a sentence. */
export function roleTitle(role: string | null | undefined): string {
	const label = roleLabel(role);
	return label.charAt(0).toUpperCase() + label.slice(1);
}
