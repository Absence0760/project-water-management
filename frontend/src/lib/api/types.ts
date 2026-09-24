// Wire shapes from docs/api.md that aren't in @water-management/engine.
import type {
	InputChange,
	ProjectSettings,
	RunComparison,
	RunInputsSnapshot,
	RunSummary
} from '@water-management/engine';

export type Role = 'viewer' | 'editor' | 'owner';
export const ROLES: readonly Role[] = ['viewer', 'editor', 'owner'];

export interface User {
	id: string;
	email: string;
	displayName: string;
	/** False until the address is confirmed via the emailed link (VerifyEmailBanner). */
	emailVerified?: boolean;
}

/**
 * The team a project belongs to. `name` is null when you reach the project by
 * direct sharing but aren't in its team (team names are private to members).
 */
export interface ProjectTeam {
	id: string;
	name: string | null;
}

export interface ProjectSummary {
	id: string;
	name: string;
	description: string | null;
	role: Role;
	/** null = a personal project (owned by its direct members only). */
	team: ProjectTeam | null;
	createdAt: string;
	updatedAt: string;
	/** Last day any of the project's time series covers (YYYY-MM-DD), or null with no data. */
	dataUntil: string | null;
	/** ISO timestamp of the newest run, or null. */
	lastRunAt: string | null;
}

export interface Project extends ProjectSummary {
	settings: ProjectSettings;
}

export interface Member {
	userId: string;
	email: string;
	displayName: string;
	role: Role;
}

/** Team roles: admins are owners of every team project, members are editors. */
export type TeamRole = 'member' | 'admin';
export const TEAM_ROLES: readonly TeamRole[] = ['member', 'admin'];

export interface Team {
	id: string;
	name: string;
	/** Your role in the team. */
	role: TeamRole;
	createdAt: string;
	memberCount: number;
	projectCount: number;
}

export interface TeamMember {
	userId: string;
	email: string;
	displayName: string;
	role: TeamRole;
}

/** A pending invitation for an address that has no account yet (docs/api.md § Invites). */
export interface Invite {
	id: string;
	email: string;
	role: string;
	/** Display name of whoever (re-)sent it. */
	invitedBy: string;
	createdAt: string;
	expiresAt: string;
	expired: boolean;
}

/** What an invite link is for (POST /auth/invite-info). */
export interface InviteInfo {
	email: string;
	projectName: string | null;
	teamName: string | null;
	invitedBy: string;
}

/** POST …/members answers with a member (existing account) or an invite (no account yet). */
export type AddMemberResult<M> =
	| { member: M; invited?: undefined; invite?: undefined }
	| { invited: true; invite: Invite; member?: undefined };

export interface RunMeta {
	id: string;
	label: string | null;
	engineVersion: string;
	startDate: string;
	endDate: string;
	createdAt: string;
	createdBy: string | null;
}

export interface Run extends RunMeta {
	summary: RunSummary;
	/**
	 * The settings the run used (GET …/runs/:runId only): its fit record and
	 * calibration exclusions are the provenance of its parameters and scores.
	 */
	settings?: Partial<ProjectSettings> & Record<string, unknown>;
}

/** One output series available for a run (values fetched separately). */
export interface RunSeriesRef {
	nodeId: string | null;
	key: string;
	label: string;
	unit: string;
}

/** GET …/runs/:runId/day: one node's columns on one day, for the day trace. */
export interface RunDay {
	date: string;
	nodeId: string;
	name: string;
	kind: 'farm' | 'gauge';
	/** Dam storage at the end of the day before (the run's initial storage on its first day); null for gauges. */
	previousStorageM3: number | null;
	/**
	 * Soil-water store at the end of the day before, mm (0 on the run's first
	 * day); null for gauges and runs from before engine 0.15.0. Absent from an
	 * older API.
	 */
	previousSoilWaterMm?: number | null;
	/** The node's parameters as the run used them. */
	params: {
		pctUpstreamToDam: number | null;
		pctRunoffToDam: number | null;
		divertCapacityM3Day: number | null;
		damCapacityM3: number | null;
		damInitialPct: number | null;
		returnFlowPct: number | null;
	};
	columns: { key: string; label: string; unit: string | null; value: number | null }[];
}

/** One side of GET /compare/runs. */
export interface CompareSide {
	project: { id: string; name: string };
	run: Run & { inputs: RunInputsSnapshot };
}

/** GET /compare/runs response (docs/api.md § Compare runs). Deltas are b − a. */
export interface RunCompareResponse {
	a: CompareSide;
	b: CompareSide;
	comparison: RunComparison;
	changes: InputChange[];
	/** Catchment series both runs stored with the same unit. */
	catchmentSeries: { key: string; label: string; unit: string }[];
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

/** True when `role` is at least `min`. */
export function hasRole(role: Role | undefined | null, min: Role): boolean {
	return role != null && RANK[role] >= RANK[min];
}
