// A person's own display preferences (083_user_preferences.sql): the
// workspace sections they hid from their sidebar today. One jsonb document
// per account, own row only under RLS. PATCH /auth/me { preferences } merges
// the keys sent into it; GET /auth/me returns it on the user.
import { z } from 'zod';
import type { Db } from '../db/tx.js';

/**
 * A workspace section's `?tab=` id (frontend lib/workspace/tabs.ts). Not an
 * enum of today's ids: a renamed or retired section then just stops
 * matching, instead of making the stored document invalid.
 */
const tabId = z.string().regex(/^[a-z][a-z-]{0,31}$/);

/** At most this many hidden sections (there are 16 today). */
export const MAX_HIDDEN_TABS = 32;

/** What a PATCH may set. Unknown keys are refused, so the document can't collect junk. */
export const PreferencesPatch = z
	.object({
		/** The sections hidden from the sidebar; [] shows them all again ("Reset to default"). */
		hiddenTabs: z
			.array(tabId)
			.max(MAX_HIDDEN_TABS)
			.transform((ids) => [...new Set(ids)])
	})
	.partial()
	.strict();
export type PreferencesPatch = z.infer<typeof PreferencesPatch>;

export interface Preferences {
	hiddenTabs: string[];
}

/** The stored document as the API returns it: every key present, anything malformed dropped. */
export function toPreferences(doc: unknown): Preferences {
	const d = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
	const hidden = tabId.array().safeParse(d.hiddenTabs);
	return { hiddenTabs: hidden.success ? hidden.data : [] };
}

/**
 * The column expression for a query over app_user: the person's preferences
 * document, or {} when they never saved one. Readable for their own row only
 * (user_preferences' policy), so for anyone else it is {}.
 */
export const PREFERENCES_COL =
	"coalesce((SELECT p.preferences FROM user_preferences p WHERE p.user_id = app_user.id), '{}'::jsonb) AS preferences";

/** Merges `patch` into the caller's document (creating it). Runs inside withUser. */
export async function savePreferences(db: Db, userId: string, patch: PreferencesPatch): Promise<void> {
	await db.query(
		`INSERT INTO user_preferences (user_id, preferences) VALUES ($1, $2::jsonb)
		 ON CONFLICT (user_id) DO UPDATE SET preferences = user_preferences.preferences || EXCLUDED.preferences, updated_at = now()`,
		[userId, JSON.stringify(patch)]
	);
}
