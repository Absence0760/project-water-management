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
	EvidenceReport,
	PackManifest,
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
	MfaChallenge,
	MfaStatus,
	AddMemberResult,
	AlertChoiceChange,
	AlertEvent,
	AlertRule,
	AlertRuleChange,
	ProjectAlerts,
	Unsubscribed,
	FeedbackAnswered,
	AlertFeedbackSummary,
	Allocation,
	AllocationCapYears,
	AllocationImportRequest,
	AllocationInput,
	AllocationList,
	AllocationPreview,
	AllocationSource,
	ApiKey,
	ApiKeyCreate,
	ApplicantPack,
	ApplicantPackMeta,
	Ensemble,
	ImportReport,
	ImportResult,
	EnsembleDetail,
	EnsembleStart,
	FarmAccessPerson,
	FarmMap,
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
	PackPdfState,
	PackReproductionState,
	Signoff,
	SignoffList,
	Pack,
	PackDetail,
	PackSignoffList,
	PackVerification,
	SignoffRequest,
	Member,
	MyInvite,
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
	RunPublication,
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
	ApplicantResults,
	ApplicationQuestion,
	AssessorQuestion,
	ApplicantResultsRun,
	ScenarioOutcome,
	ScenarioStatus,
	ScenarioWithCheck,
	ShareLink,
	ShareSeries,
	ShareSeriesKey,
	ShareView,
	ShareScenario,
	SharePack,
	NoteRevision,
	Team,
	TeamMember,
	TeamRole,
	User,
	UserPreferences,
	JobMeta,
	Sweep,
	SweepRequest,
	Assessment,
	AssessmentCheck,
	AssessmentRequest,
	Outlook,
	OutlookPublication,
	OutlookRequest,
	YieldJob,
	YieldRequest,
	YieldResult,
	AutoCalibration,
	MapFeature,
	MapFeatureInput,
	MapFeatureKind,
	MapFeatureList,
	MapImportPreview,
	MapImportReviewed,
	MapLinkedNodes,
	QuaternaryLookup,
	QuaternaryLayer,
	GaugeStationLookup,
	DamProposals
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

/** ApiError.code for the WAF's CAPTCHA answer (set here; the API never sends it). */
export const CAPTCHA_REQUIRED = 'captcha_required';
/** The header AWS WAF reads a token from, besides its aws-waf-token cookie. */
export const WAF_TOKEN_HEADER = 'x-aws-waf-token';

/** AWS WAF's CAPTCHA action on a request that isn't for an HTML page: 405 and `x-amzn-waf-action: captcha`. */
export function isWafCaptcha(res: Pick<Response, 'status' | 'headers'>): boolean {
	return res.status === 405 && res.headers.get('x-amzn-waf-action')?.trim().toLowerCase() === 'captcha';
}

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
	/** Told of every error answer before it is thrown (onError below). */
	const errorListeners = new Set<(err: ApiError) => void>();
	function failed(err: ApiError): ApiError {
		for (const fn of errorListeners) {
			try {
				fn(err);
			} catch {
				// A listener's bug never changes what the caller sees.
			}
		}
		return err;
	}

	async function request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
		let res: Response;
		const headers = { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders };
		try {
			res = await fetchFn(`${base}${path}`, {
				method,
				credentials: 'include',
				headers: Object.keys(headers).length ? headers : undefined,
				body: body === undefined ? undefined : JSON.stringify(body)
			});
		} catch (e) {
			throw new ApiError(0, statusText(0), e);
		}
		if (res.status === 204) return undefined as T;
		// The WAF's sign-in CAPTCHA (infra/waf.tf SignInCaptchaPerIP): a request
		// without a valid token gets 405 with this header, from CloudFront,
		// never from the API. Only the header makes a 405 one.
		if (isWafCaptcha(res)) throw new ApiError(405, 'solve the puzzle to continue', undefined, CAPTCHA_REQUIRED);
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
			throw failed(new ApiError(res.status, msg + describeDetails(obj.details), obj.details, code, params));
		}
		return data as T;
	}

	const enc = encodeURIComponent;
	const p = (id: string) => `/projects/${enc(id)}`;
	const t = (id: string) => `/teams/${enc(id)}`;

	return {
		request,
		/**
		 * Be told of every error the API answers (not network failures), before
		 * the caller sees it: the app-wide two-step sign-in prompt notes its
		 * 403s this way ($lib/auth/mfaPrompt.svelte). Returns the unsubscribe.
		 */
		onError(fn: (err: ApiError) => void): () => void {
			errorListeners.add(fn);
			return () => errorListeners.delete(fn);
		},
		auth: {
			me: () => request<{ user: User }>('GET', '/auth/me').then((r) => r.user),
			/**
			 * `wafToken`: the token from a solved WAF CAPTCHA, for the retry
			 * after a CAPTCHA_REQUIRED ApiError ($lib/auth/wafCaptcha), sent
			 * in the header the WAF reads.
			 */
			login: (email: string, password: string, wafToken?: string): Promise<User | MfaChallenge> =>
				request<{ user: User } | MfaChallenge>('POST', '/auth/login', { email, password }, wafToken ? { [WAF_TOKEN_HEADER]: wafToken } : undefined).then(
					(r) => ('mfaRequired' in r ? { mfaRequired: true as const } : r.user)
				),
			/**
			 * Two-step sign-in (issue #282, docs/api.md § Two-step sign-in).
			 * `code` is six digits from the authenticator app, or a recovery code
			 * where one is accepted (verify, disable). ApiError 400 mfa_code_wrong,
			 * 429 mfa_locked (5 wrong codes in a row).
			 */
			mfa: {
				status: () => request<MfaStatus>('GET', '/auth/mfa'),
				/** Start adding an authenticator: the current password (403 wrong_current_password), then the secret and its otpauth URI, shown once. */
				enrol: (password: string) => request<{ secret: string; uri: string }>('POST', '/auth/mfa/totp/enrol', { password }),
				/** The first code from the app: turns it on, and returns the ten recovery codes (shown once). */
				confirm: (code: string) => request<{ recoveryCodes: string[] }>('POST', '/auth/mfa/totp/confirm', { code }).then((r) => r.recoveryCodes),
				/** Turn it off (a code from the app or a recovery code). */
				disable: (code: string) => request<void>('DELETE', '/auth/mfa/totp', { code }),
				/** A new set of recovery codes, the old ones void (a code from the app). */
				regenerate: (code: string) => request<{ recoveryCodes: string[] }>('POST', '/auth/mfa/recovery-codes', { code }).then((r) => r.recoveryCodes),
				/** The sign-in's second step, after login answered MfaChallenge. 401 mfa_challenge_expired: sign in again. */
				verify: (code: string) => request<{ user: User; usedRecoveryCode?: true }>('POST', '/auth/mfa/verify', { code })
			},
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
			 * `preferences`: the keys sent replace the account's (`hiddenTabs: []` shows every section, `null` goes back to the default).
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
				),
			/**
			 * "Delete my account" (issue #112): the password, typed again. Resolves
			 * once the account is gone and this browser's cookies are cleared.
			 * ApiError 403 = wrong password, 429 = locked (the sign-in lockout),
			 * 409 `account_sole_holder` = the only owner or admin of what `details`
			 * names (SoleHoldings; account/deleteAccount.ts soleHoldingsOf reads it).
			 */
			deleteMe: (password: string) => request<void>('DELETE', '/auth/me', { password })
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
			 * or not a member) throws, except the older backend's `404 no import
			 * report`, which also means none: web@ and backend@ release separately,
			 * so this frontend may be served against a backend from before #162.
			 */
			importReport: (id: string) =>
				request<{ report: StoredImportReport | null }>('GET', `${p(id)}/import-report`).then(
					(r) => r.report,
					(e: unknown) => {
						if (e instanceof ApiError && e.status === 404 && e.message === 'no import report') return null;
						throw e;
					}
				),
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
			/** Always an invite (`{ invited: true, invite }`), account or not: its holder accepts it (issue #136). */
			add: (id: string, email: string, role: Role) =>
				request<AddMemberResult>('POST', `${p(id)}/members`, { email, role }),
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
			 * Always an invite (`{ invited: true, invite }`), account or not: its holder accepts it (issue #136).
			 * `role: 'contributor'` invites a licence applicant with their farms (WP-3.3).
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
			/** The farm's map (issue #326 A3): its own parcels and dams, with the boundary, rivers and gauges; empty without a parcel or dam. */
			map: (id: string, nodeId: string) => request<FarmMap>('GET', `${p(id)}/farm/${enc(nodeId)}/map`),
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
			/** Always an invite (`{ invited: true, invite }`), account or not: its holder accepts it (issue #136). */
			addMember: (id: string, email: string, role: TeamRole) =>
				request<AddMemberResult>('POST', `${t(id)}/members`, { email, role }),
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
		/** The licensing evidence report of a run (issue #71, docs/api.md § Evidence report): an application run on its base, or a baseline alone. */
		evidence: {
			report: (id: string, runId: string) =>
				request<{ report: EvidenceReport }>('GET', `${p(id)}/runs/${enc(runId)}/evidence-report`).then((r) => r.report)
		},
		signoffs: {
			/** A run's sign-off statement (with its hash), whether the caller may sign, and its sign-offs, oldest first (viewer). */
			list: (id: string, runId: string) => request<SignoffList>('GET', `${p(id)}/runs/${enc(runId)}/signoffs`),
			/** Sign a run off (editor): 409 when the statement changed since it was shown. */
			create: (id: string, runId: string, body: SignoffRequest) =>
				request<{ signoff: Signoff }>('POST', `${p(id)}/runs/${enc(runId)}/signoffs`, body).then((r) => r.signoff)
		},
		/** Evidence packs (WP-3.14, issue #71, docs/api.md § Evidence packs): a report frozen, hashed, signed and issued. */
		packs: {
			/** The project's packs, newest first (viewer; no manifest). */
			list: (id: string) => request<{ packs: Pack[] }>('GET', `${p(id)}/packs`).then((r) => r.packs),
			/** One pack with its frozen manifest, its sign-offs and, for an editor's draft, what stands before its issue (viewer). */
			get: (id: string, packId: string) => request<PackDetail>('GET', `${p(id)}/packs/${enc(packId)}`),
			/** Draft a pack from a report that may be issued (editor); `supersedesId` makes it a new version of an issued pack. */
			create: (id: string, runId: string, supersedesId?: string) =>
				request<{ pack: Pack }>('POST', `${p(id)}/packs`, supersedesId ? { runId, supersedesId } : { runId }).then((r) => r.pack),
			/** Delete an unsigned draft (editor). */
			remove: (id: string, packId: string) => request<void>('DELETE', `${p(id)}/packs/${enc(packId)}`),
			/** Issue a signed draft (editor): 409 with the reason when something stands in the way. */
			issue: (id: string, packId: string) => request<{ pack: Pack }>('POST', `${p(id)}/packs/${enc(packId)}/issue`, {}).then((r) => r.pack),
			/** Withdraw a pack, with a reason shown publicly on its verify page (editor). */
			withdraw: (id: string, packId: string, reason: string) =>
				request<{ pack: Pack }>('POST', `${p(id)}/packs/${enc(packId)}/withdraw`, { reason }).then((r) => r.pack),
			/** The pack statement (with its hash), whether the caller may sign, and its sign-offs (viewer). */
			signoffs: (id: string, packId: string) => request<PackSignoffList>('GET', `${p(id)}/packs/${enc(packId)}/signoffs`),
			/**
			 * An issued pack's reproduction bundle (a plain link: the cookie goes with
			 * it). The API checks the reader, then redirects to a one-minute signed
			 * GET, as a report PDF (docs/evidence-pack.md § Reproduction).
			 */
			bundleUrl: (id: string, packId: string) => `${base}${p(id)}/packs/${enc(packId)}/bundle`,
			/** Sign a draft pack off (editor): 409 when the statement changed since it was shown. */
			sign: (id: string, packId: string, body: SignoffRequest) =>
				request<{ signoff: Signoff }>('POST', `${p(id)}/packs/${enc(packId)}/signoffs`, body).then((r) => r.signoff),
			/** The issued pack's PDF: a link to follow (the API answers 302 to a short-lived signed URL, or 409 until it is ready; viewer). */
			pdfUrl: (id: string, packId: string) => `${base}${p(id)}/packs/${enc(packId)}/pdf`,
			/** Ask again for the PDF of an issued pack whose render failed (editor): 409 once one is recorded. */
			renderPdf: (id: string, packId: string) =>
				request<{ jobId: string; pdf: PackPdfState }>('POST', `${p(id)}/packs/${enc(packId)}/pdf`, {}).then((r) => r.pdf),
			/**
			 * Re-run an issued pack on the server again (editor): after the last re-run gave up, or on a newer engine.
			 * The pending re-run comes back while one is queued; 409 once this engine's outcome is recorded.
			 */
			reproduce: (id: string, packId: string) =>
				request<{ jobId: string; reproduction: PackReproductionState }>('POST', `${p(id)}/packs/${enc(packId)}/reproduce`, {}).then((r) => r.reproduction)
		},
		/** Public, no session: what an issued pack prints, by its short code or full hash; 404 for anything else. */
		verify: (code: string) => request<{ pack: PackVerification }>('GET', `/verify/${enc(code)}`).then((r) => r.pack),
		publication: {
			/** The current publication (null when nothing is published) and the history, newest first (at most 12). */
			get: (id: string) => request<{ current: Publication | null; history: PublicationMeta[] }>('GET', `${p(id)}/publication`),
			/** Publish a run (editor): supersedes the current publication; `farms` is how many farm projections were stored. */
			publish: (id: string, body: PublishRequest) => request<{ publication: Publication; farms: number }>('POST', `${p(id)}/publication`, body),
			/** Change the current publication's notice, note or next date without re-publishing (editor). */
			update: (id: string, pubId: string, body: PublicationPatch) =>
				request<{ publication: Publication }>('PATCH', `${p(id)}/publication/${enc(pubId)}`, body).then((r) => r.publication),
			/** One run's publication and the changes since the one before (viewer; the printable report). */
			ofRun: (id: string, runId: string) => request<RunPublication>('GET', `${p(id)}/runs/${enc(runId)}/publication`)
		},
		shareLinks: {
			/** The project's baseline links, newest first, revoked and expired ones included (owner). */
			list: (id: string) => request<{ links: ShareLink[] }>('GET', `${p(id)}/share-links`).then((r) => r.links),
			/** Every link in the project, the baseline's and each application's, with its target (owner: the Project page's inventory). */
			listAll: (id: string) => request<{ links: ShareLink[] }>('GET', `${p(id)}/share-links?scope=all`).then((r) => r.links),
			/** Make a link (owner). `url` carries the token: this is the only time it is shown. */
			create: (id: string, label: string, expiresInDays: number) =>
				request<{ link: ShareLink & { url: string } }>('POST', `${p(id)}/share-links`, { label, expiresInDays }).then((r) => r.link),
			/** The links to one scenario (WP-3.15): every one to an assessor, the ones they made to an applicant. */
			listForScenario: (id: string, scenarioId: string) =>
				request<{ links: ShareLink[] }>('GET', `${p(id)}/share-links?scenarioId=${enc(scenarioId)}`).then((r) => r.links),
			/** Link a submitted or decided scenario (an assessor, or its applicant). */
			createForScenario: (id: string, scenarioId: string, label: string, expiresInDays: number) =>
				request<{ link: ShareLink & { url: string } }>('POST', `${p(id)}/share-links`, { label, expiresInDays, targetKind: 'scenario', targetId: scenarioId }).then(
					(r) => r.link
				),
			/** The links to one evidence pack (128): every one to its project's editors, the ones they made to its applicant (131). */
			listForPack: (id: string, packId: string) => request<{ links: ShareLink[] }>('GET', `${p(id)}/share-links?packId=${enc(packId)}`).then((r) => r.links),
			/** Link an issued evidence pack (an editor, or the applicant for their own application's, 131). */
			createForPack: (id: string, packId: string, label: string, expiresInDays: number) =>
				request<{ link: ShareLink & { url: string } }>('POST', `${p(id)}/share-links`, { label, expiresInDays, targetKind: 'pack', targetId: packId }).then((r) => r.link),
			/** Withdraw a link (the owner; an assessor or the applicant for a scenario link; an editor for a pack link): it stops working at once. */
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
			remove: (id: string, noteId: string) => request<void>('DELETE', `${p(id)}/notes/${enc(noteId)}`),
			/** A scenario note's earlier texts (WP-3.15), read as the note is. */
			revisions: (id: string, noteId: string) => request<{ note: Note; revisions: NoteRevision[] }>('GET', `${p(id)}/notes/${enc(noteId)}/revisions`)
		},
		apiKeys: {
			/** The project's API keys, newest first, revoked and expired ones included (owner). */
			list: (id: string) => request<{ keys: ApiKey[] }>('GET', `${p(id)}/api-keys`).then((r) => r.keys),
			/** Make a key (owner). `secret` is the key itself: this is the only time it is shown. */
			create: (id: string, body: ApiKeyCreate) => request<{ key: ApiKey; secret: string }>('POST', `${p(id)}/api-keys`, body),
			/** Revoke a key (owner): the next request with it is refused. */
			revoke: (id: string, keyId: string) => request<void>('DELETE', `${p(id)}/api-keys/${enc(keyId)}`)
		},
		/** Your own pending invitations (issue #136, docs/api.md § Invites): a verified account joins only by accepting. */
		invites: {
			mine: () => request<{ invites: MyInvite[] }>('GET', '/me/invites').then((r) => r.invites),
			/** Join: the project or team it was for. 404 when it isn't yours, has expired or was revoked. */
			accept: (inviteId: string) =>
				request<{ joined: { kind: 'project' | 'team'; id: string } }>('POST', `/me/invites/${enc(inviteId)}/accept`).then((r) => r.joined),
			decline: (inviteId: string) => request<void>('DELETE', `/me/invites/${enc(inviteId)}`)
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
			unsubscribe: (token: string) => request<Unsubscribed>('POST', '/alerts/unsubscribe', { token }),
			/** Answer "Was this useful?" for the mail a token names (signed out; 404 for a dead link). */
			feedback: (token: string, useful: boolean, comment: string | null) =>
				request<FeedbackAnswered>('POST', '/alerts/feedback', { token, useful, ...(comment ? { comment } : {}) }),
			/** The catchment's "Was this useful?" answers, counted, and their comments (editor). */
			feedbackSummary: (id: string) => request<AlertFeedbackSummary>('GET', `${p(id)}/alert-feedback`)
		},
		share: {
			/** What a share link shows, signed out; 404 for any dead link. */
			view: (token: string) => request<ShareView>('POST', '/share/view', { token }),
			/** One catchment series of the published run; 404 when there is none to show (including a small catchment). */
			series: (token: string, key: ShareSeriesKey) => request<ShareSeries>('POST', '/share/series', { token, key }),
			/** A scenario link (WP-3.15), signed out; 404 for any dead link. */
			scenario: (token: string) => request<ShareScenario>('POST', '/share/scenario', { token }),
			/** An evidence pack link (128): its figures while issued, else its standing; 404 for any dead link. */
			pack: (token: string) => request<SharePack>('POST', '/share/pack', { token })
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
			/** An application's issued packs, newest first, for its parties (131; an applicant reads no pack row). */
			packs: (id: string, sid: string) => request<{ packs: ApplicantPackMeta[] }>('GET', `${p(id)}/scenarios/${enc(sid)}/packs`).then((r) => r.packs),
			/** One of them, D2-anonymised: verify's fields, a pack link's figures and the units. */
			pack: (id: string, sid: string, packId: string) => request<ApplicantPack>('GET', `${p(id)}/scenarios/${enc(sid)}/packs/${enc(packId)}`),
			get: (id: string, sid: string) => request<ScenarioWithCheck>('GET', `${p(id)}/scenarios/${enc(sid)}`),
			create: (id: string, body: { name: string; baseRunId: string; description?: string; ops?: ScenarioOp[]; ownedNodeIds?: string[] }) =>
				request<ScenarioWithCheck>('POST', `${p(id)}/scenarios`, body),
			/** Change what is sent; `ops` replaces the whole list (409 unless the scenario is a draft). */
			update: (
				id: string,
				sid: string,
				body: {
					name?: string;
					description?: string;
					/** Appendix C's fixed prompts (engine APPLICANT_PROMPTS): changed on the description's terms, not frozen by a submission. */
					purposeAndNeed?: string;
					mitigation?: string;
					monitoring?: string;
					ops?: ScenarioOp[];
					ownedNodeIds?: string[];
					status?: ScenarioStatus;
				}
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
			/** An application run's results as its applicant sees them (the newest run unless runId); both null before any run. */
			results: (id: string, sid: string, runId?: string) =>
				request<{ run: ApplicantResultsRun | null; results: ApplicantResults | null }>(
					'GET',
					`${p(id)}/scenarios/${enc(sid)}/results${runId ? `?runId=${enc(runId)}` : ''}`
				),
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
			applications: (id: string) => request<{ applications: Scenario[] }>('GET', `${p(id)}/applications`).then((r) => r.applications),
			/** "Ask the assessors why" (164): a party asks about problem line `problem` of the check, quoting it as read (409 if the check changed). */
			ask: (id: string, sid: string, problem: number, line: string) =>
				request<{ question: ApplicationQuestion }>('POST', `${p(id)}/scenarios/${enc(sid)}/questions`, { problem, line }).then((r) => r.question),
			/** An application's questions: its parties' view, or the assessors' (with the real words) for an editor. */
			questions: (id: string, sid: string) =>
				request<{ questions: (ApplicationQuestion & Partial<AssessorQuestion>)[] }>('GET', `${p(id)}/scenarios/${enc(sid)}/questions`).then((r) => r.questions),
			/** The assessors' queue of questions, unanswered first. Editors only. */
			assessorQuestions: (id: string) => request<{ questions: AssessorQuestion[] }>('GET', `${p(id)}/application-questions`).then((r) => r.questions),
			/** Answer a question, once. Editors only. */
			answerQuestion: (id: string, qid: string, answer: string) =>
				request<{ question: AssessorQuestion }>('POST', `${p(id)}/application-questions/${enc(qid)}/answer`, { answer }).then((r) => r.question)
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
				request<{ run: { id: string; label: string; startDate: string; endDate: string; forecastFrom: string | null; allocationMode: AllocationMode }; comparison: AllocationComparison; capYears: AllocationCapYears[] }>(
					'GET',
					`${p(id)}/runs/${enc(runId)}/allocations${tolerance !== undefined ? `?tolerance=${tolerance}` : ''}`
				)
		},
		/**
		 * The catchment map (docs/api.md § Catchment map, issue #288): features,
		 * GeoJSON imports (checked and measured on the server), an area accepted
		 * into a farm, and the quaternary lookup, which only proposes.
		 */
		map: {
			list: (id: string) => request<MapFeatureList>('GET', `${p(id)}/map/features`),
			/** Which nodes have a linked feature, ids only: the "Show on map" links (issue #326). */
			linkedNodes: (id: string) => request<MapLinkedNodes>('GET', `${p(id)}/map/linked-nodes`),
			create: (id: string, body: MapFeatureInput & { kind: MapFeatureKind }) =>
				request<{ feature: MapFeature }>('POST', `${p(id)}/map/features`, body).then((r) => r.feature),
			update: (id: string, fid: string, body: MapFeatureInput) =>
				request<{ feature: MapFeature }>('PATCH', `${p(id)}/map/features/${enc(fid)}`, body).then((r) => r.feature),
			remove: (id: string, fid: string) => request<void>('DELETE', `${p(id)}/map/features/${enc(fid)}`),
			/** The review before an import (issue #326 D2): the file read and checked on the server, each feature's kind proposed; saves nothing. */
			importPreview: (id: string, body: { fileName: string; text: string }) => request<MapImportPreview>('POST', `${p(id)}/map/import/preview`, body),
			/**
			 * Import a file, every feature one `kind` or each its own (`features`, from the review).
			 * 422: the file isn't taken; the error's `details` lists MapImportProblem per feature. 409: imported already, or a
			 * reviewed boundary row would replace the current boundary without `replaceBoundary: true`.
			 */
			import: (id: string, body: { fileName: string; text: string } & ({ kind: MapFeatureKind } | { features: MapImportReviewed[]; replaceBoundary?: boolean })) =>
				request<{ source: { id: string; fileName: string; sha256: string }; features: MapFeature[] }>('POST', `${p(id)}/map/import`, body),
			/** Accept a polygon's area as a farm's area (a model change, recorded as a revision naming the feature). */
			areaFromMap: (id: string, nodeId: string, featureId: string) =>
				request<{ nodeId: string; areaKm2: number; areaSource: 'map'; areaFeatureId: string; revisionId: string | null }>(
					'POST',
					`${p(id)}/nodes/${enc(nodeId)}/area-from-map`,
					{ featureId }
				),
			quaternary: (id: string, lon: number, lat: number) =>
				request<QuaternaryLookup>('GET', `${p(id)}/map/quaternary?${new URLSearchParams({ lon: String(lon), lat: String(lat) })}`),
			/** The quaternary outlines whose box meets `bbox` (west, south, east, north; at most 5° a side), for the map's layer (issue #326 A6). */
			quaternaries: (id: string, bbox: readonly [number, number, number, number]) =>
				request<QuaternaryLayer>('GET', `${p(id)}/map/quaternaries?${new URLSearchParams({ bbox: bbox.join(',') })}`),
			/** The river gauges nearest a point, or the catchment's outlet without one (issue #326 B-gauge); only proposes. */
			stations: (id: string, q: { lon?: number; lat?: number; within?: number } = {}) => {
				const qs = new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])));
				return request<GaugeStationLookup>('GET', `${p(id)}/map/stations${qs.size ? `?${qs}` : ''}`);
			}
		},
		/**
		 * A unit's dam values proposed from the register of dams and its dam polygon (issue #326 B-dams,
		 * docs/api.md § Catchment map). Each accept is one value, saved to the model as a revision naming the source.
		 */
		damProposals: {
			get: (id: string, nodeId: string) => request<DamProposals>('GET', `${p(id)}/nodes/${enc(nodeId)}/dam-proposals`),
			capacityFromRegister: (id: string, nodeId: string, registerNo: string) =>
				request<{ nodeId: string; damCapacityM3: number; registerNo: string; revisionId: string | null }>(
					'POST',
					`${p(id)}/nodes/${enc(nodeId)}/dam-capacity-from-register`,
					{ registerNo }
				),
			areaFromMap: (id: string, nodeId: string, featureId: string) =>
				request<{ nodeId: string; damAreaFullM2: number; areaFeatureId: string; revisionId: string | null }>(
					'POST',
					`${p(id)}/nodes/${enc(nodeId)}/dam-area-from-map`,
					{ featureId }
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
		 * Cumulative impact assessments (docs/api.md § Assessments, roadmap
		 * WP-3.11): several scenarios on one base run, each alone and all
		 * together, run by one background job. Editors only. check() is the dry
		 * run (conflicts and problems, nothing written); create() refuses with a
		 * 422 whose details are the same (assessmentCheckOf).
		 */
		assessments: {
			check: (id: string, body: Omit<AssessmentRequest, 'dryRun'>) =>
				request<{ check: AssessmentCheck }>('POST', `${p(id)}/assessments`, { ...body, dryRun: true }).then((r) => r.check),
			create: (id: string, body: Omit<AssessmentRequest, 'dryRun'>) => request<{ assessment: Assessment; jobId: string; job: JobMeta }>('POST', `${p(id)}/assessments`, body),
			list: (id: string) => request<{ assessments: Assessment[] }>('GET', `${p(id)}/assessments`).then((r) => r.assessments),
			get: (id: string, assessmentId: string) => request<{ assessment: Assessment }>('GET', `${p(id)}/assessments/${enc(assessmentId)}`).then((r) => r.assessment)
		},
		/**
		 * Automated calibration run by the server (docs/api.md § Automated
		 * calibration, issue #153): a run of the saved calibration rules, one
		 * background job per fit. Follow a running one with get(); apply() writes
		 * the kept fit into the settings (with its record), makes a run with it
		 * and, when the rules say so, queues the ensemble around it.
		 */
		autoCalibrations: {
			start: (id: string) => request<{ calibration: AutoCalibration; jobId: string; job: JobMeta }>('POST', `${p(id)}/auto-calibrations`, {}),
			list: (id: string) => request<{ calibrations: AutoCalibration[] }>('GET', `${p(id)}/auto-calibrations`).then((r) => r.calibrations),
			get: (id: string, calibrationId: string) => request<{ calibration: AutoCalibration }>('GET', `${p(id)}/auto-calibrations/${enc(calibrationId)}`).then((r) => r.calibration),
			apply: (id: string, calibrationId: string) =>
				request<{ calibration: AutoCalibration; runId: string | null; uncertaintyId: string | null; runError: string | null }>('POST', `${p(id)}/auto-calibrations/${enc(calibrationId)}/apply`, {})
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
/** The conflicts and problems of a refused assessment (POST …/assessments' 422), or null for any other error. */
export function assessmentCheckOf(err: unknown): AssessmentCheck | null {
	if (!(err instanceof ApiError) || err.status !== 422) return null;
	const d = err.details as { conflicts?: unknown; problems?: unknown } | null | undefined;
	if (!d || (!Array.isArray(d.conflicts) && !Array.isArray(d.problems))) return null;
	return {
		ok: false,
		conflicts: Array.isArray(d.conflicts) ? (d.conflicts as AssessmentCheck['conflicts']) : [],
		problems: Array.isArray(d.problems) ? d.problems.filter((x): x is string => typeof x === 'string') : []
	};
}

export function scenarioProblems(err: unknown): string[] {
	if (!(err instanceof ApiError) || err.status !== 422) return [];
	const p = (err.details as { problems?: unknown } | null | undefined)?.problems;
	return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
}
