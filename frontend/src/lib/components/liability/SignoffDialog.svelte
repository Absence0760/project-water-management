<script lang="ts">
	// Sign a run off (WP-3.13, docs/ui.md § Report). The signer's name and
	// registration come first (the first statement is about "the person named
	// above"), then every statement is ticked on its own and the whole
	// known-limitations list must be scrolled through before it can be
	// submitted. The server gets back the hash of the
	// statement shown here and refuses a sign-off if the statement has changed
	// since (onstale reloads it).
	import { tick, untrack } from 'svelte';
	import { api, ApiError, type Signoff, type SignoffList } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { DEFAULT_REGISTRATION_BODY, scrolledToEnd, signoffBlockers } from './signoffForm';

	let {
		open = $bindable(false),
		projectId,
		runId,
		list,
		onsigned,
		onstale
	}: {
		open?: boolean;
		projectId: string;
		runId: string;
		list: SignoffList;
		onsigned: (s: Signoff) => void;
		onstale: () => void;
	} = $props();

	const uid = `so-${Math.random().toString(36).slice(2, 9)}`;
	const statement = $derived(list.statement);
	let ticked = $state(new Set<string>());
	let readAll = $state(false);
	let fullName = $state('');
	let registrationBody = $state(DEFAULT_REGISTRATION_BODY);
	let registrationNo = $state('');
	let scope = $state('');
	let busy = $state(false);
	let error = $state('');
	let box: HTMLElement | undefined = $state();

	const blockers = $derived(
		signoffBlockers({ fullName, registrationBody, registrationNo, scope }, statement.confirmations.map((c) => c.id), ticked, readAll)
	);

	function toggle(id: string, on: boolean) {
		const next = new Set(ticked);
		if (on) next.add(id);
		else next.delete(id);
		ticked = next;
	}

	const checkRead = () => {
		if (box && scrolledToEnd(box)) readAll = true;
	};
	// A new statement (reloaded after a 409) is read and ticked afresh. A list
	// short enough not to scroll is read as soon as it's shown.
	$effect(() => {
		void list.statementSha256;
		if (!box) return;
		untrack(() => {
			ticked = new Set();
			readAll = false;
			box!.scrollTop = 0;
			tick().then(checkRead);
		});
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (blockers.length || busy) return;
		busy = true;
		error = '';
		try {
			const s = await api.signoffs.create(projectId, runId, {
				fullName,
				registrationBody,
				registrationNo,
				scope,
				confirmed: [...ticked],
				statementSha256: list.statementSha256
			});
			onsigned(s);
			open = false;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			if (err instanceof ApiError && err.status === 409) onstale();
		} finally {
			busy = false;
		}
	}
</script>

<Dialog bind:open title="Sign off this run" wide>
	<form id="{uid}-form" onsubmit={submit}>
		<p>
			You sign as a registered professional, for this run as it was made (engine {statement.engineVersion}). A sign-off is permanent: it can’t be
			changed or withdrawn, only followed by another.
		</p>
		<!-- Before the confirmations: the first refers to "the person named above". -->
		<div class="grid">
			<label>Full name <input bind:value={fullName} maxlength="200" autocomplete="name" required /></label>
			<label>Registration body <input bind:value={registrationBody} maxlength="100" required /></label>
			<label>Registration number <input bind:value={registrationNo} maxlength="50" required /></label>
		</div>
		<label>What this sign-off covers <textarea bind:value={scope} maxlength="1000" rows="2" required placeholder="e.g. the hydrology section of the WULA technical report for the proposed dam"></textarea></label>
		<fieldset>
			<legend>I confirm that:</legend>
			{#each statement.confirmations as c (c.id)}
				<label class="check">
					<input type="checkbox" checked={ticked.has(c.id)} onchange={(e) => toggle(c.id, e.currentTarget.checked)} />
					<span>{c.text}</span>
				</label>
			{/each}
		</fieldset>

		<h3 id="{uid}-lim">Known limitations ({statement.limitations.length})</h3>
		<!-- Focusable so a keyboard can scroll it; reading to the end is what enables the sign-off. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="limits" bind:this={box} onscroll={checkRead} tabindex="0" role="region" aria-labelledby="{uid}-lim">
			<ul>
				{#each statement.limitations as l (l.id)}<li><strong>{l.id}</strong> {l.title}. <span class="muted">{l.status}.</span></li>{/each}
			</ul>
		</div>
		<p class="muted small" aria-live="polite">{readAll ? 'You have reached the end of the list.' : 'Scroll to the end of the list to continue.'}</p>

		<ul class="notes small">
			{#each statement.notes as n, i (i)}<li>{n}</li>{/each}
		</ul>

		{#if list.disclaimer.status === 'draft'}
			<p class="muted small">The report’s disclaimer (version {list.disclaimer.version}) is draft wording, pending the client’s legal review.</p>
		{/if}
		{#if error}<p class="alert alert-error" role="alert">{error}</p>{/if}
		{#if blockers.length}<p class="muted small" id="{uid}-why">{blockers.join(' ')}</p>{/if}
	</form>
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
		<button
			type="submit"
			form="{uid}-form"
			class="btn btn-primary"
			disabled={blockers.length > 0 || busy}
			aria-describedby={blockers.length ? `${uid}-why` : undefined}>{busy ? 'Signing…' : 'Sign off'}</button
		>
	{/snippet}
</Dialog>

<style>
	fieldset {
		border: 0;
		padding: 0;
		margin: 0.75rem 0 1rem;
	}
	legend {
		font-weight: 600;
		margin-bottom: 0.4rem;
	}
	.check {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		min-height: 24px;
		margin: 0.3rem 0;
	}
	.check input {
		margin-top: 0.2rem;
		flex: none;
	}
	h3 {
		margin: 0.75rem 0 0.4rem;
	}
	.limits {
		max-height: 14rem;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.25rem 0.75rem;
		background: var(--surface-sunken);
	}
	.limits:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 1px;
	}
	.limits li {
		margin: 0.4rem 0;
		line-height: 1.4;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
		gap: 0.5rem 0.75rem;
		margin: 0.75rem 0 0.5rem;
	}
	label {
		display: block;
	}
	.notes {
		padding-left: 1.2rem;
	}
</style>
