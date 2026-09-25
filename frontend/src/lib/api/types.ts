// Wire shapes from docs/api.md that aren't in @water-management/engine.
import type {
	EnsembleHeader,
	EnsembleRequest,
	EnsembleSummary,
	InputChange,
	MemberResult,
	PairedMember,
	PairedSummary,
	ProjectSettings,
	RecordCoverage,
	ResolvedEnsembleOptions,
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

/**
 * Team roles, lowest first: on every team project a viewer is a viewer, a
 * member an editor and an admin an owner (docs/data-model.md § Teams).
 */
export type TeamRole = 'viewer' | 'member' | 'admin';
export const TEAM_ROLES: readonly TeamRole[] = ['viewer', 'member', 'admin'];

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
	/** settings.runoffModel === 'legacy' (audit H1): workbook comparison only, not evidence. */
	legacy: boolean;
	/**
	 * The modeller's written explanation of the run ('' = none), e.g. why a
	 * WR2012 flag stands. The one thing about a run an editor may change
	 * (PATCH …/runs/:runId). Absent from an older API.
	 */
	notes?: string;
	/** When and by whom (display name) the notes last changed; null = never written. */
	notesUpdatedAt?: string | null;
	notesUpdatedBy?: string | null;
	/** settings.runoffModel the run used ('gr4j', 'legacy', …; absent → legacy). Absent from an older API. */
	runoffModel?: string;
	/**
	 * The run's place in the evidence history (010_run_nomination): 'current'
	 * is the project's nominated evidence run, 'past' was nominated and since
	 * replaced, null never nominated. Absent from an older API.
	 */
	evidence?: EvidenceStatus | null;
}

/** Longest run note, in characters (backend RUN_NOTES_MAX, 007_run_notes.sql). */
export const RUN_NOTES_MAX = 4000;

export type EvidenceStatus = 'current' | 'past';

/** One row of a project's evidence history (GET …/evidence, oldest first; the last is current). */
export interface Nomination {
	id: string;
	runId: string;
	runLabel: string;
	runCreatedAt: string;
	/** Copied from the run when it was nominated. */
	runoffModel: string;
	engineVersion: string;
	reason: string;
	nominatedAt: string;
	nominatedBy: string | null;
}

/**
 * One uncertainty ensemble of a run (GET …/runs/:runId/uncertainty, docs/api.md
 * § Uncertainty bands). `baselineId` set = a paired band on the difference from
 * that run. `summary` is null until the result is stored.
 */
export interface Ensemble {
	id: string;
	runId: string;
	baselineId: string | null;
	baselineRunId: string | null;
	runoffModel: string;
	engineVersion: string;
	method: string;
	seed: number;
	members: number;
	options: ResolvedEnsembleOptions;
	status: 'started' | 'complete';
	accepted: number | null;
	summary: EnsembleSummary | PairedSummary | null;
	createdAt: string;
	createdBy: string | null;
	createdById: string;
	completedAt: string | null;
}

/** An ensemble with what it was built from (GET …/uncertainty/:uid). */
export interface EnsembleDetail extends Ensemble {
	result:
		| { engineVersion: string; header: EnsembleHeader; members: MemberResult[]; coverage: RecordCoverage[] }
		| { engineVersion: string; header: EnsembleHeader; members: PairedMember[] }
		| null;
}

/** What POST …/uncertainty takes: the options to resolve, or the baseline of a paired band. */
export type EnsembleStart = { request: Omit<EnsembleRequest, 'model' | 'seed'> } | { baselineId: string };

/** Longest nomination reason, in characters (backend NOMINATION_REASON_MAX, 010_run_nomination.sql). */
export const NOMINATION_REASON_MAX = 2000;

/** One run's place in the evidence history, as compare returns it for each side. */
export interface RunEvidence {
	status: EvidenceStatus;
	nominatedAt: string;
	nominatedBy: string | null;
	reason: string;
	replacedBy: { runId: string; runLabel: string; nominatedAt: string; nominatedBy: string | null; reason: string } | null;
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
	kind: 'farm' | 'gauge' | 'user';
	/** Dam storage at the end of the day before (the run's initial storage on its first day); null for gauges. */
	previousStorageM3: number | null;
	/**
	 * Soil-water store at the end of the day before, mm (0 on the run's first
	 * day); null for gauges and runs from before engine 0.14.0. Absent from an
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
		damMinPct: number | null;
		irrigationEfficiency: number | null;
		lossReturnFraction: number | null;
		damAreaFullM2: number | null;
		damAreaExponent: number | null;
		damSeepagePerDay: number | null;
	};
	columns: { key: string; label: string; unit: string | null; value: number | null }[];
}

/** GET …/runs/:runId/day without a nodeId: the catchment's runoff-model day (docs/api.md). */
export interface RunCatchmentDay {
	date: string;
	nodeId: null;
	name: string;
	kind: 'catchment';
	/** 'legacy' for a run without a runoff balance (no stores to trace). */
	runoffModel: string;
	/** Area the mm are spread over; null for a legacy run. */
	areaKm2: number | null;
	/** The runoff model's parameters as the run used them (GR4J: x1 … x4, warmupDays); null for a legacy run. */
	params: Record<string, number> | null;
	/** Σ stores at the end of the day before (the storage after the warm-up on the run's first day), mm. */
	previousStorageMm: number | null;
	/** Each store at the end of the day before, mm; each null on the run's first day. Null for a legacy run. */
	previousStores: Record<string, number | null> | null;
	columns: { key: string; label: string; unit: string | null; value: number | null }[];
}

/** One side of GET /compare/runs. */
export interface CompareSide {
	project: { id: string; name: string };
	/** `evidence` is null when the run was never nominated, absent from an older API. */
	run: Omit<Run, 'evidence'> & { inputs: RunInputsSnapshot; evidence?: RunEvidence | null };
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

const TEAM_RANK: Record<TeamRole, number> = { viewer: 0, member: 1, admin: 2 };

/**
 * True when team `role` is at least `min`. An unknown role is never enough, so
 * a role this build doesn't know about can't be treated as a member.
 */
export function hasTeamRole(role: TeamRole | string | undefined | null, min: TeamRole): boolean {
	return role != null && Object.hasOwn(TEAM_RANK, role) && TEAM_RANK[role as TeamRole] >= TEAM_RANK[min];
}
