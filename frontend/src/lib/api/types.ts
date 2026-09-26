// Wire shapes from docs/api.md that aren't in @water-management/engine.
import type {
	AppliedOp,
	CatchmentView,
	EnsembleHeader,
	EnsembleRequest,
	EnsembleSummary,
	InputChange,
	MemberResult,
	OpClass,
	PairedMember,
	PairedSummary,
	ProjectModel,
	ProjectSettings,
	RecordCoverage,
	ResolvedEnsembleOptions,
	RestrictionLevel,
	RunComparison,
	RunInputsSnapshot,
	RunSummary,
	ScenarioOp
} from '@water-management/engine';
import type { ImportNote, UnmappedItem } from '$lib/spreadsheet/import/report';

/**
 * Project roles, lowest first. `farmer` (WP-2.1) sits below viewer: a farmer
 * reads only the farms linked to them, and every workspace control that asks
 * for viewer or above hides itself (hasRole).
 */
export type Role = 'farmer' | 'viewer' | 'editor' | 'owner';
/** The roles a member can be given in the Members panel; farmers are managed apart (FarmersPanel). */
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
	/** ISO timestamp of the current publication (022_publication), or null before any. Every member sees it, farmers included. */
	publishedAt: string | null;
}

export interface Project extends ProjectSummary {
	settings: ProjectSettings;
}

/**
 * A portable project document: the body of POST /projects/import, as
 * GET /projects/:id/export.json writes it (plus informational keys the
 * server ignores) and the workbook importers produce. The server validates
 * it in full (backend/src/projects/document.ts).
 */
export interface ProjectFile {
	name: string;
	description?: string;
	settings?: Partial<ProjectSettings> & Record<string, unknown>;
	model: ProjectModel;
	series?: ProjectFileSeries[];
	[informational: string]: unknown;
}

export interface ProjectFileSeries {
	kind: string;
	name?: string;
	unit: string;
	startDate: string;
	values: (number | null)[];
}

/** POST /projects/import. `runId` / `runError` only when a run was asked for. */
export interface ImportResult {
	project: Project;
	runId?: string;
	/** Why the requested run failed; the project was still imported. */
	runError?: string;
}

/**
 * What the importer flagged, sent beside the document on POST /projects/import
 * (`importReport`) and kept with the project (017_project_import; docs/api.md §
 * Import report). The server caps every list and string
 * (backend/src/projects/importReport.ts); components/import/importReport.ts
 * trims to the same caps before sending.
 */
export interface ImportReport {
	source: 'b023-workbook' | 'project-file';
	fileName: string;
	/** Which importer (and engine) made the report. */
	importerVersion: string;
	notes: ImportNote[];
	unmapped: UnmappedItem[];
	/** Items found beyond what was kept. */
	notesOmitted: number;
	unmappedOmitted: number;
}

/** GET /projects/:id/import-report: the newest import's report, with who imported it and when. */
export interface StoredImportReport extends ImportReport {
	importedAt: string;
	/** The importer's display name. */
	importedBy: string;
}

export interface Member {
	userId: string;
	email: string;
	displayName: string;
	role: Role;
}

/** Someone who can read a farm's figures (GET /projects/:id/farm/:nodeId/access): names and roles, never emails. */
export interface FarmAccessPerson {
	displayName: string;
	role: Role;
	/** The caller. */
	you: boolean;
}

/** A farmer member and the farm nodes they may read (GET /projects/:id/farmers). */
export interface Farmer {
	userId: string;
	email: string;
	displayName: string;
	nodeIds: string[];
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
	/**
	 * Pinned by an editor (015_run_pinned): the storage cap never trims it and
	 * it can't be deleted until unpinned. Absent from an older API.
	 */
	pinned?: boolean;
	/** The project's current publication holds this run (022_publication, WP-2.3). Absent from an older API. */
	published?: boolean;
	/**
	 * The scenario that made the run (024_scenarios); null for a run of the
	 * live model, or once the scenario is deleted. Absent from an older API.
	 */
	scenarioId?: string | null;
	/** That scenario's name (the name the run recorded, once the scenario is deleted); null for a run of the model. */
	scenarioName?: string | null;
	/**
	 * What cites the run, so it is kept for good (no delete, no trim, no
	 * unpin): the publications that hold it and the scenarios based on it
	 * that you can see, oldest first. Absent from an older API.
	 */
	citedBy?: RunCitation[];
}

/**
 * One citation of a run (RunMeta.citedBy). For a publication, `name` is the
 * day it was published (YYYY-MM-DD, UTC). Evidence packs and assessments
 * (WP-3.13/3.14) will add kinds.
 */
export interface RunCitation {
	kind: 'publication' | 'scenario';
	id: string;
	name: string;
}

/** Most pinned runs per project (backend PINNED_RUNS_PER_PROJECT_MAX, 015_run_pinned.sql). */
export const PINNED_RUNS_MAX = 10;

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
	/**
	 * The model as the run used it (GET …/runs/:runId only): nodes, crops,
	 * crop areas, transfers, … The .xlsx workbook names its node sheets and
	 * fills its Inputs sheet from it. Absent from an older API.
	 */
	model?: { nodes?: { id: string; name: string }[] } & Record<string, unknown>;
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
	/** The scenario that made this side's run; null for a run of the model. Absent from an older API. */
	scenario?: CompareScenario | null;
}

/**
 * The scenario a compared run came from, as the run recorded it: the ops
 * exactly as applied and how each was classed (`classified[i]` is ops[i]'s).
 * `name` is the scenario's current name, or the recorded one once deleted.
 */
export interface CompareScenario {
	id: string;
	name: string;
	baseRunId: string;
	ops: ScenarioOp[];
	opsSha256: string;
	ownedNodeIds: string[];
	classified: OpClass[];
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

/** A scenario's place in its workflow (024_scenarios). Ops, owned nodes and base change only while `draft`. */
export type ScenarioStatus = 'draft' | 'submitted' | 'withdrawn' | 'decided';

/** Status changes the API allows (backend scenarios/schema.ts STATUS_MOVES). */
export const SCENARIO_STATUS_MOVES: Record<ScenarioStatus, readonly ScenarioStatus[]> = {
	draft: ['submitted'],
	submitted: ['withdrawn', 'decided'],
	withdrawn: ['draft'],
	decided: []
};

/** A scenario: named overrides on a base run (GET /projects/:id/scenarios, docs/api.md § Scenarios). */
export interface Scenario {
	id: string;
	name: string;
	description: string;
	baseRunId: string;
	/** The base run, for the "Based on run X" banner. */
	baseRun: { id: string; label: string; createdAt: string };
	ops: ScenarioOp[];
	/** SHA-256 of the ops as canonical JSON; a run of the scenario records the same hash. */
	opsSha256: string;
	/** The proposer's own nodes: ops on them are proposals, the rest baseline assumptions. */
	ownedNodeIds: string[];
	ownerUserId: string;
	/** The owner's display name. */
	owner: string | null;
	status: ScenarioStatus;
	createdAt: string;
	updatedAt: string;
	/** Runs of this scenario still stored, and the newest. */
	runCount: number;
	lastRun: { id: string; label: string; createdAt: string } | null;
}

/**
 * The scenario's ops applied to its base run: which applied (`applied[].index`
 * into ops, with notes on side effects), which don't (`problems`, one line
 * each, e.g. after a rebase) and how each is classed (`classified[i]`). Any
 * `baseline` means the red "Baseline assumptions changed" callout.
 */
export interface ScenarioCheck {
	applied: AppliedOp[];
	problems: string[];
	classified: OpClass[];
}

/**
 * GET / POST / PATCH …/scenarios/:sid answer. `check` is null (and
 * `checkError` says why) only when the base run can't be rebuilt.
 */
export interface ScenarioWithCheck {
	scenario: Scenario;
	check: ScenarioCheck | null;
	checkError: string | null;
}

const RANK: Record<Role, number> = { farmer: -1, viewer: 0, editor: 1, owner: 2 };

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

/** Longest publication note or notice, in characters (backend PUBLICATION_TEXT_MAX, 022_publication.sql). */
export const PUBLICATION_TEXT_MAX = 2000;

/** The WUA's restriction notice on a publication (docs/api.md § Publication). The WUA writes the words; the app never does. */
export interface PublicationRestriction {
	level: RestrictionLevel;
	/** 0–100 with two decimals; null for 'none' or when the notice gives none. */
	pct: number | null;
	noticeEn: string | null;
	noticeAf: string | null;
}

/** A publication's line in the history (GET …/publication). */
export interface PublicationMeta {
	id: string;
	runId: string;
	publishedAt: string;
	publishedBy: string | null;
	restriction: { level: RestrictionLevel };
	supersededAt: string | null;
}

/** The current publication (GET …/publication, POST, PATCH). */
export interface Publication extends Omit<PublicationMeta, 'restriction'> {
	/** The modeller's note to the project's staff; absent for a farmer. */
	note?: string;
	restriction: PublicationRestriction;
	nextExpectedOn: string | null;
	/** What every member, farmers included, reads about the catchment: counts and dates, no volumes. */
	catchmentView: CatchmentView & { engineVersion: string; runoffModel: string; calibration: { nse: number | null; pbias: number | null; kge: number | null } | null };
	updatedAt: string | null;
	updatedBy: string | null;
}

export interface PublishRequest {
	runId: string;
	note?: string;
	restriction?: PublicationRestriction;
	nextExpectedOn?: string | null;
}

export interface PublicationPatch {
	note?: string;
	restriction?: PublicationRestriction;
	nextExpectedOn?: string | null;
}
