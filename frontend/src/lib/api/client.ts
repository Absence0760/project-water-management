// Typed client for the backend HTTP API (docs/api.md). Every call sends the
// session cookie (credentials: 'include') and turns a non-2xx response into an
// ApiError carrying the HTTP status and the server's message.
import type { Locale } from '@water-management/engine/languages';
import { FARMER_NOTICE_VERSION, LEGAL_VERSION } from '@water-management/engine/legal';
import type {
	AllocationComparison,
	AllocationMode,
	DailySeries,
	DayBoundary,
	InputChange,
	FarmIndex,
	FarmView,
	MemberResult,
	ModelInput,
	PairedMember,
	RecordCoverage,
	ProjectModel,
	ScenarioOp,
	ProjectSettings,
	SeriesMeta
} from '@water-management/engine';
import type {
	AddMemberResult,
	AlertChoiceChange,
	AlertEvent,
	AlertRule,
	AlertRuleChange,
	ProjectAlerts,
	Unsubscribed,
	Allocation,
	AllocationImportRequest,
	AllocationInput,
	AllocationList,
	AllocationPreview,
	AllocationSource,
	ApiKey,
	ApiKeyCreate,
	Ensemble,
	ImportReport,
	ImportResult,
	EnsembleDetail,
	EnsembleStart,
	FarmAccessPerson,
	AddFarmerResult,
	FarmRole,
	BulkFarmerResult,
	BulkFarmerRow,
	Farmer,
	SeriesWriteResult,
	FarmerEntry,
	InviteLocale,
	FieldHistory,
	HistoryPage,
	HistoryQuery,
	HistoryRevision,
	RestoreResult,
	SeriesRevisionMeta,
	Signoff,
	SignoffList,
	SignoffRequest,
	Member,
	Nomination,
	Reproduction,
	Note,
	NoteCounts,
	NoteCreate,
	NotesQuery,
	Portfolio,
	PortfolioProject,
	Project,
	ProjectFile,
	ProjectSummary,
	Publication,
	PublicationMeta,
	PublicationPatch,
	PublishRequest,
	Role,
	Run,
	RunCompareResponse,
	StoredImportReport,
	RunMeta,
	RunCatchmentDay,
	RunDay,
	RunSeriesRef,
	Scenario,
	ScenarioCheck,
	ScenarioBase,
	ScenarioOutcome,
	ScenarioStatus,
	ScenarioWithCheck,
	ShareLink,
	ShareSeries,
	ShareSeriesKey,
	ShareView,
	Team,
	TeamMember,
	TeamRole,
	User,
	UserPreferences,
	JobMeta,
	Sweep,
	SweepRequest,
	Outlook,
	OutlookPublication,
	OutlookRequest,
	YieldJob,
	YieldRequest,
	YieldResult
} from './types';

export class ApiError extends Error {
	readonly status: number;
	readonly details: unknown;
	/**
	 * The server's stable error code, on the errors a farmer can meet
	 * (docs/api.md § Errors); null otherwise. The translated pages word an
	 * error from this and the status ($lib/i18n/apiError), never from `message`.
	 */
	readonly code: string | null;
	/** Values for the code's wording (e.g. `seconds` for a sign-in lockout). */
	readonly params: Record<string, string | number>;

	constructor(status: number, message: string, details?: unknown, code: string | null = null, params: Record<string, string | number> = {}) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.details = details;
		this.code = code;
		this.params = params;
	}
}

type FetchFn = typeof fetch;

/** Human-readable fallback when the server sent no `{ error }` body. */
function statusText(status: number): string {
	switch (status) {
		case 0:
			return 'Could not reach the server';
		case 400:
			return 'The request was invalid';
		case 401:
			return 'You are not signed in';
		case 403:
			return 'You do not have permission to do that';
		case 404:
			return 'Not found';
		case 409:
			return 'That conflicts with existing data';
		case 413:
			return 'That is too large to send';
		default:
			return status >= 500 ? 'The server had a problem' : `Request failed (${status})`;
	}
}

/** Turn zod-style `details` issues into a short readable suffix. */
function describeDetails(details: unknown): string {
	if (!Array.isArray(details)) return '';
	const parts = details
		.map((d) => {
			if (d && typeof d === 'object' && 'message' in d) {
				const path = Array.isArray((d as { path?: unknown }).path)
					? ((d as { path: unknown[] }).path.join('.'))
					: '';
				return path ? `${path}: ${(d as { message: string }).message}` : String((d as { message: string }).message);
			}
			return null;
		})
		.filter((s): s is string => !!s);
	return parts.length ? ` (${parts.slice(0, 3).join('; ')}${parts.length > 3 ? '; …' : ''})` : '';
}

export function createApi(baseUrl: string, fetchFn: FetchFn = (...a) => fetch(...a)) {
	const base = baseUrl.replace(/\/+$/, '');

	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
		let res: Response;
		try {
			res = await fetchFn(`${base}${path}`, {
				method,
				credentials: 'include',
				headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
		} catch (e) {
			throw new ApiError(0, statusText(0), e);
		}
		if (res.status === 204) return undefined as T;
		const text = await res.text();
		let data: unknown = undefined;
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				data = undefined;
			}
		}
		if (!res.ok) {
			const obj = (data && typeof data === 'object' ? data : {}) as { error?: unknown; details?: unknown; code?: unknown; params?: unknown };
			const msg = typeof obj.error === 'string' && obj.error ? obj.error : statusText(res.status);
			const code = typeof obj.code === 'string' && obj.code ? obj.code : null;
			const params = obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params) ? (obj.params as Record<string, string | number>) : {};
			throw new ApiError(res.status, msg + describeDetails(obj.details), obj.details, code, params);
		}
		return data as T;
	}

	const enc = encodeURIComponent;
	const p = (id: string) => `/projects/${enc(id)}`;
	const t = (id: string) => `/teams/${enc(id)}`;

	return {
		request,
		auth: {
			me: () => request<{ user: User }>('GET', '/auth/me').then((r) => r.user),
			login: (email: string, password: string) =>
				request<{ user: User }>('POST', '/auth/login', { email, password }).then((r) => r.user),
			/**
			 * Sign up. An ordinary sign-up signs nobody in: it mails a
			 * confirmation link and answers `{ confirm, email }` (the same for a
			 * taken address, issue #57). `inviteToken` from a `/register?invite=…`
			 * link: a live invite for the same address starts the account
			 * confirmed, joined and signed in, `{ user }`. Sends `acceptTerms`,
			 * the terms version this build shows (LEGAL_VERSION): the form says
			 * signing up accepts them, and the server records which (087).
			 */
			register: (email: string, password: string, displayName: string, inviteToken?: string | null, locale?: Locale | null) =>
				request<{ user: User } | { confirm: true; email: string }>('POST', '/auth/register', {
					email,
					password,
					displayName,
					acceptTerms: LEGAL_VERSION,
					...(inviteToken ? { inviteToken } : {}),
					...(locale ? { locale } : {})
				}),
			/**
			 * The re-acceptance step (docs/legal-status.md): accept the terms
			 * version this build shows (LEGAL_VERSION) after they changed.
			 * ApiError 400 terms_not_accepted = they changed again since.
			 */
			acceptTerms: () => request<{ user: User }>('POST', '/auth/me/accept-terms', { version: LEGAL_VERSION }).then((r) => r.user),
			logout: () => request<void>('POST', '/auth/logout'),
			/** Signs out every device (this one included): revokes every session issued before now. */
			logoutEverywhere: () => request<void>('POST', '/auth/logout-everywhere'),
			/** Renames the account (1–100 characters, trimmed by the server). */
			/**
			 * Changes only the fields sent. `locale: null` goes back to following the browser.
			 * `preferences`: the keys sent replace the account's (`hiddenTabs: []` shows every section again).
			 */
			/** "I understand" on the farm view's notice: records the version this build shows (409 farm_notice_changed if it is no longer current). */
			acknowledgeFarmNotice: () =>
				request<{ user: User }>('POST', '/auth/me/farm-notice', { version: FARMER_NOTICE_VERSION }).then((r) => r.user),
			updateMe: (patch: { displayName?: string; locale?: Locale | null; volumeUnit?: 'm3' | 'ML'; preferences?: Partial<UserPreferences> }) =>
				request<{ user: User }>('PATCH', '/auth/me', patch).then((r) => r.user),
			/**
			 * Changes the password: every other session is signed out and this
			 * browser gets a fresh cookie. ApiError 403 = wrong current password,
			 * 429 = the address is locked (the sign-in lockout), 400 = invalid new password.
			 */
			changePassword: (currentPassword: string, newPassword: string) =>
				request<{ user: User }>('POST', '/auth/change-password', { currentPassword, newPassword }).then(
					(r) => r.user
				)
		},
		projects: {
			list: () => request<{ projects: ProjectSummary[] }>('GET', '/projects').then((r) => r.projects),
			/** The portfolio's figures for every project you can see (the project list's outcome columns, issue #17). */
			outcomes: () => request<{ projects: PortfolioProject[] }>('GET', '/projects/outcomes').then((r) => r.projects),
			/** `teamId` null/omitted = a personal project. */
			create: (name: string, description?: string, teamId?: string | null) =>
				request<{ project: Project }>('POST', '/projects', {
					name,
					description,
					...(teamId ? { teamId } : {})
				}).then((r) => r.project),
			get: (id: string) => request<{ project: Project }>('GET', p(id)).then((r) => r.project),
			update: (
				id: string,
				patch: {
					name?: string;
					description?: string;
					/** An IANA zone name (issue #45): the date in the project's download file names. */
					timeZone?: string;
					/** The WUA the farm pages' contact lines name (095_wua_name); '' or null clears it. */
					wuaName?: string | null;
					settings?: Partial<ProjectSettings>;
					/** Move into a team you're in, or null for personal. Owner only. */
					teamId?: string | null;
					/** Why the settings changed, kept in the history (only with `settings`). */
					reason?: string;
				}
			) => request<{ project: Project }>('PATCH', p(id), patch).then((r) => r.project),
			remove: (id: string) => request<void>('DELETE', p(id)),
			/**
			 * What the importer flagged when the project was imported; null when it
			 * wasn't (the server's `200 { report: null }`). A 404 (no such project,
			 * or not a member) throws.
			 */
			importReport: (id: string) =>
				request<{ report: StoredImportReport | null }>('GET', `${p(id)}/import-report`).then((r) => r.report),
			copy: (id: string, name: string) =>
				request<{ project: Project }>('POST', `${p(id)}/copy`, { name }).then((r) => r.project),
			/**
			 * Create a project from a project document (docs/api.md § Import a project
			 * file): one transaction, so a failure creates nothing. `teamId` puts it in
			 * a team you may add to; `run` runs it after the import commits, and a run
			 * that fails comes back as `runError` with the project still created.
			 * `report` (the review's notes and unmapped report) is stored with the
			 * project in the same transaction; it replaces any `importReport` the
			 * file itself carries.
			 */
			importProject: (file: ProjectFile, opts: { teamId?: string | null; run?: boolean; report?: ImportReport } = {}) => {
				const q = new URLSearchParams();
				if (opts.teamId) q.set('teamId', opts.teamId);
				if (opts.run) q.set('run', '1');
				const body = opts.report ? { ...file, importReport: opts.report } : file;
				return request<ImportResult>('POST', `/projects/import${q.size ? `?${q}` : ''}`, body).then((r) => ({
					project: r.project,
					...(r.runId ? { runId: r.runId } : {}),
					...(r.runError ? { runError: r.runError } : {})
				}));
			}
		},
		members: {
			list: (id: string) =>
				request<{ members: Member[] }>('GET', `${p(id)}/members`).then((r) => r.members),
			/** An address with no account gets a pending invite instead (`{ invited: true, invite }`). */
			add: (id: string, email: string, role: Role) =>
				request<AddMemberResult<Member>>('POST', `${p(id)}/members`, { email, role }),
			setRole: (id: string, userId: string, role: Role) =>
				request<{ member: Member }>('PATCH', `${p(id)}/members/${enc(userId)}`, { role }).then(
					(r) => r.member
				),
			/** Put an applicant in an applying party, or take them out (null); owners only. */
			setParty: (id: string, userId: string, party: string | null) =>
				request<{ member: Member }>('PATCH', `${p(id)}/members/${enc(userId)}`, { party }).then((r) => r.member),
			remove: (id: string, userId: string) =>
				request<void>('DELETE', `${p(id)}/members/${enc(userId)}`)
		},
		/**
		 * Farmer members and their farms (WP-2.1), and pending farmer invites
		 * (WP-2.2; listed for owners only). A farmer leaves or is removed through
		 * members.remove; an invite is revoked through the project's invites.
		 */
		farmers: {
			list: (id: string) => request<{ farmers: FarmerEntry[] }>('GET', `${p(id)}/farmers`).then((r) => r.farmers),
			/**
			 * A verified account is added (`{ farmer }`); any other address is invited (`{ invited: true, invite }`).
			 * `role: 'contributor'` adds or invites a licence applicant with their farms (WP-3.3).
			 */
			add: (id: string, email: string, nodeIds: string[], locale: InviteLocale = 'en', role: FarmRole = 'farmer') =>
				request<AddFarmerResult>('POST', `${p(id)}/farmers`, { email, nodeIds, locale, role }),
			/** Many rows at once, one farm each; `dryRun` returns the outcomes without writing or mailing anything. */
			bulk: (id: string, rows: BulkFarmerRow[], dryRun = false) =>
				request<{ results: BulkFarmerResult[]; dryRun: boolean }>('POST', `${p(id)}/farmers/bulk`, { rows, dryRun }).then((r) => r.results),
			setFarms: (id: string, userId: string, nodeIds: string[]) =>
				request<{ farmer: Farmer }>('PUT', `${p(id)}/farmers/${enc(userId)}`, { nodeIds }).then((r) => r.farmer)
		},
		/**
		 * The phone-first farmer view (WP-2.6, docs/design/farmer-view.md): a
		 * farmer's own farms from the current publication. A farmer gets these
		 * and nothing else under /projects/:id (403); viewer+ may call them to
		 * preview a farm as its farmer sees it.
		 */
		farm: {
			/** The farms the caller may open in a project, and whether anything is published (publication null = not yet). */
			index: (id: string) => request<FarmIndex>('GET', `${p(id)}/farm`),
			/** Everything one farm's page renders, in one response. */
			view: (id: string, nodeId: string) => request<FarmView>('GET', `${p(id)}/farm/${enc(nodeId)}`),
			/** The farm's own daily figures from the published run, as a CSV download (a plain link: the cookie goes with it). */
			exportUrl: (id: string, nodeId: string) => `${base}${p(id)}/farm/${enc(nodeId)}/export.csv`,
			/** "Who can see my farm": the people who can read it, by name and role (never emails). */
			access: (id: string, nodeId: string) =>
				request<{ people: FarmAccessPerson[] }>('GET', `${p(id)}/farm/${enc(nodeId)}/access`).then((r) => r.people)
		},
		reports: {
			/**
			 * A finished report PDF (a plain link: the cookie goes with it). The
			 * API checks membership, then redirects to a one-minute pre-signed
			 * GET, so the link itself never expires but grants nothing alone.
			 * The rest of the report calls are components/report/serverPdf.ts.
			 */
			pdfUrl: (id: string, jobId: string) => `${base}${p(id)}/reports/${enc(jobId)}/pdf`
		},
		teams: {
			list: () => request<{ teams: Team[] }>('GET', '/teams').then((r) => r.teams),
			create: (name: string) => request<{ team: Team }>('POST', '/teams', { name }).then((r) => r.team),
			get: (id: string) => request<{ team: Team; members: TeamMember[] }>('GET', t(id)),
			rename: (id: string, name: string) =>
				request<{ team: Team }>('PATCH', t(id), { name }).then((r) => r.team),
			/** The portfolio's traffic-light cut-offs (team admin, D11); null goes back to the defaults. */
			setThresholds: (id: string, thresholds: { green: number; amber: number } | null) =>
				request<{ team: Team }>('PATCH', t(id), { settings: { portfolio: { thresholds } } }).then((r) => r.team),
			remove: (id: string) => request<void>('DELETE', t(id)),
			/** An address with no account gets a pending invite instead (`{ invited: true, invite }`). */
			addMember: (id: string, email: string, role: TeamRole) =>
				request<AddMemberResult<TeamMember>>('POST', `${t(id)}/members`, { email, role }),
			setRole: (id: string, userId: string, role: TeamRole) =>
				request<{ member: TeamMember }>('PATCH', `${t(id)}/members/${enc(userId)}`, { role }).then(
					(r) => r.member
				),
			/** Remove a member (admin), or yourself to leave the team. */
			removeMember: (id: string, userId: string) =>
				request<void>('DELETE', `${t(id)}/members/${enc(userId)}`),
			/** Every team catchment you can see, with its latest figures (WP-2.14). */
			portfolio: (id: string) => request<Portfolio>('GET', `${t(id)}/portfolio`)
		},
		model: {
			get: (id: string) => request<ProjectModel>('GET', `${p(id)}/model`),
			/** `reason`: the optional "why", kept with the change in the project's history. */
			save: (id: string, model: ProjectModel, reason?: string) =>
				request<ProjectModel>('PUT', `${p(id)}/model`, reason ? { ...model, reason } : model)
		},
		/** The change history (WP-2.4): viewers read, editors restore. */
		history: {
			/** One page of the timeline, newest first. */
			list: (id: string, q: HistoryQuery = {}) => {
				const params = new URLSearchParams();
				for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
				return request<HistoryPage>('GET', `${p(id)}/history${params.size ? `?${params}` : ''}`);
			},
			/** Per field (`settings:<path>`, `node:<id>:<field>`, `crop:<nodeId>:<cropId>`): how often it changed, and the last change. */
			fields: (id: string) => request<{ fields: Record<string, FieldHistory> }>('GET', `${p(id)}/history/fields`),
			/** A revision with its snapshot, and what restoring it would change now (`preview`). */
			revision: (id: string, revId: string) =>
				request<{ revision: HistoryRevision & { snapshot: { settings: ProjectSettings; model: ProjectModel } }; preview: InputChange[] }>(
					'GET',
					`${p(id)}/history/revisions/${enc(revId)}`
				),
			/** Put a revision back, as a new revision (409 when the inputs already match it). */
			restore: (id: string, revId: string, reason?: string) =>
				request<RestoreResult>('POST', `${p(id)}/history/revisions/${enc(revId)}/restore`, reason ? { reason } : {}),
			/** The input lines between a run's snapshot and now, and the revisions made since it ran. */
			changesSince: (id: string, runId: string) =>
				request<{ changes: InputChange[]; revisions: HistoryRevision[] }>('GET', `${p(id)}/runs/${enc(runId)}/changes-since`),
			/** Put back the settings and model a run used, as a new revision. */
			restoreRunInputs: (id: string, runId: string, reason?: string) =>
				request<RestoreResult>('POST', `${p(id)}/runs/${enc(runId)}/restore-inputs`, reason ? { reason } : {}),
			/** A series' kept values, newest first. */
			seriesRevisions: (id: string, seriesId: string) =>
				request<{ revisions: SeriesRevisionMeta[] }>('GET', `${p(id)}/series/${enc(seriesId)}/revisions`).then((r) => r.revisions),
			/** Put a series' kept values back (the values it replaces are kept in turn). */
			restoreSeries: (id: string, seriesId: string, revId: string) =>
				request<SeriesMeta>('POST', `${p(id)}/series/${enc(seriesId)}/revisions/${enc(revId)}/restore`, {})
		},
		series: {
			list: (id: string) =>
				request<{ series: SeriesMeta[] }>('GET', `${p(id)}/series`).then((r) => r.series),
			get: (id: string, seriesId: string) =>
				request<SeriesMeta & { values: (number | null)[] }>('GET', `${p(id)}/series/${enc(seriesId)}`),
			/** `product` + `productVersion`: what the values are (CHIRPS 2.0 …); a replace without them stores them as not recorded. `dayBoundary`: how a sub-daily file was added up into days (033). */
			put: (
				id: string,
				body: { kind: string; name?: string; unit: string; startDate: string; values: (number | null)[]; product?: string | null; productVersion?: string | null; dayBoundary?: DayBoundary | null; source?: string | null }
			) => request<SeriesWriteResult>('PUT', `${p(id)}/series`, body),
			/** Merge days into a series by date (incoming wins on overlap); creates it if missing. Days of another version than the series' are a 409. */
			merge: (
				id: string,
				body: { kind: string; name?: string; unit: string; startDate: string; values: (number | null)[]; product?: string | null; productVersion?: string | null; dayBoundary?: DayBoundary | null; source?: string | null }
			) => request<SeriesWriteResult>('POST', `${p(id)}/series/merge`, body),
			/** Say which product and version a series holds (both null: not recorded); its values are untouched. */
			label: (id: string, seriesId: string, product: string | null, productVersion: string | null) =>
				request<SeriesMeta>('PATCH', `${p(id)}/series/${enc(seriesId)}`, { product, productVersion }),
			/** Where a flow record was measured: a gauge node inside the network, or null for the outlet (084_gauge_records). */
			site: (id: string, seriesId: string, siteNodeId: string | null) => request<SeriesMeta>('PATCH', `${p(id)}/series/${enc(seriesId)}`, { siteNodeId }),
			/** Where the values came from: a station, agency, file or feed; null clears it (107_series_source.sql). */
			source: (id: string, seriesId: string, source: string | null) => request<SeriesMeta>('PATCH', `${p(id)}/series/${enc(seriesId)}`, { source }),
			remove: (id: string, seriesId: string) =>
				request<void>('DELETE', `${p(id)}/series/${enc(seriesId)}`)
		},
		runs: {
			/**
			 * Runs a model; `removedRunIds` are the oldest runs the server trimmed to stay within its cap
			 * (for a forecast run, WP-2.12: the project's older forecast run).
			 */
			create: (id: string, label?: string, opts: { forecast?: boolean } = {}) =>
				request<{ run: Run; removedRunIds?: string[] }>('POST', `${p(id)}/runs`, {
					...(label ? { label } : {}),
					...(opts.forecast ? { forecast: true } : {})
				}).then((r) => ({
					run: r.run,
					removedRunIds: r.removedRunIds ?? []
				})),
			list: (id: string) => request<{ runs: RunMeta[] }>('GET', `${p(id)}/runs`).then((r) => r.runs),
			get: (id: string, runId: string) =>
				request<{ run: Run; series: RunSeriesRef[] }>('GET', `${p(id)}/runs/${enc(runId)}`),
			series: (id: string, runId: string, key: string, nodeId: string | null) => {
				const q = new URLSearchParams({ key });
				if (nodeId) q.set('nodeId', nodeId);
				return request<DailySeries>('GET', `${p(id)}/runs/${enc(runId)}/series?${q}`);
			},
			/** One node's columns on one day (the day trace). */
			day: (id: string, runId: string, nodeId: string, date: string) =>
				request<RunDay>('GET', `${p(id)}/runs/${enc(runId)}/day?${new URLSearchParams({ nodeId, date })}`),
			/** The catchment's runoff-model day (the day trace without a node). */
			catchmentDay: (id: string, runId: string, date: string) =>
				request<RunCatchmentDay>('GET', `${p(id)}/runs/${enc(runId)}/day?${new URLSearchParams({ date })}`),
			remove: (id: string, runId: string) => request<void>('DELETE', `${p(id)}/runs/${enc(runId)}`),
			/** Replace the run's written explanation ('' clears it); answers with the run's metadata and the new stamp. */
			setNotes: (id: string, runId: string, notes: string) =>
				request<{ run: RunMeta }>('PATCH', `${p(id)}/runs/${enc(runId)}`, { notes }).then((r) => r.run),
			/** Pin or unpin a run (the storage cap keeps a pinned run; 409 past PINNED_RUNS_MAX). Answers with the run's metadata. */
			setPinned: (id: string, runId: string, pinned: boolean) =>
				request<{ run: RunMeta }>('PATCH', `${p(id)}/runs/${enc(runId)}`, { pinned }).then((r) => r.run),
			/** The project's evidence history, oldest first (the last entry is the current nomination). */
			nominations: (id: string) => request<{ nominations: Nomination[] }>('GET', `${p(id)}/evidence`).then((r) => r.nominations),
			/** Nominate a run as the project's evidence (a new history row; earlier ones stay). Answers with the whole history. */
			nominate: (id: string, runId: string, reason: string) =>
				request<{ nomination: Nomination; nominations: Nomination[] }>('POST', `${p(id)}/evidence`, { runId, reason }).then((r) => r.nominations),
			/** Withdraw the current nomination (a history row with no run, 098): nothing is the evidence until a run is nominated again. Answers with the whole history. */
			withdrawNomination: (id: string, reason: string) =>
				request<{ nomination: Nomination; nominations: Nomination[] }>('POST', `${p(id)}/evidence/withdraw`, { reason }).then((r) => r.nominations),
			/** Re-run a run from its stored inputs with today's engine and compare (WP-3.1). */
			reproduce: (id: string, runId: string) => request<Reproduction>('GET', `${p(id)}/runs/${enc(runId)}/reproduce`),
			/** The exact input a run would use (merged settings, model, first series of each kind), for the in-browser engine. */
			modelInput: (id: string) => request<{ input: ModelInput }>('GET', `${p(id)}/model-input`).then((r) => r.input)
		},
		signoffs: {
			/** A run's sign-off statement (with its hash), whether the caller may sign, and its sign-offs, oldest first (viewer). */
			list: (id: string, runId: string) => request<SignoffList>('GET', `${p(id)}/runs/${enc(runId)}/signoffs`),
			/** Sign a run off (editor): 409 when the statement changed since it was shown. */
			create: (id: string, runId: string, body: SignoffRequest) =>
				request<{ signoff: Signoff }>('POST', `${p(id)}/runs/${enc(runId)}/signoffs`, body).then((r) => r.signoff)
		},
		publication: {
			/** The current publication (null when nothing is published) and the history, newest first (at most 12). */
			get: (id: string) => request<{ current: Publication | null; history: PublicationMeta[] }>('GET', `${p(id)}/publication`),
			/** Publish a run (editor): supersedes the current publication; `farms` is how many farm projections were stored. */
			publish: (id: string, body: PublishRequest) => request<{ publication: Publication; farms: number }>('POST', `${p(id)}/publication`, body),
			/** Change the current publication's notice, note or next date without re-publishing (editor). */
			update: (id: string, pubId: string, body: PublicationPatch) =>
				request<{ publication: Publication }>('PATCH', `${p(id)}/publication/${enc(pubId)}`, body).then((r) => r.publication)
		},
		shareLinks: {
			/** The project's share links, newest first, revoked and expired ones included (owner). */
			list: (id: string) => request<{ links: ShareLink[] }>('GET', `${p(id)}/share-links`).then((r) => r.links),
			/** Make a link (owner). `url` carries the token: this is the only time it is shown. */
			create: (id: string, label: string, expiresInDays: number) =>
				request<{ link: ShareLink & { url: string } }>('POST', `${p(id)}/share-links`, { label, expiresInDays }).then((r) => r.link),
			/** Withdraw a link (owner): it stops working at once. */
			revoke: (id: string, linkId: string) => request<void>('DELETE', `${p(id)}/share-links/${enc(linkId)}`)
		},
		/** Notes and comments (WP-2.7): farmers and above; RLS scopes what each caller sees. */
		notes: {
			/** Newest first; deleted notes are never listed. */
			list: (id: string, q: NotesQuery = {}) => {
				const params = new URLSearchParams();
				for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
				return request<{ notes: Note[] }>('GET', `${p(id)}/notes${params.size ? `?${params}` : ''}`).then((r) => r.notes);
			},
			counts: (id: string) => request<NoteCounts>('GET', `${p(id)}/notes/counts`),
			create: (id: string, body: NoteCreate) => request<{ note: Note }>('POST', `${p(id)}/notes`, body).then((r) => r.note),
			/** The author only: replaces the body. */
			edit: (id: string, noteId: string, body: string) =>
				request<{ note: Note }>('PATCH', `${p(id)}/notes/${enc(noteId)}`, { body }).then((r) => r.note),
			/** Soft delete (the author or an editor): hidden, kept for the audit trail. */
			remove: (id: string, noteId: string) => request<void>('DELETE', `${p(id)}/notes/${enc(noteId)}`)
		},
		apiKeys: {
			/** The project's API keys, newest first, revoked and expired ones included (owner). */
			list: (id: string) => request<{ keys: ApiKey[] }>('GET', `${p(id)}/api-keys`).then((r) => r.keys),
			/** Make a key (owner). `secret` is the key itself: this is the only time it is shown. */
			create: (id: string, body: ApiKeyCreate) => request<{ key: ApiKey; secret: string }>('POST', `${p(id)}/api-keys`, body),
			/** Revoke a key (owner): the next request with it is refused. */
			revoke: (id: string, keyId: string) => request<void>('DELETE', `${p(id)}/api-keys/${enc(keyId)}`)
		},
		/** Alert emails (WP-2.13, docs/api.md § Alerts). */
		alerts: {
			/** Your choices, per catchment you can get alerts for. */
			mine: () => request<{ projects: ProjectAlerts[] }>('GET', '/me/alerts').then((r) => r.projects),
			/** Change some of your choices for one catchment; answers that catchment's choices. */
			save: (projectId: string, items: AlertChoiceChange[]) =>
				request<{ project: ProjectAlerts }>('PUT', `/me/alerts/${enc(projectId)}`, { items }).then((r) => r.project),
			/** The catchment's rules, every kind and farm (editor). */
			rules: (id: string) => request<{ rules: AlertRule[] }>('GET', `${p(id)}/alert-rules`).then((r) => r.rules),
			/** Switch alerts on or off and set thresholds (editor); answers every rule. */
			saveRules: (id: string, rules: AlertRuleChange[]) =>
				request<{ rules: AlertRule[] }>('PUT', `${p(id)}/alert-rules`, { rules }).then((r) => r.rules),
			/** Alerts firing now (or all recent ones), as the caller may see them. */
			events: (id: string, state: 'firing' | 'all' = 'firing') =>
				request<{ events: AlertEvent[] }>('GET', `${p(id)}/alert-events?state=${state}`).then((r) => r.events),
			/** Turn alert emails back on after SES suppressed your address (429 when it bounced again within a day). */
			resume: () => request<{ mailSuppressed: null }>('POST', '/me/alerts/resume'),
			/** Turn off the subscription a mailed token names (signed out; 404 for a dead link). */
			unsubscribe: (token: string) => request<Unsubscribed>('POST', '/alerts/unsubscribe', { token })
		},
		share: {
			/** What a share link shows, signed out; 404 for any dead link. */
			view: (token: string) => request<ShareView>('POST', '/share/view', { token }),
			/** One catchment series of the published run; 404 when there is none to show (including a small catchment). */
			series: (token: string, key: ShareSeriesKey) => request<ShareSeries>('POST', '/share/series', { token, key })
		},
		uncertainty: {
			/** A run's own input: its stored series (runs since migration 021), or for an older run its snapshot with the project's series, 409 when the data changed since. */
			runInput: (id: string, runId: string) => request<{ input: ModelInput }>('GET', `${p(id)}/runs/${enc(runId)}/model-input`).then((r) => r.input),
			/** Every ensemble started for a run, newest first, without their members. */
			list: (id: string, runId: string) => request<{ ensembles: Ensemble[] }>('GET', `${p(id)}/runs/${enc(runId)}/uncertainty`).then((r) => r.ensembles),
			get: (id: string, runId: string, uid: string) =>
				request<{ ensemble: EnsembleDetail }>('GET', `${p(id)}/runs/${enc(runId)}/uncertainty/${enc(uid)}`).then((r) => r.ensemble),
			/** Start one: the server resolves the options and the database draws the seed. */
			start: (id: string, runId: string, body: EnsembleStart) =>
				request<{ ensemble: Ensemble; notes: string[] }>('POST', `${p(id)}/runs/${enc(runId)}/uncertainty`, body),
			/** Store the result (once); the server checks it before summarising the bands. */
			complete: (id: string, runId: string, uid: string, body: { members: MemberResult[]; coverage: RecordCoverage[] } | { members: PairedMember[] }) =>
				request<{ ensemble: Ensemble }>('POST', `${p(id)}/runs/${enc(runId)}/uncertainty/${enc(uid)}/result`, body).then((r) => r.ensemble)
		},
		/**
		 * Scenarios: named overrides on a base run (docs/api.md § Scenarios).
		 * A run that can't apply every op answers 422 with the lines in
		 * `ApiError.details.problems` (scenarioProblems).
		 */
		scenarios: {
			list: (id: string) => request<{ scenarios: Scenario[] }>('GET', `${p(id)}/scenarios`).then((r) => r.scenarios),
			get: (id: string, sid: string) => request<ScenarioWithCheck>('GET', `${p(id)}/scenarios/${enc(sid)}`),
			create: (id: string, body: { name: string; baseRunId: string; description?: string; ops?: ScenarioOp[]; ownedNodeIds?: string[] }) =>
				request<ScenarioWithCheck>('POST', `${p(id)}/scenarios`, body),
			/** Change what is sent; `ops` replaces the whole list (409 unless the scenario is a draft). */
			update: (
				id: string,
				sid: string,
				body: { name?: string; description?: string; ops?: ScenarioOp[]; ownedNodeIds?: string[]; status?: ScenarioStatus }
			) => request<ScenarioWithCheck>('PATCH', `${p(id)}/scenarios/${enc(sid)}`, body),
			remove: (id: string, sid: string) => request<void>('DELETE', `${p(id)}/scenarios/${enc(sid)}`),
			/** Run it on its base run's stored input; counts toward the project's run cap like any run. */
			run: (id: string, sid: string, label?: string) =>
				request<{ run: Run; removedRunIds?: string[]; applied: ScenarioCheck['applied']; classified: ScenarioCheck['classified'] }>(
					'POST',
					`${p(id)}/scenarios/${enc(sid)}/runs`,
					label ? { label } : {}
				).then((r) => ({ ...r, removedRunIds: r.removedRunIds ?? [] })),
			/** Re-apply the ops to another base run: `problems` lists what no longer applies. `dryRun` checks without saving. */
			rebase: (id: string, sid: string, baseRunId: string, dryRun = false) =>
				request<{ scenario: Scenario } & ScenarioCheck>('POST', `${p(id)}/scenarios/${enc(sid)}/rebase`, { baseRunId, dryRun }),
			/** The base's model and settings as you may see them (an applicant's is anonymised past their own farms). */
			base: (id: string, sid: string) => request<ScenarioBase>('GET', `${p(id)}/scenarios/${enc(sid)}/base`),
			/** The application workflow (WP-3.3): submit freezes the ops; a submit whose ops don't all apply answers 422 with `problems`. */
			submit: (id: string, sid: string) => request<ScenarioWithCheck>('POST', `${p(id)}/scenarios/${enc(sid)}/submit`),
			withdraw: (id: string, sid: string) => request<ScenarioWithCheck>('POST', `${p(id)}/scenarios/${enc(sid)}/withdraw`),
			reopen: (id: string, sid: string) => request<ScenarioWithCheck>('POST', `${p(id)}/scenarios/${enc(sid)}/reopen`),
			/** The assessor's decision: an editor who didn't make the application. */
			decide: (id: string, sid: string, outcome: ScenarioOutcome, note: string) =>
				request<ScenarioWithCheck>('POST', `${p(id)}/scenarios/${enc(sid)}/decide`, { outcome, note }),
			/** Whom its owner may share an application with: an applicant's own party, as the project owner set it (049). */
			shareCandidates: (id: string, sid: string) =>
				request<{ candidates: Scenario['members'] }>('GET', `${p(id)}/scenarios/${enc(sid)}/share-candidates`).then((r) => r.candidates),
			/** Share an application with one of its shareCandidates (its owner only). */
			share: (id: string, sid: string, userId: string) =>
				request<{ members: Scenario['members'] }>('POST', `${p(id)}/scenarios/${enc(sid)}/members`, { userId }).then((r) => r.members),
			unshare: (id: string, sid: string, userId: string) => request<void>('DELETE', `${p(id)}/scenarios/${enc(sid)}/members/${enc(userId)}`),
			/** The assessors' list: every submitted, withdrawn or decided application, newest first. Editors only. */
			applications: (id: string) => request<{ applications: Scenario[] }>('GET', `${p(id)}/applications`).then((r) => r.applications)
		},
		/**
		 * Registered and licensed volumes per farm or water user, and a run's
		 * modelled use against them (docs/api.md § Allocations). Modelled, not
		 * metered; the app never decides whether a use is lawful.
		 */
		allocations: {
			list: (id: string) => request<AllocationList>('GET', `${p(id)}/allocations`),
			create: (id: string, body: AllocationInput) =>
				request<{ allocation: Allocation }>('POST', `${p(id)}/allocations`, body).then((r) => r.allocation),
			update: (id: string, aid: string, body: Partial<AllocationInput>) =>
				request<{ allocation: Allocation }>('PATCH', `${p(id)}/allocations/${enc(aid)}`, body).then((r) => r.allocation),
			remove: (id: string, aid: string) => request<void>('DELETE', `${p(id)}/allocations/${enc(aid)}`),
			/** Parse and match a file; nothing is written. 422 = the file can't be read (the message says why), 409 = already imported. */
			preview: (id: string, body: AllocationImportRequest) => request<AllocationPreview>('POST', `${p(id)}/allocations/import`, body),
			/** Import the file's valid rows; `matches` are the preview's manual choices by file line (null = leave unmatched). */
			commit: (id: string, body: AllocationImportRequest & { matches: Record<string, string | null> }) =>
				request<{ source: AllocationSource; imported: number; skipped: number; unmatched: number }>('POST', `${p(id)}/allocations/import/commit`, body),
			/** Undo an import: the file's record and every allocation it brought. */
			removeSource: (id: string, sourceId: string) => request<void>('DELETE', `${p(id)}/allocations/sources/${enc(sourceId)}`),
			/** The allocations as CSV (a plain link: the cookie goes with it). */
			exportUrl: (id: string) => `${base}${p(id)}/allocations/export.csv`,
			/** A run's modelled use against the registered volumes, per water year. */
			compare: (id: string, runId: string, tolerance?: number) =>
				request<{ run: { id: string; label: string; startDate: string; endDate: string; forecastFrom: string | null; allocationMode: AllocationMode }; comparison: AllocationComparison }>(
					'GET',
					`${p(id)}/runs/${enc(runId)}/allocations${tolerance !== undefined ? `?tolerance=${tolerance}` : ''}`
				)
		},
		/** Background jobs (docs/api.md § Jobs): the status list, newest first. */
		jobs: {
			list: (id: string, q: { status?: JobMeta['status']; limit?: number } = {}) => {
				const qs = new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])));
				return request<{ jobs: JobMeta[] }>('GET', `${p(id)}/jobs${qs.size ? `?${qs}` : ''}`).then((r) => r.jobs);
			}
		},
		/**
		 * Firm yield and storage–yield curves (docs/api.md § Yield, WP-3.6): queue
		 * a job (editor), follow it on jobs.list, read the stored results.
		 */
		yield: {
			start: (id: string, body: YieldRequest) => request<{ jobId: string; job: JobMeta; created: boolean }>('POST', `${p(id)}/yield`, body),
			list: (id: string, q: { runId?: string; scenarioId?: string; nodeId?: string; jobId?: string }) => {
				const qs = new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (v ? [[k, v]] : [])));
				return request<{ results: YieldResult[] }>('GET', `${p(id)}/yield?${qs}`).then((r) => r.results);
			},
			/** A dam's pending yield jobs, by anyone, newest first: the panel follows one it didn't queue. */
			jobs: (id: string, q: { nodeId: string; runId?: string; scenarioId?: string }) => {
				const qs = new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (v ? [[k, v]] : [])));
				return request<{ jobs: YieldJob[] }>('GET', `${p(id)}/yield/jobs?${qs}`).then((r) => r.jobs);
			},
			/** Stop a yield job: a waiting one at once, a running one at its next progress report. */
			cancel: (id: string, jobId: string) => request<{ status: JobMeta['status']; cancelled: boolean }>('POST', `${p(id)}/yield/${enc(jobId)}/cancel`)
		},
		/**
		 * Scenario sweeps (docs/api.md § Sweeps, issue #53 R2): a base run × named
		 * op sets, run by one background job. Follow a pending one with get().
		 */
		sweeps: {
			create: (id: string, body: SweepRequest) => request<{ sweep: Sweep; jobId: string; job: JobMeta }>('POST', `${p(id)}/sweeps`, body),
			list: (id: string, q: { baseRunId?: string } = {}) =>
				request<{ sweeps: Sweep[] }>('GET', `${p(id)}/sweeps${q.baseRunId ? `?${new URLSearchParams({ baseRunId: q.baseRunId })}` : ''}`).then((r) => r.sweeps),
			/** One sweep, each member with its summary; `series: true` adds each done member's outcome series. */
			get: (id: string, sweepId: string, q: { series?: boolean } = {}) =>
				request<{ sweep: Sweep }>('GET', `${p(id)}/sweeps/${enc(sweepId)}${q.series ? '?series=true' : ''}`).then((r) => r.sweep)
		},
		/**
		 * Seasonal outlooks (docs/api.md § Seasonal outlooks, issue #53 R5): a base
		 * run × a season × demand levels over the record's analogue years, run by
		 * one background job. Follow a pending one with get().
		 */
		outlooks: {
			create: (id: string, body: OutlookRequest) => request<{ outlook: Outlook; jobId: string; job: JobMeta }>('POST', `${p(id)}/outlooks`, body),
			list: (id: string, q: { baseRunId?: string } = {}) =>
				request<{ outlooks: Outlook[] }>('GET', `${p(id)}/outlooks${q.baseRunId ? `?${new URLSearchParams({ baseRunId: q.baseRunId })}` : ''}`).then((r) => r.outlooks),
			/** One outlook, with its result once complete. */
			get: (id: string, outlookId: string) => request<{ outlook: Outlook }>('GET', `${p(id)}/outlooks/${enc(outlookId)}`).then((r) => r.outlook),
			/** Publish one level to the project's farmers (issue #53 R5): it ends the current publication. */
			publish: (id: string, outlookId: string, levelId: string) =>
				request<{ publication: OutlookPublication }>('POST', `${p(id)}/outlooks/${enc(outlookId)}/publish`, { levelId }).then((r) => r.publication),
			/** The current publication to farmers, or null. */
			publication: (id: string) => request<{ publication: OutlookPublication | null }>('GET', `${p(id)}/outlook-publication`).then((r) => r.publication),
			/** Withdraw it: the farm pages stop showing it. */
			withdraw: (id: string) => request<{ publication: OutlookPublication }>('DELETE', `${p(id)}/outlook-publication`).then((r) => r.publication)
		},
		compare: {
			/** Compare run B against run A; each ref is "<projectId>:<runId>" (projects may differ). */
			runs: (a: string, b: string) =>
				request<RunCompareResponse>('GET', `/compare/runs?${new URLSearchParams({ a, b })}`)
		}
	};
}

export type Api = ReturnType<typeof createApi>;

/** The ops a scenario run refused over (422 from api.scenarios.run), or [] for any other error. */
export function scenarioProblems(err: unknown): string[] {
	if (!(err instanceof ApiError) || err.status !== 422) return [];
	const p = (err.details as { problems?: unknown } | null | undefined)?.problems;
	return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
}
