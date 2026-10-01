<script lang="ts">
	// An application's workflow (WP-3.3, docs/ui.md § Applications): where it
	// stands, the owner's Submit / Withdraw / Reopen, the responsible
	// authority's decision as recorded by a member acting for it
	// (163_licensing_authority: the app records the decision, never makes it),
	// and who it is shared with. The server holds every rule (who may move it,
	// that a submit freezes the ops, that no one decides their own); this
	// offers only the moves it would allow. Its comments (WP-3.15: the notes
	// drawer with an audience picker) and, for the applicant and the
	// assessors, its read-only share links (the Share dialog). It lists the
	// application's evidence packs (WP-3.14) with their status: every one to
	// the project's viewers and up (the pack's own page), and to its
	// applicant and whoever they shared it with the ones that were issued,
	// never a draft (131_applicant_packs: their anonymised pack view, where
	// the applicant also shares it by link).
	import { base } from '$app/paths';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import NotesDrawer from '$lib/components/notes/NotesDrawer.svelte';
	import { scenarioAudiences } from '$lib/components/notes/notes';
	import PackBadge from '$lib/components/packs/PackBadge.svelte';
	import { packHref, packsByScenario } from '$lib/components/packs/pack';
	import { applicantPackHref } from '$lib/components/packs/applicantPack';
	import ShareLinksPanel from '$lib/components/project/ShareLinksPanel.svelte';
	import {
		api,
		OUTCOME_BASIS,
		OUTCOME_LABEL,
		scenarioProblems,
		SCENARIO_OUTCOMES,
		type ApplicantPackMeta,
		type Pack,
		type Scenario,
		type ScenarioOutcome,
		type ScenarioWithCheck
	} from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import { fmtDate, fmtDay } from '$lib/format/number';

	let {
		projectId,
		scenario: s,
		isOwner,
		canDecide,
		canEdit = false,
		problems,
		unverifiedRuns = 0,
		locked = false,
		canReadPacks = false,
		onchange,
		onleft
	}: {
		projectId: string;
		scenario: Scenario;
		/** The applicant who made it: they submit, withdraw, reopen and share it. */
		isOwner: boolean;
		/**
		 * An editor who isn't its owner and whom the project's owner marks as
		 * acting for the responsible authority (163): they record its decision
		 * once submitted.
		 */
		canDecide: boolean;
		/** An editor or owner of the project: an assessor, whether or not they act for the authority. */
		canEdit?: boolean;
		/** How many of its changes don't apply to its base (a submit is refused until none). */
		problems: number;
		/**
		 * How many of its runs don't carry a matching server stamp (the API's
		 * `unverifiedRunIds`, docs/security.md § Run stamps): written past the
		 * model run, or changed since. The server refuses the decision until
		 * none remain.
		 */
		unverifiedRuns?: number;
		/**
		 * The scenario editor is running it or saving it: the status moves wait,
		 * or the run's re-read of the scenario could land after a submit and put
		 * the old status back on screen.
		 */
		locked?: boolean;
		/**
		 * The caller reads evidence packs (viewer and up). Otherwise (an applicant,
		 * or someone they shared it with) the panel lists the application's
		 * issued packs from GET …/scenarios/:sid/packs.
		 */
		canReadPacks?: boolean;
		onchange: (d: ScenarioWithCheck) => void;
		/** You stopped reading it (left the share): it leaves your list. */
		onleft: () => void;
	} = $props();

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	let busy = $state(false);
	let error = $state<string | null>(null);
	let note = $state('');

	async function act(what: string, call: () => Promise<ScenarioWithCheck>) {
		busy = true;
		error = null;
		try {
			onchange(await call());
			note = what;
		} catch (e) {
			const p = scenarioProblems(e);
			error = p.length ? `${msg(e)}: ${p.join('; ')}` : msg(e);
		} finally {
			busy = false;
		}
	}
	async function submit() {
		const ok = await confirmDialog({
			title: `Submit “${s.name}” to the assessors?`,
			message: 'Its changes are then frozen; you can withdraw it until it is decided.',
			confirmLabel: 'Submit application'
		});
		if (!ok) return;
		act('Submitted.', () => api.scenarios.submit(projectId, s.id));
	}
	const withdraw = () => act('Withdrawn.', () => api.scenarios.withdraw(projectId, s.id));
	const reopen = () => act('Back to draft.', () => api.scenarios.reopen(projectId, s.id));

	// --- the authority's decision (163_licensing_authority) --------------------------
	let outcome = $state<ScenarioOutcome | ''>('');
	let reasons = $state('');
	/** Empty: the project's settings.responsibleAuthority (the server refuses when it names none). */
	let authority = $state('');
	let decisionDate = $state('');
	let reference = $state('');
	let reasonsReceived = $state<'' | 'yes' | 'no'>('');
	function decide(e: SubmitEvent) {
		e.preventDefault();
		if (!outcome || !decisionDate || !reasonsReceived) return;
		const body = {
			outcome,
			...(authority.trim() ? { authority: authority.trim() } : {}),
			decisionDate,
			reference: reference.trim(),
			reasonsReceived: reasonsReceived === 'yes',
			note: reasons.trim()
		};
		act('Decision recorded.', () => api.scenarios.decide(projectId, s.id, body));
	}
	/** The decision's record under its outcome: the reference, the reasons answer, who recorded it and when. */
	const decisionRecord = $derived(
		[
			s.decisionReference ? `Reference ${s.decisionReference}.` : '',
			s.reasonsReceived === true ? 'Written reasons received.' : s.reasonsReceived === false ? 'Written reasons not received.' : '',
			`Recorded${s.decidedBy ? ` by ${s.decidedBy}` : ''}${s.decidedAt ? ` on ${fmtDate(s.decidedAt, true)}` : ''}.`
		]
			.filter(Boolean)
			.join(' ')
	);
	/** An editor who didn't make it: they read it as an assessor (comments, share links), deciding or not. */
	const assessor = $derived(canDecide || (canEdit && !isOwner));

	// --- sharing -------------------------------------------------------------------------
	// The owner picks from the people the server lists for them (an applicant:
	// their own party, which the project owner sets), never types an address:
	// nothing they can send says who else is a member (049).
	let candidates = $state<Scenario['members'] | null>(null);
	let pick = $state('');
	const pickable = $derived((candidates ?? []).filter((c) => !s.members.some((m) => m.userId === c.userId)));
	// Fetched once per application, not again each time the scenario object is replaced.
	const scenarioId = $derived(s.id);
	$effect(() => {
		if (!isOwner) return;
		const sid = scenarioId;
		candidates = null;
		api.scenarios.shareCandidates(projectId, sid).then(
			(c) => {
				if (sid === scenarioId) candidates = c;
			},
			(err) => {
				candidates = [];
				error = msg(err);
			}
		);
	});
	async function share(e: SubmitEvent) {
		e.preventDefault();
		const who = pickable.find((c) => c.userId === pick);
		if (!who) return;
		busy = true;
		error = null;
		try {
			await api.scenarios.share(projectId, s.id, who.userId);
			onchange(await api.scenarios.get(projectId, s.id));
			note = `Shared with ${who.displayName}.`;
			pick = '';
		} catch (err) {
			error = msg(err);
		} finally {
			busy = false;
		}
	}
	async function unshare(userId: string, name: string) {
		const self = userId === session.user?.id;
		const ok = await confirmDialog(
			self
				? { title: `Stop reading “${s.name}”?`, confirmLabel: 'Stop reading' }
				: { title: `Stop sharing “${s.name}” with ${name}?`, confirmLabel: 'Stop sharing', danger: true }
		);
		if (!ok) return;
		busy = true;
		error = null;
		try {
			await api.scenarios.unshare(projectId, s.id, userId);
			note = self ? 'You left this application.' : `${name} removed.`;
			if (self) onleft();
			else onchange(await api.scenarios.get(projectId, s.id));
		} catch (err) {
			error = msg(err);
		} finally {
			busy = false;
		}
	}

	// --- evidence packs ---------------------------------------------------------------
	let packs = $state.raw<Pack[] | null>(null);
	let packsFailed = $state(false);
	/** The applicant's: the issued ones, from their own projection (they read no pack row). */
	let myPacks = $state.raw<ApplicantPackMeta[] | null>(null);
	$effect(() => {
		const sid = scenarioId;
		packs = null;
		myPacks = null;
		packsFailed = false;
		const failed = () => {
			if (sid === scenarioId) packsFailed = true;
		};
		if (canReadPacks)
			api.packs.list(projectId).then((all) => {
				if (sid === scenarioId) packs = packsByScenario(all).get(sid) ?? [];
			}, failed);
		else
			api.scenarios.packs(projectId, sid).then((list) => {
				if (sid === scenarioId) myPacks = list;
			}, failed);
	});

	// --- comments and share links (WP-3.15) -------------------------------------------
	const party = $derived(isOwner || s.members.some((m) => m.userId === session.user?.id));
	const audiences = $derived(scenarioAudiences({ assessor, party }));
	/** The applicant or an assessor shares it, once submitted or decided (the API holds the rule). */
	const canShare = $derived(isOwner || assessor);
	let shareOpen = $state(false);

	const STAGE: Record<Scenario['status'], string> = {
		draft: 'Draft: only you and the people you share it with can see it.',
		submitted: 'Submitted: the assessors can see it, and its changes are frozen.',
		withdrawn: 'Withdrawn: the assessors can still see it. Reopen it to change it and submit again.',
		decided: 'Decided.'
	};
</script>

<section class="app" aria-labelledby="app-h" data-testid="application-panel">
	<h3 id="app-h">Application</h3>
	<p class="stage">
		{STAGE[s.status]}
		{#if s.submittedAt}<span class="muted">Submitted {fmtDate(s.submittedAt, true)}.</span>{/if}
	</p>

	{#if s.status === 'decided' && s.outcome}
		<div class="decision" data-testid="application-decision">
			<p>
				<strong>{OUTCOME_LABEL[s.outcome]}</strong>{s.decisionAuthority ? `: the decision of ${s.decisionAuthority}` : ''}{s.decisionDate ? `, dated ${fmtDay(s.decisionDate)}` : ''}.
			</p>
			<p class="small">{decisionRecord}</p>
			{#if s.decisionNote}<p class="reasons">{s.decisionNote}</p>{/if}
			<p class="small muted">Any appeal runs from the authority’s decision letter (National Water Act s148, s41(6)); this app doesn’t work out its deadline.</p>
		</div>
	{/if}

	<div class="actions talk">
		<NotesDrawer {projectId} target={{ kind: 'scenario', scenarioId: s.id, name: s.name, audiences }} />
		{#if canShare}
			<button type="button" class="btn btn-sm" onclick={() => (shareOpen = true)} data-testid="scenario-share-open">Share link…</button>
		{/if}
	</div>

	{#if isOwner}
		<div class="actions">
			{#if s.status === 'draft'}
				<button type="button" class="btn btn-primary" disabled={busy || locked || problems > 0} onclick={submit}>Submit to the assessors</button>
			{:else if s.status === 'submitted'}
				<button type="button" class="btn" disabled={busy || locked} onclick={withdraw}>Withdraw</button>
			{:else if s.status === 'withdrawn'}
				<button type="button" class="btn" disabled={busy || locked} onclick={reopen}>Reopen as a draft</button>
			{/if}
		</div>
		{#if s.status === 'draft' && problems > 0}<p class="hint">Remove the changes that don't apply before submitting.</p>{/if}
	{/if}

	{#if assessor && unverifiedRuns > 0}
		<div class="alert alert-warning" role="status" data-testid="application-unverified">
			{unverifiedRuns === 1 ? '1 run of this application wasn’t' : `${unverifiedRuns} runs of this application weren’t`} stored by the model run itself: the server’s
			stamp is missing or no longer matches the results, so {unverifiedRuns === 1 ? 'it can’t be signed off' : 'they can’t be signed off'}{s.status === 'submitted'
				? `, and the application can’t be decided until ${unverifiedRuns === 1 ? 'it is' : 'they are'} deleted (Runs tab)`
				: ''}.
		</div>
	{/if}
	{#if canDecide && s.status === 'submitted'}
		<form class="decide" onsubmit={decide} aria-labelledby="decide-h">
			<h4 id="decide-h">Record the authority’s decision</h4>
			<p class="hint">Only the responsible authority decides a licence (National Water Act s27, s41, s42). Record its decision as its letter gives it.</p>
			<fieldset>
				<legend>Outcome</legend>
				{#each SCENARIO_OUTCOMES as o (o)}
					<label><input type="radio" name="outcome" value={o} bind:group={outcome} /> {OUTCOME_LABEL[o]} <span class="muted small">({OUTCOME_BASIS[o]})</span></label>
				{/each}
			</fieldset>
			<div class="field">
				<label for="decide-authority">Responsible authority</label>
				<input id="decide-authority" type="text" maxlength="200" bind:value={authority} aria-describedby="decide-authority-help" />
				<p id="decide-authority-help" class="hint">Leave it empty for the authority named in the project’s settings.</p>
			</div>
			<div class="form-row">
				<div class="field">
					<label for="decide-date">Date of the decision letter</label>
					<input id="decide-date" type="date" required bind:value={decisionDate} />
				</div>
				<div class="field grow">
					<label for="decide-ref">Licence or file reference <span class="muted">(optional)</span></label>
					<input id="decide-ref" type="text" maxlength="200" bind:value={reference} />
				</div>
			</div>
			<fieldset>
				<legend>Written reasons received?</legend>
				<label><input type="radio" name="reasons-received" value="yes" bind:group={reasonsReceived} /> Yes</label>
				<label><input type="radio" name="reasons-received" value="no" bind:group={reasonsReceived} /> No</label>
			</fieldset>
			<div class="field">
				<label for="decide-note">Note: the authority’s reasons and conditions</label>
				<textarea id="decide-note" rows="3" maxlength="4000" bind:value={reasons} aria-describedby="decide-note-help"></textarea>
				<p id="decide-note-help" class="hint">Shown on the application’s read-only share links, which the applicant can make too.</p>
			</div>
			<button type="submit" class="btn btn-primary" disabled={busy || locked || !outcome || !decisionDate || !reasonsReceived || unverifiedRuns > 0}
				>Record the authority’s decision</button
			>
			<p class="hint">A recorded decision is final: the application can't then be withdrawn or changed.</p>
		</form>
	{:else if assessor && s.status === 'submitted'}
		<p class="hint" data-testid="application-decide-who">
			Only a member the project’s owner marks as acting for the responsible authority records its decision (Members).
		</p>
	{/if}

	{#if canReadPacks}
		<div class="packs" data-testid="application-panel-packs">
			<h4>Evidence packs</h4>
			{#if packsFailed}
				<p class="muted">The packs couldn’t be read.</p>
			{:else if packs === null}
				<p class="muted">Loading…</p>
			{:else if packs.length}
				<ul>
					{#each packs as p (p.id)}
						<li>
							<PackBadge status={p.status} version={p.version} />
							<a href={packHref(base, projectId, p.id)}>Version {p.version}, code {p.shortCode}</a>
							<span class="muted">{p.issuedAt ? `issued ${fmtDate(p.issuedAt)}` : `drafted ${fmtDate(p.createdAt)}`}</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="muted">None. An editor makes one from a run’s evidence report.</p>
			{/if}
		</div>
	{:else}
		<div class="packs" data-testid="application-panel-my-packs">
			<h4>Evidence packs</h4>
			{#if packsFailed}
				<p class="muted">The packs couldn’t be read.</p>
			{:else if myPacks === null}
				<p class="muted">Loading…</p>
			{:else if myPacks.length}
				<ul>
					{#each myPacks as p (p.id)}
						<li>
							<PackBadge status={p.status} version={p.version} />
							<a href={applicantPackHref(base, projectId, s.id, p.id)}>Version {p.version}, code {p.shortCode}</a>
							<span class="muted">issued {fmtDate(p.issuedAt)}</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="muted">None issued yet. The assessors issue a pack of the application once it is submitted; you can then read it here and share it by link.</p>
			{/if}
		</div>
	{/if}

	<div class="shared">
		<h4>Shared with</h4>
		{#if s.members.length}
			<ul>
				{#each s.members as m (m.userId)}
					<li>
						{m.displayName}
						{#if isOwner || m.userId === session.user?.id}
							<button type="button" class="btn btn-sm btn-ghost" disabled={busy} onclick={() => unshare(m.userId, m.displayName)}
								>{m.userId === session.user?.id ? 'Leave' : 'Remove'}<span class="visually-hidden">{m.userId === session.user?.id ? '' : ` ${m.displayName}`}</span></button
							>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">Nobody else.</p>
		{/if}
		{#if isOwner}
			{#if candidates && !pickable.length}
				<p class="hint" data-testid="share-none">
					{candidates.length ? 'Everyone you can share it with already reads it.' : 'Nobody to share it with yet: the project owner lists who is in your party (your consultant or client).'}
				</p>
			{:else if candidates}
				<form class="form-row" onsubmit={share}>
					<div class="field grow">
						<label for="share-who">Share with</label>
						<select id="share-who" bind:value={pick}>
							<option value="">Choose someone…</option>
							{#each pickable as c (c.userId)}<option value={c.userId}>{c.displayName}</option>{/each}
						</select>
					</div>
					<div class="field">
						<button type="submit" class="btn" disabled={busy || !pick}>Share</button>
					</div>
				</form>
			{/if}
		{/if}
	</div>

	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<p class="visually-hidden" role="status">{note}</p>
</section>

{#if canShare}
	<Dialog bind:open={shareOpen} title="Share “{s.name}” read-only" side>
		{#if shareOpen}<ShareLinksPanel {projectId} scenario={{ id: s.id, name: s.name, status: s.status }} />{/if}
		{#snippet actions()}
			<button type="button" class="btn" onclick={() => (shareOpen = false)}>Close</button>
		{/snippet}
	</Dialog>
{/if}

<style>
	.app {
		margin-top: 1rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	h3 {
		margin: 0 0 0.25rem;
		font-size: 1rem;
	}
	h4 {
		margin: 0.75rem 0 0.25rem;
		font-size: 0.95rem;
	}
	.stage {
		margin: 0 0 0.5rem;
	}
	.decision {
		padding: 0.5rem 0.75rem;
		border-left: 3px solid var(--accent);
		background: var(--surface-2);
		border-radius: var(--radius);
	}
	.decision p {
		margin: 0;
	}
	.reasons {
		white-space: pre-wrap;
		margin-top: 0.25rem !important;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.5rem 0;
	}
	fieldset {
		border: 0;
		padding: 0;
		margin: 0 0 0.5rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
	}
	legend {
		font-weight: 500;
		margin-bottom: 0.25rem;
	}
	fieldset label {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: var(--tap, 44px);
	}
	.packs ul {
		list-style: none;
		padding: 0;
		margin: 0 0 0.5rem;
		display: grid;
		gap: 0.3rem;
	}
	.packs li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.5rem;
	}
	.shared ul {
		margin: 0 0 0.5rem;
		padding-left: 1.2rem;
	}
	.hint {
		font-size: 0.82rem;
		color: var(--text-muted);
		margin: 0.25rem 0 0.5rem;
	}
</style>
