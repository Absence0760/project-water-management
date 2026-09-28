// Wire shapes from docs/api.md that aren't in @water-management/engine.
import type { Locale } from '@water-management/engine/languages';
import type {
	AppliedOp,
	CatchmentView,
	EnsembleHeader,
	EnsembleRequest,
	EnsembleSummary,
	ForecastRainSource,
	InputChange,
	MemberResult,
	NoticeText,
	OpClass,
	OutlookExcluded,
	PairedMember,
	PairedSummary,
	ProjectModel,
	ProjectSettings,
	RecordCoverage,
	ResolvedEnsembleOptions,
	RestrictionLevel,
	RunComparison,
	RunInputsSnapshot,
	RunSeriesSnapshot,
	SignoffStatement,
	RegistrationBodyCode,
	RunSummary,
	ScenarioOp,
	SeasonalOutlook,
	SeriesMeta,
	StoredRunoffModelId,
	YearClassMethod,
	YieldPoint
} from '@water-management/engine';
import type { ImportNote, UnmappedItem } from '$lib/spreadsheet/import/report';

/**
 * Project roles, lowest first. `farmer` (WP-2.1) and `contributor` (WP-3.3, a
 * licence applicant) sit below viewer: a farmer reads only the farms linked
 * to them, an applicant their own applications on the published baseline,
 * and every workspace control that asks for viewer or above hides itself
 * (hasRole).
 */
export type Role = 'farmer' | 'contributor' | 'viewer' | 'editor' | 'owner';
/** The roles a member can be given in the Members panel; farmers are managed apart (FarmersPanel). */
export const ROLES: readonly Role[] = ['contributor', 'viewer', 'editor', 'owner'];
/** A role as people read it: a `contributor` is an applicant. */
export const ROLE_LABEL: Record<Role, string> = { farmer: 'farmer', contributor: 'applicant', viewer: 'viewer', editor: 'editor', owner: 'owner' };

export interface User {
	id: string;
	email: string;
	displayName: string;
	/** False until the address is confirmed via the emailed link (VerifyEmailBanner). */
	emailVerified?: boolean;
	/** The farmer-facing pages' and emails' language (app_user.locale, WP-2.5); null = not chosen, follow the browser. */
	locale?: Locale | null;
	/** How the farm view shows volumes (app_user.volume_unit, WP-2.5). */
	volumeUnit?: 'm3' | 'ML';
	/**
	 * SES reported a permanent bounce or a complaint for the address (057): alert
	 * emails are paused until the person turns them back on (api.alerts.resume;
	 * the banner on the account and alert pages). null while mail flows.
	 */
	mailSuppressed?: { reason: 'bounce' | 'complaint'; at: string } | null;
	/** The person's own display preferences (user_preferences, 083). */
	preferences?: UserPreferences;
	/**
	 * Accepted the terms of use and privacy notice now in force (app_user.terms_version,
	 * 087, against the engine's LEGAL_VERSION). False after a new version, or for an
	 * account a script made. Nothing asks again yet (docs/legal-status.md).
	 */
	termsCurrent?: boolean;
	/**
	 * Acknowledged the farm view's notice now in force (app_user.farm_notice_version,
	 * 093, against the engine's FARMER_NOTICE_VERSION). The farm pages show the
	 * notice instead of the figures while this is false.
	 */
	farmNoticeCurrent?: boolean;
}

export interface UserPreferences {
	/** The workspace sections (`?tab=` ids) they hid from their sidebar (lib/workspace/tabs.ts `visibleTabs`). */
	hiddenTabs: string[];
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

/**
 * settings.autoRun (WP-2.11, backend runs/autoRun.ts): whether the project
 * re-runs itself after new data. Not a model input, so not in the engine's
 * ProjectSettings; the API always sends every field.
 */
export interface AutoRunSettings {
	enabled: boolean;
	/** Minutes the re-run waits after the latest new data (0 to 120). */
	debounceMinutes: number;
	/** 'never' (the default): publication stays a person's act. Never "always". */
	publish: 'never' | 'if_no_new_warnings';
}

/** One metric's risk cut-offs (engine OutcomeRiskCutoffs); null = the engine's defaults, pending the hydrologist. */
export type OutcomeCutoffPair = { lower: number; increasing: number };

/**
 * settings.outcomes (issue #53 R4, backend projects/outcomeSettings.ts): how
 * the outcome matrix splits water years and colours its cells. Not a model
 * input, so not in the engine's ProjectSettings; the API always sends every field.
 */
export interface OutcomeSettings {
	yearClassMethod: YearClassMethod;
	riskCutoffs: { reserveMonthsMet: OutcomeCutoffPair | null; daysBelowEwr: OutcomeCutoffPair | null };
	/** The Reserve site the matrix reads: null = the outlet, else a gauge with a rule table. Absent from an older API. */
	siteNodeId?: string | null;
}

/** A season as a month and day each end (settings.outlook.season): the decision date and the season end. */
export interface OutlookSeasonSetting {
	startMonth: number;
	startDay: number;
	endMonth: number;
	endDay: number;
}

/**
 * settings.outlook (issue #53 R5, backend projects/outlookSettings.ts): how a
 * seasonal outlook is set up. null = the engine's defaults, pending the
 * client (O3, O6). Not a model input; the API always sends both fields.
 */
export interface OutlookSettings {
	season: OutlookSeasonSetting | null;
	planningShare: number | null;
}

export interface Project extends ProjectSummary {
	/** IANA zone (058_project_time_zone, Africa/Johannesburg by default): dates the project's downloads. Absent from an older API. */
	timeZone?: string;
	settings: ProjectSettings & { autoRun?: AutoRunSettings; outcomes?: OutcomeSettings; outlook?: OutlookSettings };
	/** When the project's pending re-run (manual or automatic) is due, ISO; null when none. Absent from an older API. */
	rerunQueuedFor?: string | null;
}

/** What a series merge or replace answers: the series, and when the automatic re-run it queued is due (null: none queued). */
export type SeriesWriteResult = SeriesMeta & { rerunQueuedFor?: string | null };

/**
 * A portable project document: the body of POST /projects/import, as
 * GET /projects/:id/export.json writes it (plus informational keys the
 * server ignores) and the workbook importers produce. The server validates
 * it in full (backend/src/projects/document.ts).
 */
export interface ProjectFile {
	name: string;
	description?: string;
	/** IANA zone; absent = Africa/Johannesburg. */
	timeZone?: string;
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
	/** What the values are (032_series_provenance.sql), e.g. CHIRPS / 2.0; absent or null = not recorded. */
	product?: string | null;
	productVersion?: string | null;
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
	/** The applying party the owner put them in (049): an applicant shares applications only within their own. */
	party: string | null;
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
	status: 'active';
	userId: string;
	email: string;
	displayName: string;
	/** An applicant (contributor, WP-3.3) keeps farm links too; absent from servers before it. */
	role?: 'farmer' | 'contributor';
	nodeIds: string[];
}

/** The languages a farmer invite email can be in (invite.locale): any in the engine's language table. */
export type InviteLocale = Locale;

/** A pending farmer invite and the farms it will link (WP-2.2). Listed for owners only. */
export interface InvitedFarmer {
	status: 'invited' | 'expired';
	inviteId: string;
	email: string;
	nodeIds: string[];
	/** Display name of whoever (re-)sent it. */
	invitedBy: string;
	expiresAt: string;
	locale: InviteLocale;
}

/** A row of GET /projects/:id/farmers: a farmer, or (owners only) a pending farmer invite. */
export type FarmerEntry = Farmer | InvitedFarmer;

/** POST /projects/:id/farmers: a verified account is added, any other address invited. */
export type AddFarmerResult =
	| { farmer: Farmer; invited?: undefined; invite?: undefined }
	| { invited: true; invite: InvitedFarmer; farmer?: undefined };

/** One row of POST /projects/:id/farmers/bulk (a CSV line: email,farm,language). */
export interface BulkFarmerRow {
	email: string;
	/** A farm's name, matched exactly and case-insensitively. */
	farm: string;
	locale?: string;
}

/** What happened to (or, in a dry run, would happen to) one bulk row. `row` indexes the request's rows. */
export interface BulkFarmerResult {
	row: number;
	email: string;
	farm: string;
	status: 'added' | 'invited' | 'error';
	error?: string;
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
	/** The team's stored settings (055): `{ portfolio?: { thresholds?: { green, amber } } }`. */
	settings: { portfolio?: { thresholds?: { green: number; amber: number } } };
	/** The portfolio thresholds that apply: the team's, or the defaults. */
	portfolioThresholds: PortfolioThresholds;
}

/**
 * The portfolio's traffic-light cut-offs (D11), percent of the last 30 days
 * with the outlet EWR not met: green below `green`, amber below `amber`, red
 * otherwise. `source` says whether they are the team's own or the defaults
 * (5, 20).
 */
export interface PortfolioThresholds {
	green: number;
	amber: number;
	source: 'team' | 'default';
}

/** GET /teams/:id/portfolio (WP-2.14, docs/api.md § Portfolio): one row per team catchment you can see. */
export type PortfolioEwrStatus = 'green' | 'amber' | 'red' | 'unknown';

export interface PortfolioProject {
	id: string;
	name: string;
	role: 'viewer' | 'editor' | 'owner';
	/** The project's time zone (IANA) and the calendar day there when the server answered: the day the ages count to. */
	timeZone: string;
	today: string;
	/** Newest day of recorded rain in the inputs (YYYY-MM-DD), or null. */
	dataUntil: string | null;
	lastRunAt: string | null;
	publishedAt: string | null;
	/** Where the figures come from: the current publication, the newest run (nothing published), or nothing. */
	source: 'published' | 'run' | null;
	sourceRunId: string | null;
	/** The last day the figures cover, and its age in days on the project's `today`. */
	figuresUntil: string | null;
	figuresAgeDays: number | null;
	stale: boolean;
	/** Recorded rain after figuresUntil: the figures don't include the newest data yet. */
	behindData: boolean;
	/** A run newer than the published one exists. */
	newerRun: boolean;
	ewr: {
		status: PortfolioEwrStatus;
		daysNotMet30: number | null;
		days30: number | null;
		fraction30: number | null;
		/** Why it is unknown (status 'unknown' only). */
		reason?: 'no-figures' | 'no-ewr' | 'no-series';
	};
	/** null = unknown (not published, or published before the counts were stored). */
	farmsShort7: number | null;
	farmsShort30: number | null;
	farmCount: number;
	/** Lowest farm dam on figuresUntil, 0–1; null with no dams or when unknown (damsKnown). */
	lowestDamPct: { nodeName: string; pct: number } | null;
	damsKnown: boolean;
	feeds: { total: number; ok: number; failing: number };
	/** Alerts firing now (WP-2.13); 0 when none, or when the catchment has no alert switched on. */
	alertsFiring: number;
	restriction: { level: 'none' | 'advisory' | 'restricted'; pct: number | null } | null;
}

// ---- Alerts (WP-2.13, docs/api.md § Alerts) --------------------------------

export type AlertKind = 'dam_below' | 'ewr_forecast_fail' | 'data_stale' | 'restriction_published' | 'job_dead' | 'feed_failing';
export type AlertMode = 'immediate' | 'daily_digest' | 'off';

/** One choice on /account/alerts. */
export interface AlertChoice {
	kind: AlertKind;
	/** A farmer's farm (their dam alerts are per farm); null for a kind-wide choice. */
	nodeId: string | null;
	nodeName: string | null;
	/** What you get now. */
	mode: AlertMode;
	/** What your role gets by default. */
	defaultMode: AlertMode;
	/** You chose it (rather than the default). */
	chosen: boolean;
	/** The catchment has this alert switched on; off, you get nothing whatever you choose. */
	ruleOn: boolean;
}

/** GET /me/alerts: one catchment's choices. */
export interface ProjectAlerts {
	id: string;
	name: string;
	role: 'farmer' | 'viewer' | 'editor' | 'owner';
	/** Every alert email for the catchment is off (a digest's unsubscribe). */
	muted: boolean;
	choices: AlertChoice[];
}

export interface AlertChoiceChange {
	kind: AlertKind | 'all';
	nodeId?: string | null;
	mode: AlertMode;
}

/** GET /projects/:id/alert-rules (editor). */
export interface AlertRule {
	/** null: not saved yet (a default, off). */
	id: string | null;
	kind: AlertKind;
	nodeId: string | null;
	nodeName: string | null;
	/** data_stale: the feed it watches (one rule per feed); null for every other kind. */
	feedId: string | null;
	/** That feed as the feeds page names it, and whether it is enabled (null for other kinds). */
	feedName: string | null;
	feedEnabled: boolean | null;
	/** dam_below: a fraction of capacity (0.3 = 30 %); the others whole days, failures or jobs; restriction_published 0. */
	threshold: number;
	enabled: boolean;
	firing: boolean;
}

export interface AlertRuleChange {
	kind: AlertKind;
	nodeId?: string | null;
	feedId?: string | null;
	threshold: number;
	enabled: boolean;
}

/** GET /projects/:id/alert-events: what the caller may see (a farmer, their farms' alerts and the notices). */
export interface AlertEvent {
	id: string;
	kind: AlertKind;
	state: 'firing' | 'cleared';
	value: number | null;
	threshold: number;
	nodeId: string | null;
	nodeName: string | null;
	/** data_stale: the feed it is about; null for every other kind. */
	feedId: string | null;
	openedAt: string;
	clearedAt: string | null;
	/** The figures the alert was raised on (dam: source, pct, date; forecast: days, of, from, to, madeOn; feeds: label, …). */
	detail: Record<string, unknown>;
}

/** POST /alerts/unsubscribe (the landing page's JSON form). */
export interface Unsubscribed {
	kind: AlertKind | 'all';
	project: { name: string };
	farm: string | null;
}

export interface Portfolio {
	team: { id: string; name: string; role: TeamRole };
	/** The traffic-light thresholds the statuses were judged by (the team's, or the defaults). */
	thresholds: PortfolioThresholds;
	projects: PortfolioProject[];
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
	/**
	 * The run used the legacy runoff model (its settings don't say 'gr4j'; audit H1): workbook comparison only,
	 * not evidence. Only a run made before engine 1.0.0 removed that model (issue #16); never a new run.
	 */
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
	/** settings.runoffModel the run used: 'gr4j', or 'legacy' for a run before engine 1.0.0 (absent → legacy). Absent from an older API. */
	runoffModel?: StoredRunoffModelId;
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
	/** A forecast run's first forecast day (summary.forecast.from); null otherwise. Absent from an older API. */
	forecastFrom?: string | null;
	/**
	 * Its input series are stored (021_series_blob), so GET …/reproduce can
	 * re-run it; false for a run from before stored inputs. Absent from an older API.
	 */
	reproducible?: boolean;
	/**
	 * What made the run (042_auto_rerun): 'manual' (a person), 'auto' (the
	 * debounced re-run after new data, WP-2.11), 'forecast' (WP-2.12). Absent
	 * from an older API (= manual).
	 */
	trigger?: RunTrigger;
}

export type RunTrigger = 'manual' | 'auto' | 'forecast';

/** GET …/runs/:runId/reproduce (WP-3.1): the run re-run from its stored inputs with today's engine. */
export interface Reproduction {
	/** identical; differs (with the list); not_reproducible (from before stored inputs); inconsistent (a stored input fails its check); failed (today's engine refuses the input). */
	status: 'identical' | 'differs' | 'not_reproducible' | 'inconsistent' | 'failed';
	identical: boolean;
	engineVersionThen: string;
	engineVersionNow: string;
	differences: ReproductionDifference[];
	/** Differences beyond the first 50, not listed. */
	truncated: number;
	message?: string;
}

export type ReproductionDifference =
	| { kind: 'summary'; path: string }
	| { kind: 'series'; key: string; nodeId: string | null; label: string; days: number; firstDate: string; maxAbsDiff: number | null }
	| { kind: 'series_missing' | 'series_extra'; key: string; nodeId: string | null; label: string };

/**
 * One citation of a run (RunMeta.citedBy). For a publication, `name` is the
 * day it was published (YYYY-MM-DD, UTC); for a sign-off (WP-3.13), the
 * signer's name. Evidence packs and assessments (WP-3.14) will add kinds.
 */
export interface RunCitation {
	kind: 'publication' | 'scenario' | 'signoff';
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
	runoffModel: StoredRunoffModelId;
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
	/**
	 * Each input series kind's start, length, hash and product/version as the
	 * run recorded them (GET …/runs/:runId only; `provenance` absent on a run
	 * saved before 032). The fit record compares the CHIRPS one.
	 */
	inputSeries?: Partial<Record<string, RunSeriesSnapshot>> | null;
	/**
	 * A forecast run's rain source (GET …/runs/:runId only): 'chirps_gefs'
	 * when a CHIRPS-GEFS feed wrote every forecast day, 'other' otherwise; null
	 * for any other run and a forecast run stored before it was recorded. The
	 * report credits CHIRPS-GEFS only on 'chirps_gefs'.
	 */
	forecastRainSource?: ForecastRainSource | null;
	/**
	 * Its server stamp still matches its rows (GET …/runs/:runId only;
	 * docs/security.md § Run stamps): false for a run written past the model
	 * run, or changed since, which can't be signed off.
	 */
	verified?: boolean;
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
	/** 'legacy' for a run of the legacy runoff model (engine < 1.0.0), which has no stores to trace. */
	runoffModel: StoredRunoffModelId;
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
	/**
	 * Who changed the inputs between the runs (issue #42): two runs of one
	 * project, A before B, neither a scenario run; otherwise null (absent
	 * from an older API).
	 */
	attribution?: CompareAttribution | null;
	/** Catchment series both runs stored with the same unit. */
	catchmentSeries: { key: string; label: string; unit: string }[];
}

/** The revisions made between two compared runs, and which of them set each line of `changes`. */
export interface CompareAttribution {
	/** Newest first, without the baseline. */
	revisions: HistoryRevision[];
	/** More were made than listed: the oldest are left out. */
	truncated: boolean;
	/** changedBy[i]: the id of the revision that set changes[i]; null when no recorded revision did (series lines never are). */
	changedBy: (string | null)[];
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
	/** The base run, for the "Based on run X" banner (label '' and createdAt null if you can't read it). */
	baseRun: { id: string; label: string; createdAt: string | null };
	ops: ScenarioOp[];
	/** SHA-256 of the ops as canonical JSON; a run of the scenario records the same hash. */
	opsSha256: string;
	/** The proposer's own nodes: ops on them are proposals, the rest baseline assumptions. */
	ownedNodeIds: string[];
	/**
	 * Names of the nodes and crops the ops name, kept by the server from the
	 * base run's snapshot when the ops were written, so an op on a node a
	 * rebase dropped still reads by name. Sorted by id.
	 */
	opNames: { id: string; name: string }[];
	ownerUserId: string;
	/** The owner's display name. */
	owner: string | null;
	status: ScenarioStatus;
	/** 'team': a modelling scenario. 'applicant': an application by a contributor (WP-3.3), on the published baseline. */
	origin: ScenarioOrigin;
	/** When it was submitted (null while a draft). */
	submittedAt: string | null;
	/** The assessor's decision, once decided. */
	decidedAt: string | null;
	decidedBy: string | null;
	outcome: ScenarioOutcome | null;
	decisionNote: string;
	/** Who else reads an application: the applicant's consultant or client. */
	members: { userId: string; displayName: string }[];
	createdAt: string;
	updatedAt: string;
	/** Runs of this scenario still stored, and the newest. */
	runCount: number;
	lastRun: { id: string; label: string; createdAt: string } | null;
}

export type ScenarioOrigin = 'team' | 'applicant';
/** An assessor's decision on an application (backend scenarios/schema.ts SCENARIO_OUTCOMES; the words pending the licensing authority). */
export type ScenarioOutcome = 'approved' | 'approved_with_conditions' | 'refused';
export const SCENARIO_OUTCOMES: readonly ScenarioOutcome[] = ['approved', 'approved_with_conditions', 'refused'];
export const OUTCOME_LABEL: Record<ScenarioOutcome, string> = {
	approved: 'Approved',
	approved_with_conditions: 'Approved with conditions',
	refused: 'Refused'
};

/**
 * GET …/scenarios/:sid/base: the base run's model and settings as you may see
 * them. For an applicant every node but their own farms and the gauges is
 * anonymised (`anonymisedNodeIds`: its name is "Farm 3" and its values are
 * blank, not the base's).
 */
export interface ScenarioBase {
	baseRunId: string;
	settings: unknown;
	model: unknown;
	anonymisedNodeIds: string[];
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
	/**
	 * An application's farms and crops, hidden from its applicant, renamed in
	 * its runs because the applicant gave one of their own that name (049).
	 * Sent to viewers and up only, never to an applicant.
	 */
	renamed?: { kind: 'node' | 'crop'; id: string; name: string; as: string }[];
	/**
	 * An application's new crops, transfers, land-cover patches or boreholes
	 * given an id a hidden one already had, moved to a fresh id in its runs so
	 * the hidden one keeps its own. Viewers and up only, like `renamed`.
	 */
	reIds?: { kind: 'crop' | 'transfer' | 'landCover' | 'borehole'; id: string; as: string }[];
}

/**
 * GET / POST / PATCH …/scenarios/:sid answer. `check` is null (and
 * `checkError` says why) only when the base run can't be rebuilt.
 */
export interface ScenarioWithCheck {
	scenario: Scenario;
	check: ScenarioCheck | null;
	checkError: string | null;
	/**
	 * An application's runs whose server stamp is missing or no longer matches
	 * (docs/security.md § Run stamps), to an editor or owner: it can't be
	 * decided until they're deleted. null for a team scenario or a lower role;
	 * absent from an older API.
	 */
	unverifiedRunIds?: string[] | null;
}

const RANK: Record<Role, number> = { farmer: -2, contributor: -1, viewer: 0, editor: 1, owner: 2 };

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
	/** The WUA's words by language code ({} for none); only languages of the table (packages/engine/src/languages.ts). */
	notice: NoticeText;
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

// --- Change history (WP-2.4, docs/api.md § History) ------------------------

/** What wrote a revision of the project's inputs. `baseline`: the state before the first recorded change. */
export type RevisionSource = 'baseline' | 'model_put' | 'settings_patch' | 'restore' | 'import' | 'copy';

/** One revision of { settings, model }, with the lines that describe it (not its snapshot). */
export interface HistoryRevision {
	type: 'revision';
	id: string;
	createdAt: string;
	/** Items one request wrote share it. */
	changeSet: string | null;
	/** Who made it; null when that account is gone. */
	actor: string | null;
	source: RevisionSource;
	reason: string | null;
	changes: InputChange[];
	restoredFrom: string | null;
	restoredFromRun: string | null;
}

/** One audit event: `kind` is '<noun>.<verb>' or 'restore'; `subject` its own shape (ids, names, counts, dates). */
export interface HistoryEvent {
	type: 'event';
	id: string;
	createdAt: string;
	changeSet: string | null;
	/** The actor's display name when it happened. */
	actor: string;
	kind: string;
	subject: Record<string, unknown>;
}

export type HistoryItem = HistoryRevision | HistoryEvent;

export interface HistoryPage {
	items: HistoryItem[];
	/** Pass as `before` for the next (older) page; null at the end. */
	next: string | null;
	/** When recording started for this project (its creation, or when history was switched on). */
	historySince: string;
}

export interface HistoryQuery {
	before?: string;
	limit?: number;
	nodeId?: string;
	/** 'revision', an event kind ('series.replaced') or its noun ('series'). */
	kind?: string;
	/** The parameter filter's words: only revisions with a change line holding them all (events pass). */
	q?: string;
}

/** One field's changes (GET …/history/fields, docs/api.md § Field history). */
export interface FieldHistory {
	count: number;
	lastAt: string;
	/** Null when that account is gone. */
	lastBy: string | null;
	/** The last change's values, "40% → 60%". */
	change: string;
	/** Words for History's parameter filter that find this field's lines. */
	filter: string;
}

/** A farmer to link again: a restore brings a farm back without its links. */
export interface Relink {
	userId: string;
	displayName: string;
	nodeId: string;
	nodeName: string;
}

export interface RestoreResult {
	revision: { id: string; createdAt: string; source: RevisionSource; reason: string | null; changes: InputChange[] };
	relink: Relink[];
}

/** A series' kept values (newest 5, at most 180 days old). */
export interface SeriesRevisionMeta {
	id: string;
	createdAt: string;
	createdBy: string | null;
	reason: 'replace' | 'delete' | 'manual_merge';
	startDate: string;
	length: number;
	valuesSha256: string;
	kind: string;
	name: string;
	unit: string;
}

/** Longest API key name, lifetime and series list (backend ingest/keys.ts, 039_api_keys.sql). */
export const API_KEY_NAME_MAX = 100;
export const API_KEY_DAYS_MAX = 3650;
export const API_KEY_SERIES_MAX = 50;

/** One series an API key may write. */
export interface ApiKeySeries {
	kind: string;
	name: string;
}

/** A per-project API key as its owner sees it (docs/api.md § Ingest). Never the key or its hash. */
export interface ApiKey {
	id: string;
	name: string;
	/** The first 8 characters of the id: the `wm_<prefix>_…` part of the key. */
	prefix: string;
	scopes: string[];
	/** null: any series of the project. */
	allowedSeries: ApiKeySeries[] | null;
	createdAt: string;
	/** Display names; null once that account is gone. */
	createdBy: string | null;
	/** Bumped at most once a minute when the key is used. */
	lastUsedAt: string | null;
	/** null: until revoked. */
	expiresAt: string | null;
	revokedAt: string | null;
	revokedBy: string | null;
}

/** POST /projects/:id/api-keys' body. */
export interface ApiKeyCreate {
	name: string;
	allowedSeries?: ApiKeySeries[] | null;
	expiresInDays?: number | null;
}

/** Longest share-link label and lifetime (backend share/links.ts, 025_share_links.sql). */
export const SHARE_LABEL_MAX = 100;
export const SHARE_DAYS_MAX = 365;

/** A read-only share link as its owner sees it (docs/api.md § Share). Never the token. */
export interface ShareLink {
	id: string;
	label: string;
	createdAt: string;
	/** Display names; null once that account is gone. */
	createdBy: string | null;
	expiresAt: string;
	revokedAt: string | null;
	revokedBy: string | null;
	/** Bumped at most once an hour when the link is opened. */
	lastUsedAt: string | null;
}

/** The catchment view a share link shows: counts and dates only; the outlet has no name (it may be a farm). */
export interface SharedCatchmentView {
	runStart: string;
	dataUntil: string;
	season: { from: string; to: string; days: number };
	last30: { from: string; to: string; days: number };
	runDays: number;
	farmCount: number;
	sites: { name: string | null; isOutlet: boolean; daysNotMet: { run: number; season: number; last30: number } }[];
}

/** POST /share/view (public). */
export interface ShareView {
	project: { name: string };
	publication: {
		publishedAt: string;
		publishedBy: string | null;
		catchmentView: SharedCatchmentView;
		restriction: PublicationRestriction;
		nextExpectedOn: string | null;
	};
}

/** The catchment series a share link may read (app_share_series). */
export type ShareSeriesKey = 'natural_flow' | 'simulated_outflow' | 'observed_flow' | 'ewr' | 'ewr_shortfall';

/** POST /share/series (public): monthly means (m³/day) from `monthly.startMonth`, the last 365 days from `recent.startDate`. */
export interface ShareSeries {
	key: ShareSeriesKey;
	label: string;
	unit: string;
	monthly: { startMonth: string; values: (number | null)[] };
	recent: { startDate: string; values: (number | null)[] };
}

/** Longest note, in characters (backend NOTE_MAX, 037_notes.sql). */
export const NOTE_MAX = 4000;

/** Who may read a note: the team (viewers and above), or also the farmers of its farm. */
export type NoteVisibility = 'team' | 'farm';
export type NoteTargetKind = 'project' | 'node' | 'run' | 'setting';

/** A plain-text note on a node, run, setting or the project (WP-2.7; docs/api.md § Notes). */
export interface Note {
	id: string;
	/** Plain text: render escaped, never as HTML or markdown. */
	body: string;
	/** Display name; null once that account is gone. */
	author: string | null;
	createdAt: string;
	editedAt: string | null;
	target: NoteTargetKind;
	nodeId: string | null;
	/** The node's name, when the caller can see the node. */
	nodeName: string | null;
	runId: string | null;
	settingKey: string | null;
	visibility: NoteVisibility;
	/** The caller wrote it, and may edit it. */
	mine: boolean;
	/** The caller may delete it: its author, or an editor. */
	canDelete: boolean;
}

/** GET /notes filters: one target, a settings group (`calibration` matches `calibration.*`), or a kind of target. */
export interface NotesQuery {
	nodeId?: string;
	runId?: string;
	settingKey?: string;
	target?: NoteTargetKind;
	limit?: number;
}

/** POST /notes: at most one target; `visibility: 'farm'` only on a farm. */
export interface NoteCreate {
	body: string;
	nodeId?: string;
	runId?: string;
	settingKey?: string;
	visibility?: NoteVisibility;
}

/** How many notes the caller can see on each target (the count badges). */
export interface NoteCounts {
	project: number;
	nodes: Record<string, number>;
	runs: Record<string, number>;
	settings: Record<string, number>;
}

/** A professional sign-off on a run (036_signoff, docs/api.md § Sign-offs). Immutable. */
export interface Signoff {
	id: string;
	runId: string;
	fullName: string;
	/** 'sacnasp' or 'ecsa' from signoff-3 (engine liability/registration.ts); the signer's free text on older rows. */
	registrationBody: string;
	/** Category and field codes; null on a signoff-1 or -2 row (not recorded). */
	registrationCategory: string | null;
	registrationField: string | null;
	registrationNo: string;
	scope: string;
	statementVersion: string;
	statementSha256: string;
	disclaimerVersion: string;
	signedAt: string;
	/** The caller signed it. */
	mine: boolean;
}

/** GET /projects/:id/runs/:runId/signoffs. */
export interface SignoffList {
	statement: SignoffStatement;
	/** SHA-256 of the statement's RFC 8785 text: sent back with a sign-off. */
	statementSha256: string;
	disclaimer: { version: string; status: 'draft' | 'agreed' };
	/** Why the caller can't sign this run, or null when they can. */
	cannotSign: string | null;
	signoffs: Signoff[];
}

/** POST /projects/:id/runs/:runId/signoffs. */
export interface SignoffRequest {
	fullName: string;
	registrationBody: RegistrationBodyCode;
	/** A category and a field (SACNASP) or discipline (ECSA) of that body; a blocked category is refused (400). */
	registrationCategory: string;
	registrationField: string;
	registrationNo: string;
	scope: string;
	/** Every confirmation id of the statement. */
	confirmed: string[];
	statementSha256: string;
}

// --- Allocations (WP-3.10, docs/allocations.md, docs/api.md § Allocations) ---

export type AllocationAuthorisation = 'registration' | 'licence' | 'general_authorisation' | 'existing_lawful_use';
export type AllocationPurpose = 'irrigation' | 'domestic' | 'livestock' | 'industry' | 'mining' | 'municipal' | 'other';
export type AllocationWaterSourceKind = 'surface' | 'groundwater';
export type AllocationImportKind = 'warms_extract' | 'csv';

/** A registered or licensed volume (GET /projects/:id/allocations). */
export interface Allocation {
	id: string;
	nodeId: string | null;
	nodeName: string | null;
	/** The import it came from; null = typed into the app. */
	sourceId: string | null;
	registrationNo: string;
	propertyRef: string;
	/** null when there is none, or the member may not see names (canSeeHolders false). */
	holder: string | null;
	authorisation: AllocationAuthorisation;
	purpose: AllocationPurpose;
	waterSource: AllocationWaterSourceKind;
	volumeM3PerYear: number;
	storageM3: number | null;
	validFrom: string | null;
	validTo: string | null;
	reference: string;
	createdAt: string;
	updatedAt: string;
}

/** An imported file: the provenance of its rows. */
export interface AllocationSource {
	id: string;
	kind: AllocationImportKind;
	fileName: string;
	sha256: string;
	reference: string;
	importedAt: string;
	importedBy: string | null;
	rows: number;
}

export interface AllocationList {
	allocations: Allocation[];
	sources: AllocationSource[];
	/** The farms and water users an allocation can be matched to. */
	nodes: { id: string; name: string }[];
	/** Editors and owners see holder names (decision D3); viewers see volumes only. */
	canSeeHolders: boolean;
}

/** The fields an editor sends to create or change an allocation. */
export interface AllocationInput {
	nodeId: string | null;
	registrationNo?: string;
	propertyRef?: string;
	holder?: string;
	authorisation: AllocationAuthorisation;
	purpose?: AllocationPurpose;
	waterSource: AllocationWaterSourceKind;
	volumeM3PerYear: number;
	storageM3?: number | null;
	validFrom?: string | null;
	validTo?: string | null;
	reference?: string;
}

/** One row of an import preview. */
export interface AllocationPreviewRow {
	line: number;
	registrationNo: string;
	propertyRef: string;
	farm: string;
	holder: string;
	authorisation: AllocationAuthorisation | null;
	purpose: AllocationPurpose;
	waterSource: AllocationWaterSourceKind | null;
	volumeM3PerYear: number | null;
	storageM3: number | null;
	validFrom: string | null;
	validTo: string | null;
	reference: string;
	errors: string[];
	nodeId: string | null;
	matchedBy: 'registration' | 'property' | 'name' | 'manual' | null;
	alreadyInProject: boolean;
}

export interface AllocationImportRequest {
	kind: AllocationImportKind;
	fileName: string;
	text: string;
	reference?: string;
}

/** POST /projects/:id/allocations/import: nothing is written. */
export interface AllocationPreview {
	fileName: string;
	kind: AllocationImportKind;
	sha256: string;
	columns: Record<string, string>;
	ignoredColumns: string[];
	rows: AllocationPreviewRow[];
	/** The farms and water users a row can be matched to. */
	nodes: { id: string; name: string }[];
	summary: { rows: number; valid: number; invalid: number; matched: number; unmatched: number };
}

/** A background job as the status list shows it (GET /projects/:id/jobs, docs/api.md § Jobs). Never its payload. */
export interface JobMeta {
	id: string;
	kind: string;
	status: 'queued' | 'running' | 'done' | 'failed' | 'dead';
	attempts: number;
	maxAttempts: number;
	runAfter: string;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	/** Why it failed, in our words (never database text). */
	error: string | null;
	createdBy: string;
	/** 0–100 while a job that reports progress runs (yield); null otherwise. Absent from an older API. */
	progress?: number | null;
}

/** A sweep member's outcome series as stored (docs/api.md § Sweeps): a missing value is null. */
export interface StoredRunSeries {
	nodeId: string | null;
	key: string;
	label: string;
	unit: string;
	values: (number | null)[];
}

/** One named op set of a sweep (GET /projects/:id/sweeps…, backend sweeps/store.ts SweepMemberRow). */
export interface SweepMember {
	id: string;
	position: number;
	name: string;
	ops: ScenarioOp[];
	opsSha256: string;
	/** done: summary (and series) stored; problems: its ops don't apply; failed: the engine refused it. */
	status: 'pending' | 'done' | 'problems' | 'failed';
	problems: string[];
	startDate: string | null;
	endDate: string | null;
	finishedAt: string | null;
	/** Only on GET …/sweeps/:sweepId, and only when done. */
	summary?: RunSummary | null;
	/** Only on GET …/sweeps/:sweepId?series=true, and only when done. */
	series?: StoredRunSeries[] | null;
}

/** A scenario sweep (issue #53 R2, docs/api.md § Sweeps). */
export interface Sweep {
	id: string;
	name: string;
	baseRunId: string;
	baseRun: { id: string; label: string; createdAt: string };
	status: 'pending' | 'complete';
	engineVersion: string | null;
	/** The job computing it; null once the 30-day purge removed it. */
	job: { id: string; status: JobMeta['status']; error: string | null; progress: number | null } | null;
	createdBy: string | null;
	createdAt: string;
	completedAt: string | null;
	members: SweepMember[];
}

/** POST /projects/:id/sweeps. */
export interface SweepRequest {
	name: string;
	baseRunId: string;
	members: { name: string; ops: ScenarioOp[] }[];
}

/** A water year an outlook left out (docs/api.md § Seasonal outlooks): the engine's reasons, or the backend's. */
export type OutlookExcludedYear = OutlookExcluded | { waterYear: number; reason: 'overLimit' | 'memberFailed' };

/** An outlook's result: the engine's SeasonalOutlook, with the backend's exclusions and the members the engine refused. */
export type OutlookResult = Omit<SeasonalOutlook, 'excluded'> & {
	excluded: OutlookExcludedYear[];
	failures: { levelId: string; label: string; waterYear: number; message: string }[];
};

/** A seasonal outlook (issue #53 R5, docs/api.md § Seasonal outlooks, backend outlooks/store.ts OutlookRow). */
export interface Outlook {
	id: string;
	name: string;
	baseRunId: string;
	baseRun: { id: string; label: string; createdAt: string };
	decisionDate: string;
	seasonEnd: string;
	/** null = the engine's default share (pending the client's O6). */
	planningShare: number | null;
	levels: { id: string; label: string; ops: ScenarioOp[] }[];
	analogueYears: number[] | null;
	status: 'pending' | 'complete';
	engineVersion: string | null;
	job: { id: string; status: JobMeta['status']; error: string | null; progress: number | null } | null;
	createdBy: string | null;
	createdAt: string;
	completedAt: string | null;
	/** Only on GET …/outlooks/:outlookId; null while pending. */
	result?: OutlookResult | null;
}

/** POST /projects/:id/outlooks. Season and share absent: the project's settings. */
export interface OutlookRequest {
	name: string;
	baseRunId: string;
	levels: { label: string; ops: ScenarioOp[] }[];
	decisionDate?: string;
	seasonEnd?: string;
	planningShare?: number;
	analogueYears?: number[];
}

/** A yield request's parameters (backend yield/store.ts YieldParams). */
export interface YieldParams {
	/** 'constant', 'demand' (the farm's own demand shape) or 12 factors, Oct–Sep. */
	pattern: 'constant' | 'demand' | number[];
	/** 0.5–1; 1 = the firm yield. */
	assurance: number;
	tolerance: number;
	/** Curve points, 8–12. */
	points: number;
}

/** POST /projects/:id/yield: exactly one of runId and scenarioId. */
export interface YieldRequest {
	nodeId: string;
	runId?: string;
	scenarioId?: string;
	kind: 'firm' | 'curve';
	params?: Partial<YieldParams>;
}

/** A pending yield job and what it is for (GET /projects/:id/yield/jobs). */
export interface YieldJob extends JobMeta {
	target: { nodeId: string; runId: string | null; scenarioId: string | null; kind: 'firm' | 'curve'; params: YieldParams };
}

/** A stored firm yield or storage–yield curve (GET /projects/:id/yield, 040_yield). */
export interface YieldResult {
	id: string;
	runId: string | null;
	scenarioId: string | null;
	nodeId: string;
	jobId: string | null;
	kind: 'firm' | 'curve';
	params: YieldParams;
	points: { point: YieldPoint } | { baseCapacityM3: number; assurance: number; points: YieldPoint[]; monotone: boolean };
	engineVersion: string;
	createdBy: string | null;
	createdAt: string;
}
