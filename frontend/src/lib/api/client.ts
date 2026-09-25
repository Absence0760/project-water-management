// Typed client for the backend HTTP API (docs/api.md). Every call sends the
// session cookie (credentials: 'include') and turns a non-2xx response into an
// ApiError carrying the HTTP status and the server's message.
import type {
	DailySeries,
	MemberResult,
	ModelInput,
	PairedMember,
	RecordCoverage,
	ProjectModel,
	ProjectSettings,
	SeriesMeta
} from '@water-management/engine';
import type {
	AddMemberResult,
	Ensemble,
	EnsembleDetail,
	EnsembleStart,
	Member,
	Nomination,
	Project,
	ProjectSummary,
	Role,
	Run,
	RunCompareResponse,
	RunMeta,
	RunCatchmentDay,
	RunDay,
	RunSeriesRef,
	Team,
	TeamMember,
	TeamRole,
	User
} from './types';

export class ApiError extends Error {
	readonly status: number;
	readonly details: unknown;

	constructor(status: number, message: string, details?: unknown) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.details = details;
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
			const obj = (data && typeof data === 'object' ? data : {}) as { error?: unknown; details?: unknown };
			const msg = typeof obj.error === 'string' && obj.error ? obj.error : statusText(res.status);
			throw new ApiError(res.status, msg + describeDetails(obj.details), obj.details);
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
			/** `inviteToken` from a `/register?invite=…` link: a live invite for the same address starts the account verified and joined. */
			register: (email: string, password: string, displayName: string, inviteToken?: string | null) =>
				request<{ user: User }>('POST', '/auth/register', {
					email,
					password,
					displayName,
					...(inviteToken ? { inviteToken } : {})
				}).then((r) => r.user),
			logout: () => request<void>('POST', '/auth/logout'),
			/** Signs out every device (this one included): revokes every session issued before now. */
			logoutEverywhere: () => request<void>('POST', '/auth/logout-everywhere')
		},
		projects: {
			list: () => request<{ projects: ProjectSummary[] }>('GET', '/projects').then((r) => r.projects),
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
					settings?: Partial<ProjectSettings>;
					/** Move into a team you're in, or null for personal. Owner only. */
					teamId?: string | null;
				}
			) => request<{ project: Project }>('PATCH', p(id), patch).then((r) => r.project),
			remove: (id: string) => request<void>('DELETE', p(id)),
			copy: (id: string, name: string) =>
				request<{ project: Project }>('POST', `${p(id)}/copy`, { name }).then((r) => r.project)
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
			remove: (id: string, userId: string) =>
				request<void>('DELETE', `${p(id)}/members/${enc(userId)}`)
		},
		teams: {
			list: () => request<{ teams: Team[] }>('GET', '/teams').then((r) => r.teams),
			create: (name: string) => request<{ team: Team }>('POST', '/teams', { name }).then((r) => r.team),
			get: (id: string) => request<{ team: Team; members: TeamMember[] }>('GET', t(id)),
			rename: (id: string, name: string) =>
				request<{ team: Team }>('PATCH', t(id), { name }).then((r) => r.team),
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
				request<void>('DELETE', `${t(id)}/members/${enc(userId)}`)
		},
		model: {
			get: (id: string) => request<ProjectModel>('GET', `${p(id)}/model`),
			save: (id: string, model: ProjectModel) => request<ProjectModel>('PUT', `${p(id)}/model`, model)
		},
		series: {
			list: (id: string) =>
				request<{ series: SeriesMeta[] }>('GET', `${p(id)}/series`).then((r) => r.series),
			get: (id: string, seriesId: string) =>
				request<SeriesMeta & { values: (number | null)[] }>('GET', `${p(id)}/series/${enc(seriesId)}`),
			put: (
				id: string,
				body: { kind: string; name?: string; unit: string; startDate: string; values: (number | null)[] }
			) => request<SeriesMeta>('PUT', `${p(id)}/series`, body),
			/** Merge days into a series by date (incoming wins on overlap); creates it if missing. */
			merge: (
				id: string,
				body: { kind: string; name?: string; unit: string; startDate: string; values: (number | null)[] }
			) => request<SeriesMeta>('POST', `${p(id)}/series/merge`, body),
			remove: (id: string, seriesId: string) =>
				request<void>('DELETE', `${p(id)}/series/${enc(seriesId)}`)
		},
		runs: {
			/** Runs a model; `removedRunIds` are the oldest runs the server trimmed to stay within its cap. */
			create: (id: string, label?: string) =>
				request<{ run: Run; removedRunIds?: string[] }>('POST', `${p(id)}/runs`, label ? { label } : {}).then((r) => ({
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
			/** The exact input a run would use (merged settings, model, first series of each kind), for the in-browser engine. */
			modelInput: (id: string) => request<{ input: ModelInput }>('GET', `${p(id)}/model-input`).then((r) => r.input)
		},
		uncertainty: {
			/** A run's own input (its settings and model snapshot with the project's series); 409 when the data changed since. */
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
		compare: {
			/** Compare run B against run A; each ref is "<projectId>:<runId>" (projects may differ). */
			runs: (a: string, b: string) =>
				request<RunCompareResponse>('GET', `/compare/runs?${new URLSearchParams({ a, b })}`)
		}
	};
}

export type Api = ReturnType<typeof createApi>;
