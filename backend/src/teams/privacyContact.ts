// A team's privacy contact (168_team_privacy_contact; POPIA s18(1)(b); docs/api.md
// § Teams and § Farm, docs/security.md § Personal information): who a member or
// a farmer asks about the personal information in the team's projects. The team
// is the responsible party for project data, so its contact, not the
// operator's, answers for it. The schema and the mapping are pure (unit-tested apart from the routes).
import { z } from 'zod';
import type { Db } from '../db/tx.js';

/** What an admin sends: a name and an email address, a postal address optional. Blank postal = none. */
export const PrivacyContactInput = z
	.object({
		name: z.string().trim().min(1).max(200),
		email: z.string().trim().max(254).email(),
		postal: z
			.string()
			.trim()
			.max(500)
			.nullish()
			.transform((s) => (s ? s : null))
	})
	.strict();
export type PrivacyContactInput = z.infer<typeof PrivacyContactInput>;

/** The contact as the API returns it: null when the team has set none. */
export interface PrivacyContact {
	name: string;
	email: string;
	postal: string | null;
}

/** The contact from team's three columns (NULL name = not set). */
export function toPrivacyContact(row: { privacy_contact_name: string | null; privacy_contact_email: string | null; privacy_contact_postal: string | null }): PrivacyContact | null {
	if (!row.privacy_contact_name || !row.privacy_contact_email) return null;
	return { name: row.privacy_contact_name, email: row.privacy_contact_email, postal: row.privacy_contact_postal };
}

/** A project's contact, as the farm view and invitation emails name it: the team's name and its contact. */
export interface ProjectPrivacyContact extends PrivacyContact {
	organisation: string;
}

/**
 * The project's team's contact, for anyone with a role on the project (app_project_privacy_contact, a definer
 * function: a farmer can't read the team row). null without a team, without a contact, or without a role.
 */
export async function projectPrivacyContact(db: Db, projectId: string): Promise<ProjectPrivacyContact | null> {
	const { rows } = await db.query<ProjectPrivacyContact>('SELECT organisation, name, email, postal FROM app_project_privacy_contact($1)', [projectId]);
	return rows[0] ?? null;
}
