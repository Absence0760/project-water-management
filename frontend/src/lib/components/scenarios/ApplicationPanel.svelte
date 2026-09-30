<script lang="ts">
	// An application's workflow (WP-3.3, docs/ui.md § Applications): where it
	// stands, the owner's Submit / Withdraw / Reopen, the assessor's decision,
	// and who it is shared with. The server holds every rule (who may move it,
	// that a submit freezes the ops, that no one decides their own); this
	// offers only the moves it would allow. For the project's viewers and up
	// (not its applicants, who read no pack), it lists the application's
	// evidence packs (WP-3.14) with their status.
	import { base } from '$app/paths';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { api, OUTCOME_LABEL, scenarioProblems, SCENARIO_OUTCOMES, type Pack, type Scenario, type ScenarioOutcome, type ScenarioWithCheck } from '$lib/api';
	import PackBadge from '$lib/components/packs/PackBadge.svelte';
	import { packHref, packsByScenario } from '$lib/components/packs/pack';
	import { session } from '$lib/auth/session.svelte';
	import { fmtDate } from '$lib/format/number';

	let {
		projectId,
		scenario: s,
		isOwner,
		canDecide,
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
		/** An editor who isn't its owner: they decide it once submitted. */
		canDecide: boolean;
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
		/** The caller reads evidence packs (viewer and up; an applicant doesn't). */
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

	// --- the decision ------------------------------------------------------------------
	let outcome = $state<ScenarioOutcome | ''>('');
	let reasons = $state('');
	function decide(e: SubmitEvent) {
		e.preventDefault();
		if (!outcome) return;
		const o = outcome;
		act('Decided.', () => api.scenarios.decide(projectId, s.id, o, reasons.trim()));
	}

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
	$effect(() => {
		if (!canReadPacks) return;
		const sid = scenarioId;
		packs = null;
		packsFailed = false;
		api.packs.list(projectId).then(
			(all) => {
				if (sid === scenarioId) packs = packsByScenario(all).get(sid) ?? [];
			},
			() => {
				if (sid === scenarioId) packsFailed = true;
			}
		);
	});

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
			<p><strong>{OUTCOME_LABEL[s.outcome]}</strong>{s.decidedBy ? ` by ${s.decidedBy}` : ''}{s.decidedAt ? `, ${fmtDate(s.decidedAt, true)}` : ''}.</p>
			{#if s.decisionNote}<p class="reasons">{s.decisionNote}</p>{/if}
		</div>
	{/if}

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

	{#if canDecide && unverifiedRuns > 0}
		<div class="alert alert-warning" role="status" data-testid="application-unverified">
			{unverifiedRuns === 1 ? '1 run of this application wasn’t' : `${unverifiedRuns} runs of this application weren’t`} stored by the model run itself: the server’s
			stamp is missing or no longer matches the results, so {unverifiedRuns === 1 ? 'it can’t be signed off' : 'they can’t be signed off'}{s.status === 'submitted'
				? `, and the application can’t be decided until ${unverifiedRuns === 1 ? 'it is' : 'they are'} deleted (Runs tab)`
				: ''}.
		</div>
	{/if}
	{#if canDecide && s.status === 'submitted'}
		<form class="decide" onsubmit={decide} aria-labelledby="decide-h">
			<h4 id="decide-h">Decide</h4>
			<fieldset>
				<legend>Outcome</legend>
				{#each SCENARIO_OUTCOMES as o (o)}
					<label><input type="radio" name="outcome" value={o} bind:group={outcome} /> {OUTCOME_LABEL[o]}</label>
				{/each}
			</fieldset>
			<div class="field">
				<label for="decide-note">Reasons and conditions</label>
				<textarea id="decide-note" rows="3" maxlength="4000" bind:value={reasons}></textarea>
			</div>
			<button type="submit" class="btn btn-primary" disabled={busy || locked || !outcome || unverifiedRuns > 0}>Record the decision</button>
			<p class="hint">A decision is final: the application can't then be withdrawn or changed.</p>
		</form>
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
