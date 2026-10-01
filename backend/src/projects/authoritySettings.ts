// The project's responsible authority (161_licensing_authority; provisional
// position, pre-counsel research, 2026-10-01: docs/scenarios.md
// § Applications "Who decides", docs/api.md § Projects). Under the National
// Water Act only the responsible authority decides a licence: DWS (a
// regional office), or a catchment management agency the power is assigned
// or delegated to (s1, s40(1), s41, s42). A licensing project names it in
// settings.responsibleAuthority; the owner marks the members who act for it
// (project_member.acts_for_authority), and only they record its decision on
// an application or endorse a published baseline.
//
// Like settings.outcomes and settings.outlook it is **no model input**: runs
// don't record it (runs/execute.ts), and saving it alone leaves updated_at
// alone (projects/routes.ts).
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

export const AUTHORITY_KINDS = ['dws', 'cma'] as const;
export type AuthorityKind = (typeof AUTHORITY_KINDS)[number];

export interface ResponsibleAuthority {
	/** As the authority calls itself, e.g. "Breede-Olifants CMA". */
	name: string;
	/** dws: the Department of Water and Sanitation (the Minister); cma: a catchment management agency with the power. */
	kind: AuthorityKind;
	/** The office that handles the project's applications ('' = not given), e.g. "Bellville regional office". */
	office: string;
}

const Authority = z
	.object({
		name: z.string().trim().min(1, 'name the responsible authority').max(200),
		kind: z.enum(AUTHORITY_KINDS),
		office: z.string().trim().max(200).default('')
	})
	.strict();

/** The settings patch's shape for `responsibleAuthority` (projects/settings.ts): the whole authority, or null to clear it. */
export const ResponsibleAuthorityPatch = Authority.nullable();

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** settings.responsibleAuthority, or null when the project names none (or what is stored isn't valid). */
export function resolveResponsibleAuthority(settings: unknown): ResponsibleAuthority | null {
	const parsed = Authority.safeParse(isObj(settings) ? settings.responsibleAuthority : undefined);
	return parsed.success ? parsed.data : null;
}

/** The project's responsible authority, read under the caller's RLS. */
export async function projectAuthority(db: Db, projectId: string): Promise<ResponsibleAuthority | null> {
	const { rows } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [projectId]);
	return resolveResponsibleAuthority(rows[0]?.settings);
}

/** Whether the current user acts for the project's authority: editor or above, and marked by an owner (app_acts_for_authority, 161). */
export async function actsForAuthority(db: Db, projectId: string): Promise<boolean> {
	const { rows } = await db.query<{ ok: boolean }>('SELECT app_acts_for_authority($1) AS ok', [projectId]);
	return rows[0]?.ok === true;
}

/** 403 unless the current user acts for the project's authority; call after requireRole(…, 'editor'). */
export async function requireActsForAuthority(db: Db, projectId: string): Promise<void> {
	if (!(await actsForAuthority(db, projectId)))
		throw new ApiError(403, 'only a member the project’s owner marks as acting for the responsible authority may do this (members, actsForAuthority)');
}
