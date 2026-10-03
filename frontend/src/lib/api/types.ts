// Wire shapes from docs/api.md that aren't in @water-management/engine.
import type { Locale } from '@water-management/engine/languages';
import type {
	AppliedOp,
	CalibrationBounds,
	CalibrationExclusion,
	CalibrationRules,
	FilterResult,
	FlaggedYearShare,
	ObjectiveId,
	CatchmentView,
	CumulativeReport,
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
	ReviewTriggerRow,
	ReviewTriggers,
	RestrictionLevel,
	RunComparison,
	RunInputsSnapshot,
	RunSeriesSnapshot,
	SignoffStatement,
	PackManifest,
	PackSignoffStatement,
	RegistrationBodyCode,
	RunSummary,
	ScenarioConflict,
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
/** How a role reads (a `contributor` is an applicant, a team `admin` an owner): ./roleLabels.ts. */

/** What a deletion would leave with no owner or admin: DELETE /auth/me's 409 `account_sole_holder` details (issue #112). */
export interface SoleHoldings {
	projects: { id: string; name: string }[];
	teams: { id: string; name: string }[];
}

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
	/** The version of the terms the account accepted (app_user.terms_version); null = none. The re-acceptance step lists the changes since. */
	termsVersion?: string | null;
	/** The report renderer's session (a render token's, reports/scope.ts): it renders the report, never the terms step. */
	renderSession?: boolean;
	/**
	 * Acknowledged the farm view's notice now in force (app_user.farm_notice_version,
	 * 093, against the engine's FARMER_NOTICE_VERSION). The farm pages show the
	 * notice instead of the figures while this is false.
	 */
	farmNoticeCurrent?: boolean;
}

/** GET /auth/mfa: two-step sign-in on the Account page (issue #282, docs/api.md § Two-step sign-in). */
export interface MfaStatus {
	/** An authenticator app is set up. */
	enrolled: boolean;
	enrolledAt: string | null;
	/** Unused recovery codes left (0 when off). */
	recoveryCodesLeft: number;
	/** The person is a project owner, team admin or assessor: those actions need it. */
	required: boolean;
	/** This session signed in with a code. */
	sessionVerified: boolean;
}

/** POST /auth/login for an account with an authenticator: no session yet, enter a code (api.auth.mfa.verify). */
export interface MfaChallenge {
	mfaRequired: true;
}

export interface UserPreferences {
	/**
	 * The workspace sections (`?tab=` ids) they hid from their sidebar (lib/workspace/tabs.ts `visibleTabs`);
	 * null when they never chose (or reset), so `DEFAULT_HIDDEN_TABS` applies.
	 */
	hiddenTabs: string[] | null;
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
	/** The project's calendar date (YYYY-MM-DD, in its time zone): what the list counts dataUntil's age to. */
	today: string;
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
 * client (O3, O6). Not a model input; the API always sends every field (an older one no `review`).
 */
export interface OutlookSettings {
	season: OutlookSeasonSetting | null;
	planningShare: number | null;
	/** The review date's month and day (issue #53 R6); null = the engine's defaultReviewDate (1 January for the default season). */
	review?: { month: number; day: number } | null;
}

/**
 * settings.responsibleAuthority (163_licensing_authority, backend
 * projects/authoritySettings.ts): who decides the project's licence
 * applications, DWS or a CMA with the power. null = none named. Not a model input.
 */
export interface ResponsibleAuthority {
	name: string;
	kind: 'dws' | 'cma';
	/** '' = not given. */
	office: string;
}

export interface Project extends ProjectSummary {
	/** IANA zone (058_project_time_zone, Africa/Johannesburg by default): dates the project's downloads. Absent from an older API. */
	timeZone?: string;
	/** The WUA that publishes the figures (095_wua_name): the farm pages name it in their contact lines. null = "your WUA". Absent from an older API. */
	wuaName?: string | null;
	settings: ProjectSettings & { autoRun?: AutoRunSettings; outcomes?: OutcomeSettings; outlook?: OutlookSettings; responsibleAuthority?: ResponsibleAuthority | null };
	/** When the project's pending re-run (manual or automatic) is due, ISO; null when none. Absent from an older API. */
	rerunQueuedFor?: string | null;
	/** The caller acts for the responsible authority (163): editor or above and marked by an owner, so they record its decisions and endorse a baseline. */
	actsForAuthority?: boolean;
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
	/** Where the values came from, and the unit first given (107_series_source.sql); absent = not recorded. */
	source?: string;
	sourceUnit?: string;
	sourceUnitFactor?: number;
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
	/** The importer's display name; null once their account is deleted (138). */
	importedBy: string | null;
}

export interface Member {
	userId: string;
	email: string;
	displayName: string;
	role: Role;
	/** The applying party the owner put them in (049): an applicant shares applications only within their own. */
	party: string | null;
	/** The party's appointed specialist, who signs its applications' evidence packs (167_signers); needs a party. */
	specialist: boolean;
	/** The owner marked them as acting for the responsible authority (163). Absent from an older API. */
	actsForAuthority?: boolean;
}

/** Someone who can read a farm's figures (GET /projects/:id/farm/:nodeId/access): names and roles, never emails. */
export interface FarmAccessPerson {
	displayName: string;
	role: Role;
	/** The caller. */
	you: boolean;
}

/** A farmer member and the farm nodes they may read (GET /projects/:id/farmers). */
/** The roles that hold farms: a farmer, or a licence applicant with their farms (contributor, WP-3.3). */
export type FarmRole = 'farmer' | 'contributor';

export interface Farmer {
	status: 'active';
	userId: string;
	email: string;
	displayName: string;
	/** An applicant (contributor, WP-3.3) keeps farm links too; absent from servers before it. */
	role?: FarmRole;
	nodeIds: string[];
}

/** The languages a farmer invite email can be in (invite.locale): any in the engine's language table. */
export type InviteLocale = Locale;

/** A pending farmer invite and the farms it will link (WP-2.2). Listed for owners only. */
export interface InvitedFarmer {
	status: 'invited' | 'expired';
	inviteId: string;
	email: string;
	/** What they join as: an applicant invited with their farms (097); absent from servers before it. */
	role?: FarmRole;
	nodeIds: string[];
	/** Display name of whoever (re-)sent it. */
	invitedBy: string;
	expiresAt: string;
	locale: InviteLocale;
	/** Its sender no longer owns the project: nobody can accept it until an owner re-sends it (155); absent from servers before it. */
	senderLapsed?: boolean;
}

/** A row of GET /projects/:id/farmers: a farmer, or (owners only) a pending farmer invite. */
export type FarmerEntry = Farmer | InvitedFarmer;

/** POST /projects/:id/farmers: always an invite, whether or not the address has an account (issue #136). */
export type AddFarmerResult = { invited: true; invite: InvitedFarmer };

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
 * member an editor and an admin an owner (docs/data-model.md § Teams). The UI
 * shows them by those project names (roleLabel, ./roleLabels.ts).
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
	/** Whom to ask about the personal information in the team's projects (168, POPIA s18(1)(b)); null = not set. */
	privacyContact: PrivacyContact | null;
}

/** A team's privacy contact: a name (or office) and an email address, a postal address optional (168). */
export interface PrivacyContact {
	name: string;
	email: string;
	postal: string | null;
}

/**
 * GET /projects/:id/privacy-contact: who decides about a project's information, for every member, farmers
 * included. contact null: the project has no team, or its team has set no contact.
 */
export interface ProjectPrivacyContact {
	/** The WUA the farm pages name (095), or null. */
	wuaName: string | null;
	contact: (PrivacyContact & { organisation: string }) | null;
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

export type AlertKind = 'dam_below' | 'ewr_forecast_fail' | 'data_stale' | 'restriction_published' | 'job_dead' | 'feed_failing' | 'farms_short';
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
	/** A farm's dam alert: the level it warns below, a fraction (0.3 = 30 %), the WUA's; null otherwise. */
	threshold: number | null;
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
	/** data_stale: the ingest-key series it watches instead of a feed (one rule per series an API key writes); null otherwise. */
	seriesId: string | null;
	/** That series as the Data page names it (its name, else its kind's label). */
	seriesName: string | null;
	/** Whether an API key still writes it; false once a person wrote over the key's days (null for other rules). */
	seriesKeyFed: boolean | null;
	/** dam_below: a fraction of capacity (0.3 = 30 %); the others whole days, failures or jobs; restriction_published 0. */
	threshold: number;
	enabled: boolean;
	firing: boolean;
}

export interface AlertRuleChange {
	kind: AlertKind;
	nodeId?: string | null;
	feedId?: string | null;
	seriesId?: string | null;
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
	/** data_stale: the ingest-key series it is about; null otherwise. */
	seriesId: string | null;
	openedAt: string;
	clearedAt: string | null;
	/** The figures the alert was raised on (dam: source, pct, date; forecast: days, of, from, to, madeOn; feeds: label, …). */
	detail: Record<string, unknown>;
	/**
	 * A firing ewr_forecast_fail event whose forecast is behind the recorded
	 * rain, with no newer forecast made since: the day it was made, its last
	 * recorded rain day, and the recorded rain's last day now. null otherwise.
	 */
	forecastOutOfDate: { madeOn: string; observedTo: string; rainUntil: string } | null;
}

/** POST /alerts/unsubscribe (the landing page's JSON form). */
export interface Unsubscribed {
	kind: AlertKind | 'all';
	project: { name: string };
	farm: string | null;
}

/** POST /alerts/feedback: what the answered mail was about (151_alert_feedback). */
export interface FeedbackAnswered {
	kind: AlertKind | 'digest';
	project: { name: string };
}

/** GET /projects/:id/alert-feedback (editors): answers counted per kind, and comments, never who gave them. */
export interface AlertFeedbackSummary {
	since: string;
	kinds: { kind: AlertKind | 'digest'; yes: number; no: number }[];
	comments: { kind: AlertKind | 'digest'; useful: boolean; comment: string; answeredAt: string }[];
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
	/**
	 * Its sender no longer owns the project (administers the team), so nobody
	 * can accept it until an owner re-sends it (155_invite_sender_role); absent
	 * from servers before it.
	 */
	senderLapsed?: boolean;
}

/** What an invite link is for (POST /auth/invite-info). */
export interface InviteInfo {
	email: string;
	projectName: string | null;
	teamName: string | null;
	invitedBy: string;
}

/**
 * POST …/members: always an invite, the same answer whether or not the address has an account
 * (issue #136). A verified account joins when its holder accepts it (GET /me/invites).
 */
export type AddMemberResult = { invited: true; invite: Invite };

/** One of your own pending invitations (GET /me/invites, issue #136): where to, as what, from whom. */
export interface MyInvite {
	id: string;
	kind: 'project' | 'team';
	targetId: string;
	/** The project's or team's name. */
	name: string;
	/** The project role (viewer, editor, owner, farmer, contributor) or team role (viewer, member, admin) it gives. */
	role: string;
	invitedBy: string;
	/** A farmer or applicant invite's farms, by name. */
	farms: string[];
	createdAt: string;
	expiresAt: string;
}

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
	 * A scenario made the run, also once that scenario is deleted and
	 * `scenarioId` is null (model_run.from_scenario, 188). Tell a run of the
	 * model by this (isScenarioRun), never by `scenarioId`. Absent from an older API.
	 */
	fromScenario?: boolean;
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
	/** The engine of the automatic fit its parameters came from (settings.fitRecord); null for entered parameters. Absent from an older API. */
	fitEngineVersion?: string | null;
	/**
	 * The known engine bugs that may affect it (issue #103, docs/engine-errata.md):
	 * the ids of the errata whose range holds its engine, or its fit's for a `fit`
	 * erratum, computed by the API (backend errata/runs.ts). Empty for none; absent
	 * from an older API.
	 */
	errata?: string[];
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
 * signer's name; for an evidence pack (WP-3.14, 112), `version N`.
 * Assessments will add a kind.
 */
export interface RunCitation {
	kind: 'publication' | 'scenario' | 'signoff' | 'pack';
	id: string;
	name: string;
}

/** Most pinned runs per project (backend PINNED_RUNS_PER_PROJECT_MAX, 015_run_pinned.sql). */
export const PINNED_RUNS_MAX = 10;

/** Longest run note, in characters (backend RUN_NOTES_MAX, 007_run_notes.sql). */
export const RUN_NOTES_MAX = 4000;

export type EvidenceStatus = 'current' | 'past';

/** One row of a project's evidence history (GET …/evidence, oldest first; the last is current). */
/** A row of the evidence history: a run nominated, or a withdrawal of the nomination before it (098: every run field null). */
export interface Nomination {
	id: string;
	/** A withdrawal: no run, only who, when and why. Absent from an older API (every row a nomination). */
	withdrawn?: boolean;
	runId: string | null;
	runLabel: string | null;
	runCreatedAt: string | null;
	/** Copied from the run when it was nominated. */
	runoffModel: StoredRunoffModelId | null;
	engineVersion: string | null;
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
	/** Null once the starter's account is deleted (138). */
	createdById: string | null;
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
	/** The row after it: another run nominated, or (`withdrawn`, no run) the nomination withdrawn. */
	replacedBy: { withdrawn?: boolean; runId: string | null; runLabel: string | null; nominatedAt: string; nominatedBy: string | null; reason: string } | null;
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
		returnFlowFraction: number | null;
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
	/** Each store at the end of the day before, mm (after the warm-up on the run's first day; each null there on a run from before engine 1.20.0). Null for a legacy run. */
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
	/** Answers to the evidence report's Appendix C prompts (engine APPLICANT_PROMPTS, 129_scenario_statement); '' = not given. */
	purposeAndNeed: string;
	mitigation: string;
	monitoring: string;
	/**
	 * Where written objections go and by when, as the application's notice gives them (GN R267 reg 17(4)(b)(vi)–(vii);
	 * 166_public_participation); null: not given. Set while a draft, frozen once submitted.
	 */
	objectionAddress: string | null;
	objectionClosingDate: string | null;
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
	/** Null once the owner's account is deleted (138): the scenario stays, the name goes. */
	ownerUserId: string | null;
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
	/** The authority's decision as recorded (163): its name, the date on its letter, its reference, and whether written reasons came. null/'' until decided; the date and the reasons flag are null on a decision recorded before 163. */
	decisionAuthority?: string | null;
	decisionDate?: string | null;
	decisionReference?: string;
	reasonsReceived?: boolean | null;
	/** Who else reads an application: the applicant's consultant or client. */
	members: { userId: string; displayName: string }[];
	createdAt: string;
	updatedAt: string;
	/** Runs of this scenario still stored, and the newest. */
	runCount: number;
	lastRun: { id: string; label: string; createdAt: string } | null;
}

export type ScenarioOrigin = 'team' | 'applicant';
/**
 * The responsible authority's decision on an application, in the National
 * Water Act's and GN R267's words (backend scenarios/schema.ts
 * SCENARIO_OUTCOMES, 163_licensing_authority; provisional position,
 * pre-counsel research, 2026-10-01).
 */
export type ScenarioOutcome = 'licence_issued' | 'licence_refused' | 'application_rejected' | 'not_considered';
export const SCENARIO_OUTCOMES: readonly ScenarioOutcome[] = ['licence_issued', 'licence_refused', 'application_rejected', 'not_considered'];
export const OUTCOME_LABEL: Record<ScenarioOutcome, string> = {
	licence_issued: 'Licence issued (see its conditions)',
	licence_refused: 'Licence refused',
	application_rejected: 'Application rejected (formal requirements)',
	not_considered: 'Not considered: use already authorised'
};
/** POST …/decide: "Record the authority's decision" (163). */
export interface DecideRequest {
	outcome: ScenarioOutcome;
	/** The authority's name; omitted, the project's settings.responsibleAuthority. */
	authority?: string;
	/** The date on its decision letter, YYYY-MM-DD. */
	decisionDate: string;
	/** Its licence or file reference ('' = none). */
	reference?: string;
	reasonsReceived: boolean;
	note?: string;
}

/** The outcome's basis in the Act or the regulations, printed beside the choice. */
export const OUTCOME_BASIS: Record<ScenarioOutcome, string> = {
	licence_issued: 'NWA s27, s28(1)(d): every licence carries conditions',
	licence_refused: 'NWA s42',
	application_rejected: 'GN R267 regs 9(1)(b), 11(2), 12(2)(b)',
	not_considered: 'NWA s40(4)'
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

/** One EWR site's months, base or application (ApplicantResults). */
export interface ApplicantEwrFigures {
	months: number;
	met: number;
	rate: number | null;
	longestNotMetRun: number;
	/** Only with the catchment figures (k and every change a proposal); else null. */
	deficitM3: number | null;
}

export interface ApplicantCatchmentFigures {
	meanNaturalFlowM3Day: number;
	/** The use's figure: only at 5 or more farm holders (164); else null. */
	meanSimulatedOutflowM3Day: number | null;
	ewrDaysNotMet: number;
	ewrFractionDaysNotMet: number;
}

export interface ApplicantUnitFigures {
	avgDemandM3Day: number;
	avgSuppliedM3Day: number;
	avgDeficitM3Day: number;
	fractionSupplied: number;
	avgEwrChargeM3Day: number;
	daysEwrNotMet: number;
	damEndM3: number | null;
	damLowM3: number | null;
}

/** Why the catchment figures or the per-unit figures are left out. */
export type ApplicantWithheld = 'baseline_assumptions' | 'few_farm_holders';

interface ApplicantSeriesPair {
	base: { startDate: string; values: (number | null)[] };
	application: { startDate: string; values: (number | null)[] };
}

/**
 * GET …/scenarios/:sid/results (WP-3.3, D2's default, pending the client): a
 * run of an application as its applicant sees it against its base. Every
 * other farm or water user only downstream of theirs, by the anonymous name
 * the base gives it ("Farm 3") and a whole percentage.
 */
export interface ApplicantResults {
	allProposals: boolean;
	ewrSites: { nodeId: string | null; name: string | null; isOutlet: boolean; base: ApplicantEwrFigures | null; application: ApplicantEwrFigures | null }[];
	catchment: {
		ewrDaysNotMet: { base: number; application: number };
		ewrFractionDaysNotMet: { base: number; application: number };
		figures: { base: ApplicantCatchmentFigures; application: ApplicantCatchmentFigures } | null;
		/** The EWR requirement whenever the figures show; the outflow only past the k rule (164). */
		series: { outflow: ApplicantSeriesPair | null; ewr: ApplicantSeriesPair | null } | null;
		/** Why the use's figures (outflow, its series, the EWR deficit) are left out. */
		withheld: ApplicantWithheld | null;
	};
	units: { nodeId: string; name: string; kind: 'farm' | 'user'; added: boolean; base: ApplicantUnitFigures | null; application: ApplicantUnitFigures | null }[];
	downstream: { nodeId: string; name: string; kind: 'farm' | 'user'; supplyChangePct: number | null }[];
	unitsWithheld: ApplicantWithheld | null;
	/** What ran on their units, by the ids they gave. */
	model: {
		nodes: { id: string; name: string; kind: string }[];
		crops: { id: string; name: string }[];
		cropAreas: { nodeId: string; cropId: string; areaM2: number }[];
		boreholes?: { id: string; nodeId: string; name: string }[];
		/** Demand objects on their units (engine ≥ 1.45.0: a demandObject.add under a hidden object's id is shown by the id they gave). */
		demandObjects?: { id: string; nodeId: string; name: string }[];
	};
}

export interface ApplicantResultsRun {
	id: string;
	label: string;
	engineVersion: string;
	startDate: string;
	endDate: string;
	createdAt: string;
	baseRunId: string;
	/** Made from the application's changes and base as they are now. */
	current: boolean;
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
	/**
	 * An application's problem lines a rule hidden from its applicant broke
	 * (164): the line's index in `problems`, the ops it names (0-based) and
	 * the rules' kinds (`shares`, `area`, `supplyTrigger`…), never an id, a
	 * name or a value. What "Ask the assessors why" sends. Absent on a team
	 * scenario.
	 */
	maskedRules?: MaskedRuleRef[];
	/** Every problem line in its real words (164). Editors and up only, on an application; never to its applicant. */
	assessorProblems?: string[];
}

/** A problem line of an application's check that a hidden rule broke (ScenarioCheck.maskedRules). */
export interface MaskedRuleRef {
	problem: number;
	ops: number[];
	rules: string[];
}

/** An "Ask the assessors why" question as an application's parties read it (164): never the rule's real words. */
export interface ApplicationQuestion {
	id: string;
	askedAt: string;
	/** The problem line as the applicant read it. */
	problem: string;
	opIndexes: number[];
	rules: string[];
	answer: string | null;
	answeredAt: string | null;
}

/** The same question as the assessors read it: the application, the ops it named and the line in its real words. */
export interface AssessorQuestion extends ApplicationQuestion {
	scenarioId: string;
	scenarioName: string;
	ops: ScenarioOp[];
	assessorText: string;
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
	/** The responsible authority's endorsement of this baseline (163): null = not endorsed. Viewers and above only (absent for a farmer, or from an older API). */
	endorsement?: PublicationEndorsement | null;
}

/** Who endorsed a published baseline for the responsible authority, and when (163; POST …/publication/:pubId/endorse). */
export interface PublicationEndorsement {
	endorsedAt: string;
	/** null once that account is gone. */
	endorsedBy: string | null;
	note: string;
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

/**
 * One run's place in its project's publications (GET …/runs/:runId/publication,
 * issue #70): the printable report's published-by line and notice, and its
 * changes since the previous publication.
 */
export interface RunPublication {
	/** The run's newest publication (null: never published); the restriction as that publication has it. */
	publication: { id: string; publishedAt: string; publishedBy: string | null; supersededAt: string | null; restriction: PublicationRestriction } | null;
	/**
	 * The publication before it (a published run's earlier one of another run, or for a run never
	 * published the current one), with the net input changes from its run to this one and who made them.
	 */
	previous: {
		id: string;
		runId: string;
		runLabel: string;
		publishedAt: string;
		publishedBy: string | null;
		changes: InputChange[];
		attribution: CompareAttribution | null;
	} | null;
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
	/** null: the published baseline; 'scenario': one scenario (WP-3.15); 'pack': one evidence pack (128). */
	targetKind: ShareTargetKind | null;
	targetId: string | null;
	/**
	 * The target's name and status as the caller reads them (RLS): null for the
	 * baseline, and for a target they can't read now (an application reopened
	 * as a draft, or deleted), which the link opens nothing of. A pack's
	 * name is its report's title, with its version.
	 */
	target: { name: string; status: ScenarioStatus | PackStatus; version?: number } | null;
	/** The caller made it. */
	mine: boolean;
}

/** What a link may name besides the published baseline (backend SHARE_TARGET_KINDS). */
export type ShareTargetKind = 'scenario' | 'pack';

/** One EWR site's Reserve compliance on a shared run (backend share/links.ts SharedEwrSite). */
export interface SharedEwrSite {
	/** A gauge's name; null for the outlet. */
	name: string | null;
	isOutlet: boolean;
	months: number | null;
	met: number | null;
	rate: number | null;
	longestNotMetRun: number | null;
	/** null below the k rule (fewer than 5 farm holders). */
	deficitM3: number | null;
	byMonth: { month: number; years: number; met: number; rate: number | null }[];
}

/** What a scenario link shows of a run; `volumes` null below the k rule. */
export interface SharedRun {
	engineVersion: string;
	startDate: string;
	endDate: string;
	createdAt: string;
	ewrDaysNotMet: number | null;
	ewrFractionDaysNotMet: number | null;
	volumes: {
		meanNaturalFlowM3Day: number | null;
		meanSimulatedOutflowM3Day: number | null;
		farms: { count: number; demandM3Day: number; suppliedM3Day: number; belowTarget: number };
	} | null;
	ewrSites: SharedEwrSite[];
}

/** POST /share/scenario (public, WP-3.15): a submitted or decided scenario, redacted. */
export interface ShareScenario {
	/** Ids let a signed-in member comment from the page; they grant nothing on their own. */
	project: { id: string; name: string };
	scenario: {
		id: string;
		name: string;
		description: string;
		origin: 'team' | 'applicant';
		status: 'submitted' | 'decided';
		submittedAt: string | null;
		decidedAt: string | null;
		outcome: ScenarioOutcome | null;
		decisionNote: string;
		ops: ScenarioOp[];
		opsSha256: string;
		ownedNodeIds: string[];
		/** Names of its own nodes only; any other node is anonymous. */
		opNames: { id: string; name: string }[];
		/** Each op's class as its latest run applied it; null without a run. */
		classified: ('proposal' | 'baseline')[] | null;
	};
	/** ready: both runs verify; none: not run on its current ops; unverified: a stamp fails, so no result. */
	results: 'ready' | 'none' | 'unverified';
	base: SharedRun | null;
	run: SharedRun | null;
	/** Comments posted for public participation, oldest first; plain text. */
	comments: SharedComment[];
	/** Where written objections go, when the applicant gave it (166). */
	objection: ShareObjection | null;
}

/** A public comment as a share page shows it. */
export interface SharedComment {
	body: string;
	author: string | null;
	createdAt: string;
	editedAt: string | null;
}

/** The application's notice details on a share page (166_public_participation); null fields when not given. */
export interface ShareObjection {
	address: string | null;
	closingDate: string | null;
}

/** A band as a pack link shows it (backend share/links.ts SharedBand). */
export interface SharedBand {
	n: number | null;
	p5: number | null;
	p50: number | null;
	p95: number | null;
}

/** One row of a shared pack's change table: the river's rows, and the volume rows past the k rule. */
export interface SharedPackRow {
	id: 'reserve' | 'ewrDays' | 'noFlowDays' | 'shortfall' | 'outflowMar';
	/** A gauge's name on a reserve row; null for the outlet and every other row. */
	subject: string | null;
	unit: string;
	higherIsWorse: boolean;
	baseline: number | null;
	application: number | null;
	change: { run: number | null; band: SharedBand | null; bandNote: string | null; worse: { k: number; n: number } | null } | null;
	notAssessed: string | null;
	note: string | null;
}

/** One EWR site's Reserve compliance in a shared pack: the baseline (A) against the application (B). */
export interface SharedPackSite {
	name: string | null;
	isOutlet: boolean;
	category: string | null;
	monthsA: number | null;
	rateA: number | null;
	rateB: number | null;
	longestA: number | null;
	longestB: number | null;
	lost: number | null;
	gained: number | null;
}

/** POST /share/pack (public, 128): an issued pack's redacted figures, or a superseded or withdrawn pack's standing. */
export interface SharePack {
	/** The id lets a signed-in member comment from the page; it grants nothing on its own. */
	project: { id: string };
	pack: { id: string; title: string; mode: 'baseline' | 'application'; version: number; shortCode: string };
	/** GET /verify/:code's answer for the pack, exactly. */
	verify: PackVerification;
	/** null once the pack is superseded or withdrawn. */
	figures: {
		identity: {
			title: string;
			mode: 'baseline' | 'application';
			baseline: { startDate: string; endDate: string; engineVersion: string; runoffModel: string };
			application: { engineVersion: string; proposals: number; assumptions: number } | null;
		};
		volumes: boolean;
		rows: SharedPackRow[];
		river: SharedPackSite[];
		byMonth: { month: number; run: number | null; band: SharedBand | null }[] | null;
		disclaimerVersion: string | null;
	} | null;
	comments: SharedComment[];
	/** For an application's pack, where written objections go, when given (166). */
	objection: ShareObjection | null;
}

/** A draft pack the caller may sign as the application's appointed specialist (167_signers). */
export interface SpecialistDraft {
	id: string;
	title: string;
	version: number;
	manifestSha256: string;
	createdAt: string;
	signoffs: number;
}

/** One pack of an application as its party sees it (131_applicant_packs; backend evidence/applicantPacks.ts). */
export interface ApplicantPackMeta {
	id: string;
	scenarioId: string;
	title: string;
	mode: 'baseline' | 'application';
	version: number;
	status: Exclude<PackStatus, 'draft'>;
	issuedAt: string;
	manifestSha256: string;
	shortCode: string;
	verifyPath: string;
	supersedesId: string | null;
	supersededById: string | null;
	withdrawnReason: string | null;
	/** The caller is the application's owner: they list and revoke the links they made. */
	isOwner: boolean;
	/** The application's owner may link it, while it is issued. */
	canShare: boolean;
}

/** One of the applicant's own units in the pack (D2: by name, in full). */
export interface ApplicantPackOwnUnit {
	name: string;
	kind: 'farm' | 'user';
	onlyIn: 'application' | null;
	suppliedA: number | null;
	suppliedB: number | null;
	timeReliabilityA: number | null;
	timeReliabilityB: number | null;
	annualReliabilityA: number | null;
	annualReliabilityB: number | null;
	/** Change in share of demand supplied, percentage points. */
	change: { run: number | null; band: SharedBand | null; worse: { k: number; n: number } | null } | null;
}

/** GET /projects/:id/scenarios/:sid/packs/:packId: an application's issued pack, D2-anonymised. */
export interface ApplicantPack {
	pack: ApplicantPackMeta;
	verify: PackVerification;
	/** What a pack link shows of the frozen report, for every standing. */
	figures: NonNullable<SharePack['figures']> | null;
	/**
	 * Their own units by name; every other farm or water user downstream of the
	 * application under the anonymous name /base and the results view give it
	 * ("Farm 3"), with its change in whole points. null when a baseline
	 * assumption changed; `others` null when the run's base is no longer a
	 * published run, so those names can't be given.
	 */
	units: { own: ApplicantPackOwnUnit[]; others: { kind: 'farm' | 'user'; name: string; changePts: number }[] | null } | null;
	/** Their printable copy of it (165_applicant_copy): their own page printed as them, other water users' figures withheld. */
	copy: ApplicantCopyState;
}

/** The applicant's printable copy of a pack: ready (its own SHA-256), rendering, failed (why) or none (never asked for). */
export interface ApplicantCopyState {
	status: 'ready' | 'rendering' | 'failed' | 'none';
	sha256: string | null;
	pages: number | null;
	renderedAt: string | null;
	error: string | null;
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

/**
 * Who may read a note: the team (viewers and above), or also the farmers of
 * its farm; on a scenario (WP-3.15) also the assessors, the application's
 * parties, or everyone taking part in public participation (docs/data-model.md § Notes).
 */
export type NoteVisibility = 'team' | 'farm' | 'assessors' | 'parties' | 'public_participation';
export type NoteTargetKind = 'project' | 'node' | 'run' | 'setting' | 'scenario' | 'pack';

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
	scenarioId: string | null;
	/** The evidence pack it is about (128_pack_share_notes). */
	packId: string | null;
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
	scenarioId?: string;
	packId?: string;
	target?: NoteTargetKind;
	limit?: number;
}

/** POST /notes: at most one target; `visibility: 'farm'` only on a farm. */
export interface NoteCreate {
	body: string;
	nodeId?: string;
	runId?: string;
	settingKey?: string;
	scenarioId?: string;
	/** An evidence pack: `team` or `public_participation` only (128). */
	packId?: string;
	visibility?: NoteVisibility;
	/** A public comment only: give my name and email to the applicant for the I&AP register (GN R267 reg 18; 166). */
	registerConsent?: boolean;
}

/** GET …/notes/:noteId/revisions: each earlier text of a scenario note, oldest first. */
export interface NoteRevision {
	body: string;
	/** When this text was written (the note made, or an earlier edit). */
	writtenAt: string;
	/** When an edit replaced it. */
	editedAt: string;
}

/** How many notes the caller can see on each target (the count badges). */
export interface NoteCounts {
	project: number;
	nodes: Record<string, number>;
	runs: Record<string, number>;
	settings: Record<string, number>;
	scenarios: Record<string, number>;
	packs?: Record<string, number>;
}

/** A professional sign-off on a run or an evidence pack (036_signoff, 112_evidence_pack; docs/api.md § Sign-offs). Immutable. */
export interface Signoff {
	id: string;
	/** The run signed; null for a sign-off of an evidence pack. */
	runId: string | null;
	/** The evidence pack signed; null for a sign-off of a run. */
	packId: string | null;
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
	/** `specialist`: the professional statement of whoever is responsible for the evidence; `review`: an authority-side reviewer's (167). */
	kind: SignoffKind;
	/** The host's check of the registration against the public register (167): bound at issue, else the current one; null: self-declared. */
	registrationCheck: { checkedAt: string; checkedByOrg: string; bound: boolean } | null;
}

export type SignoffKind = 'specialist' | 'review';

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

/** GET /projects/:id/packs/:packId/signoffs: the pack statement in place of the run's (docs/api.md § Evidence packs). */
export interface PackSignoffList extends Omit<SignoffList, 'statement'> {
	statement: PackSignoffStatement;
	/** The kinds the caller may sign as: an editor both, the applicant's specialist `specialist` only, anyone else none (167). */
	kinds: SignoffKind[];
}

// --- Evidence packs (WP-3.14, issue #71, docs/evidence-pack.md, docs/api.md § Evidence packs) ---

export type PackStatus = 'draft' | 'issued' | 'superseded' | 'withdrawn';

/** One evidence pack as the API returns it (backend evidence/packs.ts PackMeta). */
export interface Pack {
	id: string;
	/** The report's title: the scenario's name, or the project's for baseline evidence. */
	title: string;
	mode: 'application' | 'baseline';
	scenarioId: string | null;
	baselineRunId: string;
	scenarioRunId: string | null;
	version: number;
	supersedesId: string | null;
	supersededById: string | null;
	status: PackStatus;
	manifestSha256: string;
	/** The manifest hash's first 12 hex digits, `xxxx-xxxx-xxxx`. */
	shortCode: string;
	/** The web page that verifies it, `/verify/<shortCode>`. */
	verifyPath: string;
	reportVersion: string;
	engineVersion: string;
	/** The server-rendered PDF's SHA-256, once recorded (119_pack_render); null until then. */
	pdfSha256: string | null;
	pdfPages: number | null;
	bundleSha256: string | null;
	createdAt: string;
	createdBy: string | null;
	issuedAt: string | null;
	issuedBy: string | null;
	/** Why it was withdrawn; null otherwise. */
	statusReason: string | null;
	/** How many sign-offs it has. */
	signoffs: number;
}

/** What stands between a draft and its issue, as stored (an editor's read of a draft; else null). */
export interface PackIssueChecks {
	issuable: boolean;
	signed: boolean;
	runsVerified: boolean;
	/** No erratum found since the draft was made applies to its runs (errataFoundSince is empty); issue refuses otherwise (pack_errata_since_draft). */
	errataRecorded: boolean;
	/** The specialist signers of the current statement whose registration has no current check (167). */
	registrationUnchecked?: string[];
	/** Whether issue waits for those checks (the project's setting; 409 registration_not_checked otherwise). */
	registrationCheckRequired?: boolean;
}

/** GET /projects/:id/packs/:packId. */
export interface PackDetail {
	pack: Pack;
	manifest: PackManifest;
	/** The stored manifest still hashes to its recorded SHA-256. */
	manifestMatches: boolean;
	signoffs: Signoff[];
	/** Where its server-rendered PDF is (119_pack_render). */
	pdf: PackPdfState;
	/** The server's re-run of its runs from the stored bundle (154_pack_reproduce): the app's own claim, never on verify. */
	reproduction: PackReproductionState;
	issue: PackIssueChecks | null;
	/** Errata that apply now to its runs' engines (or their fits') and that the manifest didn't record (132): found since it was drafted. */
	errataFoundSince: { id: string; summary: string }[];
}

/** Where an issued pack's PDF is (backend/src/evidence/packPdf.ts; docs/evidence-pack.md § The PDF). */
export interface PackPdfState {
	status: 'ready' | 'rendering' | 'failed' | 'none';
	/** Why the last render gave up (`failed`). */
	error: string | null;
}

/** One check of a reproduction bundle (engine evidence/bundle.ts checkPackBundle), plus the server's `stored`. */
export interface PackBundleCheck {
	/** `stored`, `archive`, `files`, `manifest`, `runs`, `inputs:<run>`, `changes`, `scenario`, `results:<run>`, `reproduce:<run>`. */
	id: string;
	ok: boolean;
	detail: string;
}

/**
 * The server's re-run of an issued pack from its stored bundle
 * (backend/src/evidence/packReproduce.ts; docs/evidence-pack.md § Reproduction).
 * A recorded outcome: `reproduced`, `not_reproduced`, `other_engine` (only the
 * re-runs differ, and the runs were made with another engine) or `no_bundle`;
 * else `checking` (its job is queued or running), `failed` (the job gave up:
 * `error`) or `none` (a draft, or issued before re-runs).
 */
export interface PackReproductionState {
	status: 'reproduced' | 'not_reproduced' | 'other_engine' | 'no_bundle' | 'checking' | 'failed' | 'none';
	/** The engine that re-ran the runs (a recorded outcome only). */
	engineVersion: string | null;
	/** The engines the runs were made with. */
	runEngines: string[];
	checkedAt: string | null;
	checks: PackBundleCheck[];
	error: string | null;
	/** The engine this server re-runs with. */
	serverEngine: string;
	/** An editor may ask for a re-run now (POST …/reproduce): issued, none pending, no outcome on serverEngine yet. */
	canRerun: boolean;
}

/** GET /verify/:code (public): only what the pack prints (app_verify_pack). */
export interface PackVerification {
	status: Exclude<PackStatus, 'draft'>;
	version: number;
	issuedAt: string;
	catchment: string;
	engineVersion: string;
	reportVersion: string;
	manifestSha256: string;
	shortCode: string;
	pdfSha256: string | null;
	/** The reproduction bundle's SHA-256 (122_pack_bundle); null for a pack issued before bundles. */
	bundleSha256: string | null;
	successorSha256: string | null;
	withdrawnReason: string | null;
	methodology: { version: string | null; sha256: string | null };
	/** The errata the manifest recorded when the pack was drafted, as recorded. */
	errata: { id: string; summary: string }[];
	/** Errata that apply now to the runs' engines (or their fits') and that the manifest didn't record: found since issue (132). */
	errataFoundSince: { id: string; summary: string }[];
	signers: {
		fullName: string;
		registrationBody: string;
		registrationCategory: string | null;
		registrationField: string | null;
		registrationNo: string;
		signedAt: string;
		/** Who signed as what (167); absent from an answer older than it. */
		kind?: SignoffKind;
		/** The check bound when the pack was issued; null or absent: the registration is self-declared (167). */
		registrationCheck?: { checkedAt: string; checkedByOrg: string } | null;
	}[];
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
	/** A pack only: `review` for an editor signing as the authority's reviewer (167); default `specialist`. */
	kind?: SignoffKind;
}

/** The host's check of a member's registration against the public register (167; GET /projects/:id/registration-checks). */
export interface RegistrationCheck {
	id: string;
	userId: string | null;
	registrationBody: string;
	registrationCategory: string;
	registrationNo: string;
	registerName: string;
	outcome: 'registered' | 'not_registered';
	checkedByOrg: string;
	checkedAt: string;
	note: string;
	/** The display name of the owner who recorded it. */
	recordedBy: string | null;
	recordedAt: string;
}

export interface RegistrationCheckRequest {
	registrationBody: 'sacnasp' | 'ecsa';
	registrationCategory: string;
	registrationNo: string;
	registerName: string;
	outcome: 'registered' | 'not_registered';
	checkedByOrg: string;
	checkedAt: string;
	note?: string;
}

/** GET …/scenarios/:sid/participation-export (166): the reg 19 record of one application. */
export interface ParticipationExport {
	application: {
		id: string;
		name: string;
		status: string;
		submittedAt: string | null;
		decidedAt: string | null;
		outcome: string | null;
		objectionAddress: string | null;
		objectionClosingDate: string | null;
	};
	links: { target: 'application' | 'pack'; packVersion: number | null; createdAt: string; expiresAt: string; revokedAt: string | null }[];
	comments: {
		id: string;
		target: 'application' | 'pack';
		packVersion: number | null;
		author: string | null;
		email: string | null;
		registerConsent: boolean;
		viaLink: boolean;
		createdAt: string;
		editedAt: string | null;
		state: 'shown' | 'withdrawn' | 'removed';
		deletedAt: string | null;
		body: string | null;
		revisions: { body: string; writtenAt: string; editedAt: string }[];
	}[];
	register: { name: string; email: string }[];
}

// --- Allocations (WP-3.10, docs/allocations.md, docs/api.md § Allocations) ---

/** Mirrors backend allocations/parse.ts `Authorisation` (and 136's CHECK); a registration is not an entitlement (issue #281). */
export type AllocationAuthorisation =
	| 'registration'
	| 'licence'
	| 'general_authorisation'
	| 'schedule_1'
	| 'existing_lawful_use_claimed'
	| 'existing_lawful_use';
export type AllocationPurpose = 'irrigation' | 'domestic' | 'livestock' | 'industry' | 'mining' | 'municipal' | 'other';
export type AllocationWaterSourceKind = 'surface' | 'groundwater';
export type AllocationImportKind = 'warms_extract' | 'csv';
/** The NWA s21 water use (142, issue #72): 21a a take per year, 21b a dam's storage only (volume 0). */
export type AllocationWaterUse = '21a' | '21b';

/**
 * A cap run's water years for one unit and source (GET …/runs/:runId/allocations
 * `capYears`, from RunSummary.allocations): the years the registered volume was
 * used up, and the days per year the licence limit held use back, by limit
 * (engine ≥ 1.40.0; null on an older run).
 */
export interface AllocationCapYears {
	nodeId: string;
	waterSource: AllocationWaterSourceKind;
	capReached: { waterYear: number; budgetM3: number; usedM3: number }[];
	limitBound: { waterYear: number; days: number; volumeDays: number; rateDays: number; monthsDays: number }[] | null;
}

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
	/** Licence conditions (103, issue #72): calendar months of use (null = none stated), the most it may take at once (m³/s), conditions in words. A cap run applies the months and the rate (engine ≥ 1.37.0); the conditions in words are only shown. */
	months: number[] | null;
	maxRateM3s: number | null;
	conditions: string[];
	waterUse: AllocationWaterUse;
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

/** The licence decision a project's evidence supports, and how long its licence record is kept (161_licence_record, docs/api.md § Licence record). */
export type LicenceOutcome = 'granted' | 'refused' | 'withdrawn';
export interface LicenceRecord {
	outcome: LicenceOutcome | null;
	outcomeOn: string | null;
	expiresOn: string | null;
	reason: string;
	/** When the record may be deleted: the expiry (granted) or the decision date, + 3 years; null without an outcome. */
	closesOn: string | null;
	/** While no outcome is recorded: when the owners must next confirm the record is still needed; null before the first issued pack or nomination. */
	reviewDueOn: string | null;
}
export type LicenceOutcomeInput =
	| { outcome: 'granted'; outcomeOn: string; expiresOn: string; reason: string }
	| { outcome: 'refused' | 'withdrawn'; outcomeOn: string; reason: string }
	| { outcome: null; reason: string };

export interface AllocationList {
	allocations: Allocation[];
	sources: AllocationSource[];
	/** The farms and water users an allocation can be matched to. */
	nodes: { id: string; name: string }[];
	/** Editors and owners see holder names (decision D3); viewers see volumes only. */
	canSeeHolders: boolean;
	/** The owners let viewers read each registered volume (162, D3). */
	viewerUnits: boolean;
	/** This caller is a viewer who can't (allocations is then empty): `totals` instead. */
	unitsHidden: boolean;
	/** Per water source held by 5 or more registered users; null unless unitsHidden. */
	totals: AllocationTotal[] | null;
}

/** A water source's registered volumes in force today, summed (a viewer's view, 162). */
export interface AllocationTotal {
	waterSource: 'surface' | 'groundwater';
	holders: number;
	registeredM3PerYear: number;
	storageM3: number | null;
}

/** A run's modelled use against the registered volumes, summed per water source and year (a viewer's view, 162). */
export interface AllocationComparisonTotals {
	tolerance: number;
	sources: {
		waterSource: 'surface' | 'groundwater';
		holders: number;
		units: number;
		years: { waterYear: number; partial: boolean; registeredM3: number; modelledM3: number; status: import('@water-management/engine').AllocationStatus }[];
	}[];
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
	months?: number[] | null;
	maxRateM3s?: number | null;
	conditions?: string[];
	/** Default '21a'. A '21b' row has volume 0, a storage and surface water. */
	waterUse?: AllocationWaterUse;
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
	months: number[] | null;
	maxRateM3s: number | null;
	conditions: string[];
	waterUse: AllocationWaterUse;
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

/** One scenario of a cumulative assessment (backend assessments/store.ts AssessmentMemberRow). */
export interface AssessmentMember {
	id: string;
	position: number;
	/** The scenario it was copied from; null once a team scenario is deleted (the copy stays). */
	scenarioId: string | null;
	name: string;
	origin: 'team' | 'applicant';
	opsSha256: string;
	opCount: number;
	/** done: its run alone is stored; problems: its ops don't apply alone; failed: the engine refused it. */
	status: 'pending' | 'done' | 'problems' | 'failed';
	problems: string[];
	startDate: string | null;
	endDate: string | null;
}

/** A cumulative impact assessment (roadmap WP-3.11, docs/api.md § Assessments). */
export interface Assessment {
	id: string;
	name: string;
	baseRunId: string;
	baseRun: { id: string; label: string; createdAt: string };
	/** refused: the scenarios no longer combine (`problems`); failed: the engine refused an input. */
	status: 'pending' | 'complete' | 'refused' | 'failed';
	problems: string[];
	/** Only on GET …/assessments/:aid, and only when complete. */
	report?: CumulativeReport | null;
	engineVersion: string | null;
	job: { id: string; status: JobMeta['status']; error: string | null; progress: number | null } | null;
	createdBy: string | null;
	createdAt: string;
	completedAt: string | null;
	members: AssessmentMember[];
}

/** POST /projects/:id/assessments. */
export interface AssessmentRequest {
	name: string;
	scenarioIds: string[];
	/** Only check that the scenarios combine; write nothing. */
	dryRun?: boolean;
}

/** Whether scenarios combine: the 422's details, or a dry run's answer. */
export interface AssessmentCheck {
	ok: boolean;
	conflicts: ScenarioConflict[];
	problems: string[];
}

/** One fit of a server run of the calibration rules (docs/api.md § Automated calibration, issue #153). */
export interface AutoCalibrationCase {
	label: string;
	pan: { id: string; label: string; values: number[] | null };
	bounds: CalibrationBounds;
	objective: ObjectiveId;
	/** The held-out score the rules keep a fit by; null when the record doesn't allow the test. */
	score: number | null;
	naturalMarMm3: number | null;
	eligible: boolean;
	reasons: string[];
	filters: FilterResult[];
	error: string | null;
	/** The fitted parameters (the free ones); null when the fit failed. */
	params: Record<string, number> | null;
}

/** A server run of the project's calibration rules (backend calibration/store.ts AutoCalibrationRow). */
export interface AutoCalibration {
	id: string;
	/** manual: an editor asked; new_data: new observed or rain data queued it (calibrationRules.after.onNewData). */
	trigger: 'manual' | 'new_data';
	status: 'running' | 'complete' | 'failed';
	rulesRevision: number;
	rules: CalibrationRules;
	plan: { flowKind: string; /** The calibration site (engine ≥ 1.41.0): null = the outlet; absent on a run from before. */ siteNodeId?: string | null; validationRecord: string | null; years: FlaggedYearShare[]; ruleExclusions: CalibrationExclusion[]; notes: string[]; cases: { label: string }[] };
	cases: AutoCalibrationCase[];
	report: { chosen: number | null; notes: string[] } | null;
	chosen: number | null;
	error: string | null;
	engineVersion: string;
	job: { id: string; status: JobMeta['status']; error: string | null; progress: number | null } | null;
	createdBy: string | null;
	createdAt: string;
	completedAt: string | null;
	appliedBy: string | null;
	appliedAt: string | null;
	appliedRunId: string | null;
	uncertaintyId: string | null;
}

/** A water year an outlook left out (docs/api.md § Seasonal outlooks): the engine's reasons, or the backend's. */
export type OutlookExcludedYear = OutlookExcluded | { waterYear: number; reason: 'overLimit' | 'memberFailed' };

/** An outlook's result: the engine's SeasonalOutlook, with the backend's exclusions and the members the engine refused. */
export type OutlookResult = Omit<SeasonalOutlook, 'excluded'> & {
	excluded: OutlookExcludedYear[];
	failures: { levelId: string; label: string; waterYear: number; message: string }[];
};

/** A trigger table as stored (backend outlooks/store.ts StoredTriggerTable): the engine's ReviewTriggers without each band's whole outlook. */
export type OutlookTriggerTable = Omit<ReviewTriggers, 'rows'> & { rows: Omit<ReviewTriggerRow, 'outlook'>[] };

/**
 * An outlook's review triggers (issue #53 R6, backend StoredTriggers): the
 * season's review date, and the table drawn on the latest review date the
 * base run's record holds (null with `problem` when it couldn't be).
 */
export interface OutlookTriggers {
	reviewDate: string;
	table: OutlookTriggerTable | null;
	problem: string | null;
	excluded: OutlookExcludedYear[];
	failures: { levelId: string; label: string; waterYear: number; message: string; bandFromM3: number }[];
}

/** An outlook published to farmers (issue #53 R5, backend outlooks/publication.ts OutlookPublicationRow). */
export interface OutlookPublication {
	id: string;
	outlookId: string | null;
	level: { id: string; label: string };
	decisionDate: string;
	seasonEnd: string;
	reviewDate: string | null;
	engineVersion: string;
	publishedBy: string | null;
	publishedAt: string;
	endedAt: string | null;
	farms: number;
}

/** A seasonal outlook (issue #53 R5, docs/api.md § Seasonal outlooks, backend outlooks/store.ts OutlookRow). */
export interface Outlook {
	id: string;
	name: string;
	baseRunId: string;
	baseRun: { id: string; label: string; createdAt: string };
	decisionDate: string;
	seasonEnd: string;
	/** The season's review date (R6); null = no trigger table. Absent from an older API. */
	reviewDate?: string | null;
	/** null = the engine's default share (O6). */
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
	/** Likewise; null without a review date. */
	triggers?: OutlookTriggers | null;
}

/** POST /projects/:id/outlooks. Season and share absent: the project's settings. */
export interface OutlookRequest {
	name: string;
	baseRunId: string;
	levels: { label: string; ops: ScenarioOp[] }[];
	decisionDate?: string;
	seasonEnd?: string;
	planningShare?: number;
	/** Absent: the project's setting; null: no trigger table. */
	reviewDate?: string | null;
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

// --- Catchment map (issue #288, WP-3.12; docs/api.md § Catchment map, docs/maps.md) ---

/** Mirrors backend geo/routes.ts MAP_FEATURE_KINDS (and 152's CHECK). */
export type MapFeatureKind = 'catchment_boundary' | 'farm_parcel' | 'dam' | 'gauge' | 'river' | 'other';
export type MapPosition = [number, number];
/** GeoJSON geometry as the server stores it: WGS84 longitude/latitude, 2D. */
export type MapGeometry =
	| { type: 'Point'; coordinates: MapPosition }
	| { type: 'LineString'; coordinates: MapPosition[] }
	| { type: 'MultiLineString'; coordinates: MapPosition[][] }
	| { type: 'Polygon'; coordinates: MapPosition[][] }
	| { type: 'MultiPolygon'; coordinates: MapPosition[][][] };

/** One feature on the map (GET /projects/:id/map/features). */
export interface MapFeature {
	id: string;
	kind: MapFeatureKind;
	name: string;
	nodeId: string | null;
	nodeName: string | null;
	geometry: MapGeometry;
	properties: Record<string, string>;
	/** Geodesic area of a polygon, m², computed on the server; null for points and lines. */
	areaM2: number | null;
	/** Of its area, what drains into pans (m²), when it was made from a delineation (195); null when unknown. Its effective area is areaM2 less it. */
	nonContributingM2: number | null;
	/** A dam polygon's position against its river, as an editor said (194); null = not said, its outline decides. Always null for anything else. */
	damPosition: DamPosition | null;
	/** A point at its middle (lon, lat). */
	center: MapPosition;
	sourceId: string | null;
	createdBy: string | null;
	createdAt: string;
	updatedAt: string;
}

/** One feature on a farm's map (GET /projects/:id/farm/:nodeId/map, issue #326 A3): the farm's own parcels and dams, the boundary, rivers and gauges. No node, no properties, no author. */
export interface FarmMapFeature {
	id: string;
	kind: Exclude<MapFeatureKind, 'other'>;
	name: string;
	geometry: MapGeometry;
	areaM2: number | null;
	center: MapPosition;
	/** The licence credit the map shows while it draws this feature: 'hydrorivers' on a river added from a HydroRIVERS reach. */
	credit?: 'hydrorivers';
}

/** GET /projects/:id/farm/:nodeId/map: empty when the farm has no parcel or dam of its own on the map. */
export interface FarmMap {
	features: FarmMapFeature[];
}

export interface MapSource {
	id: string;
	fileName: string;
	sha256: string;
	crs: string;
	importedAt: string;
	importedBy: string | null;
	features: number;
}

/** Which of a delineated feature's areas a unit took (195): all of it, or without what drains into pans. */
export type MapAreaBasis = 'gross' | 'effective';

/** A node and where its area came from (152 node.area_source). */
export interface MapNodeArea {
	id: string;
	name: string;
	kind: 'farm' | 'gauge' | 'user';
	areaKm2: number;
	areaSource: 'typed' | 'map';
	/** With areaSource 'map': which of the feature's areas it took (195); null when typed. */
	areaBasis: MapAreaBasis | null;
	areaFeatureId: string | null;
}

export interface MapFeatureList {
	features: MapFeature[];
	sources: MapSource[];
	nodes: MapNodeArea[];
	/** The quaternary datasets loaded (empty: the lookup has nothing to propose from). */
	quaternaryDatasets: { dataset: string; count: number }[];
}

/** GET …/map/linked-nodes: the nodes at least one feature is linked to, each once (no geometry). */
export interface MapLinkedNodes {
	nodeIds: string[];
}

/**
 * Where a dam stands against its river (194, backend subcatchments.ts DamPosition): on the watercourse (the river forms its
 * reservoir), or an off-channel storage dam beside it, filled by a pump or a furrow. Start and Divide place the dam by it.
 */
export type DamPosition = 'on_channel' | 'off_channel';

/** POST/PATCH …/map/features: a point from the coordinates form, or a geometry. */
export interface MapFeatureInput {
	kind?: MapFeatureKind;
	name?: string;
	nodeId?: string | null;
	/** A dam polygon's position against its river; null clears it. PATCH only, and only for a dam polygon (else 400). */
	damPosition?: DamPosition | null;
	lon?: number;
	lat?: number;
	geometry?: MapGeometry;
	/** A dam outline traced from the water occurrence data (issue #326 C2): where and how, and whether it was adjusted after. POST only. */
	traced?: { lon: number; lat: number; minOccurrence: MinOccurrence; edited: boolean };
}

/** The share of observations (%) a cell must be water in to count when tracing a dam (issue #326 C2). */
export type MinOccurrence = 10 | 25 | 50 | 75;

/** GET …/map/dam-trace: whether the server has water occurrence data, and which. */
export interface DamTraceState {
	available: boolean;
	dataset: { label: string; attribution: string; fingerprint: string; maxZoom: number; bounds: [number, number, number, number] } | null;
}

/** POST …/map/dam-trace: the outline of the water round a click, proposed (nothing saved; docs/api.md § Catchment map). */
export interface DamTraceProposal {
	click: MapPosition;
	/** The water cell the trace started from (the click, or the nearest water within about 60 m). */
	seed: MapPosition;
	snapDistanceM: number;
	geometry: Extract<MapGeometry, { type: 'Polygon' }>;
	areaM2: number;
	cells: number;
	cellSizeM: number;
	zoom: number;
	minOccurrence: MinOccurrence;
	dataset: string;
	attribution: string;
	datasetFingerprint: string;
	method: string;
	methodVersion: string;
}

/** One problem in an imported file (422 `details`): the feature's place from 1, or null for the file. */
export interface MapImportProblem {
	feature: number | null;
	message: string;
}

/** One feature of a file in the import's review (POST …/map/import/preview, issue #326 D2). A refused feature has no geometry type and no kind. */
export interface MapImportPreviewFeature {
	index: number;
	geometryType: MapGeometry['type'] | null;
	name: string;
	areaM2: number | null;
	/** The proposed kind: from the feature's `kind`/`type`/`layer` property, or inferred from its shape. */
	kind: MapFeatureKind | null;
	kindFrom: 'property' | 'geometry' | null;
	/** Why a kind the file gave wasn't used. */
	note?: string;
	/** The node of the same name, of a kind the proposed kind can stand for. */
	nodeId: string | null;
}

/** The review before an import: nothing is saved until POST …/map/import with each feature's kind. */
export interface MapImportPreview {
	fileName: string;
	sha256: string;
	/** The same file is in the project already: the import would be refused. */
	duplicate: boolean;
	/** The project's catchment boundary now (its name, possibly empty), or null: a row imported as the boundary replaces it, only with `replaceBoundary: true`. */
	currentBoundary: { name: string } | null;
	features: MapImportPreviewFeature[];
	problems: MapImportProblem[];
	/** The project's nodes, for each row's Stands for. */
	nodes: { id: string; name: string; kind: MapNodeArea['kind'] }[];
}

/** One feature as the editor reviewed it (POST …/map/import `features`). */
export interface MapImportReviewed {
	index: number;
	kind: MapFeatureKind;
	name?: string;
	nodeId?: string | null;
}

/** The reference values the quaternary at a point proposes (GET …/map/quaternary). Never applied by the server. */
export interface QuaternaryProposal {
	code: string;
	dataset: string;
	/** The repo's invented dataset: never real values. */
	synthetic: boolean;
	areaKm2: number | null;
	mapMm: number | null;
	marMm3: number | null;
	monthlyMm3: number[] | null;
	periodStart: number | null;
	periodEnd: number | null;
	source: string;
	loadedAt: string;
}

export interface QuaternaryLookup {
	point: MapPosition;
	quaternary: QuaternaryProposal | null;
	datasets: { dataset: string; count: number }[];
}

/** The quaternary outlines around a bbox (GET …/map/quaternaries, issue #326 A6): codes and polygons only. */
export interface QuaternaryLayer {
	bbox: [number, number, number, number];
	quaternaries: { code: string; dataset: string; synthetic: boolean; geometry: MapGeometry }[];
	/** More met the bbox than one answer carries (the first by code are given). */
	truncated: boolean;
	datasets: { dataset: string; count: number }[];
}

/** A reach of the loaded river network (GET …/map/rivers, issue #345). */
export interface RiverReach {
	dataset: string;
	/** The source's own id (HydroRIVERS' HYRIV_ID). */
	reachId: number;
	/** '' when the source names none (HydroRIVERS never does). */
	name: string;
	strahler: number | null;
	upstreamKm2: number | null;
	lengthKm: number | null;
	dischargeM3s: number | null;
	/** The repo's invented network: never real rivers. */
	synthetic: boolean;
	source: string;
	geometry: MapGeometry;
	/** The project's river feature made from this reach (POST …/map/rivers/add), or null. */
	featureId: string | null;
}

/** The river network around a bbox (GET …/map/rivers, issue #345): the highest orders first, at most 1000. */
export interface RiverLayer {
	bbox: [number, number, number, number];
	reaches: RiverReach[];
	/** More met the bbox than one answer carries (the smallest streams are left out). */
	truncated: boolean;
	datasets: { dataset: string; count: number }[];
}

/** A gauging station proposed as the observed-flow source (GET …/map/stations, issue #326 B-gauge). Never applied by the server. */
export interface GaugeStationProposal {
	/** The DWS station code, e.g. A2H012 (Z… in the synthetic dataset). */
	code: string;
	name: string;
	river: string;
	lon: number;
	lat: number;
	catchmentKm2: number | null;
	/** YYYY-MM-DD; recordEnd null = still open (or not given). */
	recordStart: string | null;
	recordEnd: string | null;
	/** Years the record spans, to one decimal; null without a start date. */
	recordYears: number | null;
	/** Great-circle distance from the point, km. */
	distanceKm: number;
	dataset: string;
	/** The repo's invented dataset: never a real station. */
	synthetic: boolean;
	source: string;
}

/** Where the point came from: given, the map gauge linked to the outflow gauge node, or the boundary's centre. */
export type GaugeStationPointFrom = 'query' | 'outlet_gauge' | 'boundary_centre';

export interface GaugeStationLookup {
	/** Null when no point was given and the map has neither an outlet gauge nor a boundary. */
	point: MapPosition | null;
	pointFrom: GaugeStationPointFrom | null;
	/** The outlet gauge's or the boundary's name on the map (null for a given point). */
	pointName: string | null;
	withinKm: number;
	/** River gauges within withinKm, nearest first, at most 10. */
	stations: GaugeStationProposal[];
	datasets: { dataset: string; count: number }[];
}

/** A loaded land-cover product (issue #326 B-landcover; docs/maps.md § Cultivated area from land cover). */
export interface CroplandDataset {
	dataset: string;
	source: string;
	version: string;
	/** How the cells were counted and a polygon summed, in words (cited in History and evidence packs). */
	method: string;
	attribution: string;
	cellDeg: number;
	classes: number[];
	loadedAt: string;
	/** The repo's invented grid: never real values. */
	synthetic: boolean;
}

/** A polygon's land-cover summary, m², or why it couldn't be read. */
export type CultivatedSummary = { areaM2: number; cultivatedM2: number } | { problem: string };

/** A planted area accepted from land cover, as it was cited then. */
export interface CropAreaFromLandCover {
	areaM2: number;
	dataset: string;
	source: string;
	version: string;
	method: string;
	basis: 'unit' | 'parcel';
	featureName: string | null;
	acceptedAt: string;
	/** The saved model still holds it (not typed over since). */
	current: boolean;
}

/** GET …/nodes/:nodeId/cropland-proposals: a unit's cultivated area from land cover, and its crops. */
export interface CroplandProposals {
	nodeId: string;
	nodeName: string;
	/** The dataset summarised (a real one before the synthetic grid); null with none loaded. */
	dataset: CroplandDataset | null;
	datasets: { dataset: string; version: string; synthetic: boolean }[];
	/** The farm parcels on the map linked to the unit; no summary without a dataset. */
	parcels: { featureId: string; name: string; areaM2?: number; cultivatedM2?: number; problem?: string }[];
	/** The parcels summed; null without parcels, a dataset, or when one couldn't be read. */
	unit: { areaM2: number; cultivatedM2: number } | null;
	/** The catchment boundary's summary, for reference (no model value takes it). */
	catchment: ({ featureId: string; name: string } & CultivatedSummary) | null;
	/** The project's crops: what the unit holds now (m²; 0 = none) and where an accepted area came from. */
	crops: { cropId: string; name: string; areaM2: number; accepted: CropAreaFromLandCover | null }[];
}

/** What an evaporation grid's values are: FAO-56 reference ET (proposed as GR4J's PE) or Class-A pan (the A-pan row). */
export type EvaporationKind = 'et0' | 'apan';
/** The settings an accepted evaporation row goes into: GR4J's monthly PE (settings.pe) or the A-pan row (settings.apanMm). */
export type EvaporationTarget = 'pe' | 'apan';

/** A loaded evaporation grid (issue #326 B-evap; docs/maps.md § Evaporation from the map). */
export interface EvaporationDataset {
	dataset: string;
	kind: EvaporationKind;
	source: string;
	version: string;
	/** How the cells were summarised and the boundary averaged, in words (cited in History and evidence packs). */
	method: string;
	attribution: string;
	firstYear: number;
	lastYear: number;
	cellDeg: number;
	originLon: number;
	originLat: number;
	loadedAt: string;
	/** The repo's invented grid: never real values. */
	synthetic: boolean;
}

/** The boundary's monthly evaporation, Oct … Sep, mm, or why it couldn't be read. */
export type EvaporationSummary = { monthlyMm: number[]; annualMm: number; coverage: number; cells: number } | { problem: string };

/** An evaporation row accepted from the map, as it was cited then. */
export interface EvaporationAccepted {
	target: EvaporationTarget;
	monthlyMm: number[];
	dataset: string;
	kind: EvaporationKind;
	source: string;
	version: string;
	method: string;
	coverage: number;
	acceptedAt: string;
	/** The saved settings still hold it (not typed over since). */
	current: boolean;
}

/** GET /projects/:id/evaporation-proposals: the boundary's evaporation from a grid, beside the saved settings. */
export interface EvaporationProposals {
	/** The dataset summarised (a real one before the synthetic grid); null with none loaded. */
	dataset: EvaporationDataset | null;
	datasets: { dataset: string; kind: EvaporationKind; version: string; synthetic: boolean }[];
	boundary: { featureId: string; name: string } | null;
	/** Where the dataset's values go; null without a dataset. */
	target: EvaporationTarget | null;
	/** Null without a dataset or a boundary. */
	proposal: EvaporationSummary | null;
	/** The saved settings: the A-pan row, the PE kind and, under 'monthly', its row. */
	/**
	 * What the settings hold now, and the project's daily A-pan record's days
	 * (series evap_apan_mm, first day to last value), which replaces the monthly
	 * A-pan row on every day it covers; null without one. Absent from an
	 * older server.
	 */
	settings: { apanMm: number[]; peKind: 'pan' | 'monthly'; peMm: number[] | null; dailyApan?: { from: string; to: string } | null };
	accepted: EvaporationAccepted[];
}

/** A registered dam near a unit's dam on the map (issue #326 B-dams; docs/api.md § Catchment map). */
export interface RegisterDamProposal {
	registerNo: string;
	name: string;
	river: string | null;
	farm: string | null;
	lon: number;
	lat: number;
	/** From the dam's place on the map, m. */
	distanceM: number;
	capacityM3: number | null;
	wallHeightM: number | null;
	surfaceAreaM2: number | null;
	completionYear: number | null;
	dataset: string;
	/** The repo's invented list: never real values. */
	synthetic: boolean;
	source: string;
	loadedAt: string;
}

/** GET …/nodes/:nodeId/dam-proposals: what the register and the map propose for a unit's dam. */
export interface DamProposals {
	nodeId: string;
	nodeName: string;
	/** The saved model's values (the proposals are compared with these, not the unsaved form). */
	current: { damCapacityM3: number; damAreaFullM2: number | null };
	/** The dam on the map linked to the unit (a polygon first), or null. */
	dam: { id: string; name: string; geometryType: MapGeometry['type']; point: MapPosition; areaM2: number | null } | null;
	radiusM: number;
	register: RegisterDamProposal[];
	/** The dam polygon's area, proposed as the full-supply area; null for a point or no dam. */
	area: { featureId: string; featureName: string; areaM2: number; method: string } | null;
	datasets: { dataset: string; count: number }[];
}

/** A catchment the DEM proposed upstream of a clicked outlet or dam wall (issue #326 B-delineate, docs/api.md § Delineation). */
export interface DelineationProposal {
	id: string;
	status: 'proposed' | 'accepted' | 'rejected' | 'superseded';
	from: 'outlet' | 'dam_wall';
	click: MapPosition;
	/** The snapped outlet: the most-accumulating cell's centre near the click. */
	outlet: MapPosition;
	snapDistanceM: number;
	geometry: Extract<MapGeometry, { type: 'Polygon' }>;
	areaM2: number;
	cells: number;
	cellSizeM: number;
	zoom: number;
	windowCells: number;
	dataset: string;
	datasetFingerprint: string;
	method: string;
	methodVersion: string;
	/** What of the catchment drains into pans, reported beside it (193, delineate-9); null on older proposals. */
	pans: PanReport | null;
	featureId: string | null;
	createdBy: string | null;
	createdAt: string;
	decidedBy: string | null;
	decidedAt: string | null;
}

/**
 * The part of a catchment that drains into pans: closed depressions on the elevation model deep, wide and capacious enough to
 * count (backend delineation/pans.ts; docs/design/delineation.md § Pans). Reported, never taken out of the area or the outline.
 */
export interface PanReport {
	nonContributingM2: number;
	count: number;
	/** The largest few by what drains into them: the floor's deepest point, its area, depth below the spill, catchment and storage over it. */
	largest: { at: MapPosition; floorM2: number; depthM: number; drainsM2: number; storageMm: number }[];
	/**
	 * The depressions that hold as much as a pan but that a mapped river flows out of (at a wall) or a dam holds: storage on a
	 * river, listed apart and not counted above (delineate-12, start-14). Absent when not checked.
	 */
	onRiver?: {
		count: number;
		largest: { at: MapPosition; floorM2: number; depthM: number; drainsM2: number; storageMm: number; by: 'river' | 'dam' }[];
	};
	method: string;
}

/** What a point on the map becomes in a model started from the map (issue #326 C3, docs/design/start-from-map.md). */
export type StartRole = 'dam' | 'abstraction' | 'user' | 'gauge';

/**
 * How a point of a start or division was put on the elevation model's channel (start-7, backend delineation/pointPlacement.ts):
 * matched to its nearby river reach's area, at the DEM's junction for the river picked at a confluence, snapped to the
 * most-drained cell near it, on the much larger channel the editor chose, on its own cell (a delineated outlet), a dam
 * polygon's most-drained cell, or the boundary's. Absent on proposals before start-7.
 */
export interface PointPlacement {
	placedBy: 'matched' | 'snapped' | 'junction' | 'larger' | 'exact' | 'polygon' | 'boundary';
	reach: { dataset: string; reachId: number; upstreamKm2: number; chosen: boolean } | null;
	/** Snapped beside a much larger channel: that channel (Use that channel puts the point on it). */
	larger: LargerChannel | null;
	/** A reach was near but no channel near the point matched its area. */
	unmatched: boolean;
	/** A dam polygon placed by the position marked on the map (194), not by its outline; absent when unmarked. */
	damPosition?: DamPosition;
}

/** A point's placement choices in a start or division request: the river picked at a confluence, the larger channel taken. */
export interface PlacementChoice {
	reach?: { dataset: string; reachId: number };
	useLarger?: boolean;
}

/** Points at confluences (a start's or division's 422 `confluence`, `details.points`): each one's rivers, picked as `reach`. */
export interface ConfluencePoint {
	/** The map feature's id; '' for the outlet gauge. */
	featureId: string;
	name: string;
	choices: ConfluenceChoice[];
}

/** One unit a start-from-the-map proposal offers, keyed by the map feature it came from. */
export interface StartUnit {
	key: string;
	featureName: string;
	role: StartRole;
	name: string;
	point: MapPosition;
	snapDistanceM: number | null;
	/** Its own sub-catchment's area (m²) and outline; null without an elevation model, and for a water user or a gauge (they own no land). */
	areaM2: number | null;
	totalAreaM2: number | null;
	geometry: Extract<MapGeometry, { type: 'Polygon' }> | null;
	/** The unit it drains into (its key), or null for the outflow gauge. */
	drainsInto: string | null;
	/** Whether drainsInto was proposed from the elevation model (false: only the default). */
	drainsIntoProposed: boolean;
	/** How its point was put on the channel; null without an elevation model (absent before start-7). */
	placement?: PointPlacement | null;
	/** Of its own area and its whole catchment, what drains into pans (m²; absent without an elevation model or before start-11). */
	nonContributingM2?: number;
	totalNonContributingM2?: number;
	/** A dam marked on or off the river on the map (194): the dam shares proposed for its unit (backend start.ts damSharesOf). */
	damShares?: DamShares;
}

/**
 * The shares a dam marked on or off its river proposes for its unit (194; docs/model.md §2.7 K and M): on the river 1 and 1;
 * off-channel, Upstream inflow to dam 0 (the river passes it by; River to dam fills it) and runoff to the dam the share of the
 * unit's area that drains to the dam's own outflow (`damCatchmentM2`).
 */
export interface DamShares {
	pctUpstreamToDam: 0 | 1;
	pctRunoffToDam: number;
	damCatchmentM2: number | null;
	/** The runoff share when the unit's area is taken effective (195): the dam's catchment less its pans over the piece less its pans; 1 on the river. Absent when unknown. */
	pctRunoffToDamEffective?: number;
	/** Of damCatchmentM2, what drains into pans (195). */
	damNonContributingM2?: number;
}

/** What the server proposed for an empty model from the map (178_start_proposal; docs/api.md § Start from the map). */
export interface StartPlan {
	fromDem: boolean;
	outlet: { featureId: string | null; name: string; point: MapPosition | null; snapDistanceM: number | null; foundIn: 'gauge' | 'delineation' | 'boundary' | null; placement?: PointPlacement | null };
	catchment: { areaM2: number | null; boundaryAreaM2: number | null };
	units: StartUnit[];
	rest: { name: string; areaM2: number | null; geometry: Extract<MapGeometry, { type: 'Polygon' | 'MultiPolygon' }> | null; nonContributingM2?: number };
	/** What of the catchment drains into pans (start-11; absent without an elevation model or before). */
	pans?: PanReport;
	/** `placement`: how a dropped point was put on the channel (start-7): one beside a larger channel can be moved there. */
	dropped: { featureId: string; name: string; reason: string; placement?: PointPlacement }[];
	warnings: string[];
	cellSizeM: number | null;
	zoom: number | null;
	windowCells: number | null;
}

/** The ticks an editor sends to apply a start proposal: every unit once, each value ticked or not. */
export interface StartTicks {
	outletName: string;
	/** `areaBasis`: with `area`, the gross area (the default) or the effective one (195). */
	units: { key: string; name: string; area: boolean; areaBasis?: MapAreaBasis; drainsInto: boolean; runoffToDam: boolean; upstreamToDam?: boolean }[];
	rest: { include: boolean; name: string; area: boolean; areaBasis?: MapAreaBasis };
}

export interface StartProposal {
	id: string;
	mode: 'start';
	status: 'proposed' | 'applied' | 'discarded' | 'superseded';
	plan: StartPlan;
	fromDem: boolean;
	dataset: string | null;
	datasetFingerprint: string | null;
	method: string;
	methodVersion: string;
	decision: unknown;
	createdBy: string | null;
	createdAt: string;
	decidedBy: string | null;
	decidedAt: string | null;
}

/** A node's values a division would replace, as they stood when it was proposed (182, docs/api.md § Start from the map). */
export interface DivideCurrent {
	areaKm2: number;
	areaSource: 'typed' | 'map';
	downstreamNodeId: string | null;
	downstreamName: string | null;
	pctRunoffToDam: number;
	/** Absent on proposals before 194. */
	pctUpstreamToDam?: number;
}

/** One point of a division: the node it stands for (null: a new gauge), its own piece, the point below it, and the node's values now. */
export interface DivideUnit {
	key: string;
	featureName: string;
	nodeId: string | null;
	name: string;
	role: StartRole;
	point: MapPosition;
	snapDistanceM: number | null;
	areaM2: number | null;
	totalAreaM2: number | null;
	geometry: Extract<MapGeometry, { type: 'Polygon' }> | null;
	drainsInto: string | null;
	current: DivideCurrent | null;
	/** How its point was put on the channel (absent before start-7). */
	placement?: PointPlacement;
	/** Of its own area and its whole catchment, what drains into pans (m²; absent before start-11). */
	nonContributingM2?: number;
	totalNonContributingM2?: number;
	/** A dam marked on or off the river on the map (194): the dam shares proposed for its unit (backend start.ts damSharesOf). */
	damShares?: DamShares;
}

/** What the server proposed to divide a model that has nodes (182; docs/api.md § Start from the map). */
export interface DividePlan {
	mode: 'divide';
	outlet: { featureId: string | null; nodeId: string; name: string; point: MapPosition; snapDistanceM: number | null; foundIn: 'gauge' | 'delineation' | 'boundary'; placement?: PointPlacement };
	catchment: { areaM2: number; boundaryAreaM2: number | null };
	units: DivideUnit[];
	rest: { areaM2: number; geometry: Extract<MapGeometry, { type: 'Polygon' | 'MultiPolygon' }> | null; nonContributingM2?: number };
	/** What of the catchment drains into pans (start-11; absent before). */
	pans?: PanReport;
	untouched: { nodeId: string; name: string; areaKm2: number }[];
	dropped: { featureId: string; name: string; reason: string; placement?: PointPlacement }[];
	warnings: string[];
	cellSizeM: number;
	zoom: number;
	windowCells: number;
}

/** The ticks an editor sends to apply a division: every point once. */
export interface DivideTicks {
	/** `areaBasis`: with `area`, the gross area (the default) or the effective one (195). */
	units: { key: string; area: boolean; areaBasis?: MapAreaBasis; drainsInto: boolean; runoffToDam: boolean; upstreamToDam?: boolean; add: boolean; name?: string }[];
	rest: { to: 'none' } | { to: 'node'; nodeId: string; areaBasis?: MapAreaBasis } | { to: 'new'; name: string; areaBasis?: MapAreaBasis };
}

export interface DivideProposal extends Omit<StartProposal, 'mode' | 'plan'> {
	mode: 'divide';
	plan: DividePlan;
}

/** GET …/map/start: whether the server has a DEM, whether the model is empty or was started from the map, and the latest proposals of either mode (newest first). */
export interface StartState {
	elevation: boolean;
	dataset: DelineationState['dataset'];
	modelEmpty: boolean;
	startedFromMap: boolean;
	proposals: (StartProposal | DivideProposal)[];
}

/** One click's piece (POST …/map/subcatchments): its incremental catchment, the land draining to it before any other click. */
export interface ClickPiece {
	/** The click's index in the request. */
	click: number;
	/** The click, snapped onto the channel. */
	point: MapPosition;
	snapDistanceM: number | null;
	/** The click whose piece this one flows into next; null for the lowest click. */
	drainsInto: number | null;
	/** Null when it is open, or its cells couldn't be outlined as a valid polygon (the area still counts them). */
	geometry: { type: 'Polygon'; coordinates: MapPosition[][] } | null;
	/** Null when it is open. */
	areaM2: number | null;
	/** Everything upstream of the click, its own piece included; null when it, or a piece above it, is open. */
	totalAreaM2: number | null;
	/** Of its own area, what drains into pans (m², start-11; null when it is open, absent before start-11): reported, not taken out. */
	nonContributingM2?: number | null;
	/** An inflow point: its catchment runs past the window routed around the clicks, so it has no whole piece and its water enters the pieces below as an inflow. */
	open: boolean;
	/** matched: put on the channel whose upstream area matches its nearby river reach's; junction: at the DEM's own junction for the river picked at a confluence; snapped: on the most-drained cell near it. */
	placedBy: 'matched' | 'snapped' | 'junction';
	/** The river reach it was matched to. */
	reach: { dataset: string; reachId: number; upstreamKm2: number } | null;
	/** Snapped beside a much larger channel: that channel, to offer instead. */
	larger: LargerChannel | null;
	/** A river reach was near but no channel near the click matched its area: that reach (the click may be on another stream). */
	unmatched: { dataset: string; reachId: number; upstreamKm2: number } | null;
}

/** GET …/map/channels?tile=i,j: one tile of the elevation model's channels (cells with ≥ minKm2 draining through them). */
export interface ChannelTileAnswer {
	tile: [number, number];
	bounds: [number, number, number, number];
	minKm2: number;
	lines: { coordinates: MapPosition[]; km2: number }[];
	cellSizeM: number;
	dataset: { label: string; fingerprint: string };
	cached: boolean;
}

/** One river at a confluence (a 422 `confluence`'s `details.choices`): pick it by sending its dataset and reach id back as `reach`. */
export interface ConfluenceChoice {
	dataset: string;
	reachId: number;
	upstreamKm2: number;
	/** The point's distance from its line (m). */
	distanceM: number;
	role: 'above' | 'below' | 'along';
	/** In words: "the river below the junction", "the tributary above the junction", … */
	label: string;
}

/** A much larger channel near a point (a 422 `larger_channel`'s `details.larger`, or a click's piece). */
export interface LargerChannel {
	at: MapPosition;
	/** From the point (m). */
	distanceM: number;
	/** What drains through it inside the routed window (km²; a floor when its catchment runs past the window). */
	km2: number;
	/** What drains through the cell the point snapped to (km²). */
	pointKm2: number;
	/** A dam outline's: the channel its outline only clips, the dam's own outflow placed instead (backend damOutflow). */
	outline?: boolean;
	/** Offered because it matches a nearby river reach (not for being 100× larger): the reach's area at the point (km²). It can be smaller than the point's channel. */
	reachKm2?: number;
}

/** POST …/map/subcatchments: one piece per click kept, in click order; the dropped clicks with why. */
export interface ClickPieces {
	pieces: ClickPiece[];
	dropped: { click: number; reason: string }[];
	/** The lowest click's index: it owns what drains to it through no other click. */
	lowest: number;
	cellSizeM: number;
	dataset: { label: string; fingerprint: string };
	method: string;
	methodVersion: string;
}

/** GET …/map/delineation: whether the server has a DEM, which, and the latest proposals (newest first). */
export interface DelineationState {
	available: boolean;
	dataset: { label: string; attribution: string; fingerprint: string; tileType: string; maxZoom: number; bounds: [number, number, number, number] } | null;
	proposals: DelineationProposal[];
	/** The project's newest delineation still with the background worker (queued or running), else null. */
	request: DelineationRequest | null;
}

/**
 * A click handed to the background worker: a catchment too large for the request, or one the editor sent there
 * (191_delineation_request, docs/api.md § Delineation). `failed`: the job died, and `error` says why.
 */
export interface DelineationRequest {
	id: string;
	status: 'queued' | 'running' | 'failed' | 'proposed' | 'refused' | 'superseded';
	from: DelineationProposal['from'];
	click: MapPosition;
	/** 0–100 while it runs (a step a window), else null. */
	progress: number | null;
	error: string | null;
	/** With `proposed`: the proposal it made (null once pruned). */
	proposal: DelineationProposal | null;
	/** With `proposed`: the river-network check that came with it. */
	check: string | null;
	/** With `refused`: the reason and sentence the request would have answered with (and the larger channel to offer). */
	refusal: { reason: string; message: string; larger?: LargerChannel } | null;
	createdAt: string;
	finishedAt: string | null;
}
