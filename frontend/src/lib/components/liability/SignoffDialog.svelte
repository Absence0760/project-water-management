<script lang="ts">
	// Sign a run off (WP-3.13, docs/ui.md § Report). The signer's name and
	// registration (body, category and field as fixed choices, issue #47;
	// candidate and certificated categories shown but disabled, an unusual
	// category or field warned of inline) come first (the first statement is about "the person named
	// above"), then every statement is ticked on its own and the whole
	// known-limitations list (with the errata of the run's engine version)
	// must be scrolled through before it can be
	// submitted. The server gets back the hash of the
	// statement shown here and refuses a sign-off if the statement has changed
	// since (onstale reloads it). For an evidence pack (WP-3.14, issue #71) it
	// signs the pack statement, and says first that the signer's name and
	// registration are shown publicly on the pack's verify page.
	import { tick, untrack } from 'svelte';
	import { api, ApiError, type PackSignoffList, type Signoff, type SignoffList } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import {
		BLOCKED_CATEGORIES_NOTE,
		REGISTRATION_BODIES,
		registrationBody as bodyInfo,
		registrationCategoriesOf,
		registrationFieldsOf,
		type RegistrationBodyCode
	} from '@water-management/engine';
	import { DEFAULT_REGISTRATION_BODY, PACK_SIGNER_PUBLIC, registrationAdvice, scrolledToEnd, signoffBlockers, statementEngines, type SignoffTarget } from './signoffForm';

	let {
		open = $bindable(false),
		projectId,
		target,
		list,
		onsigned,
		onstale
	}: {
		open?: boolean;
		projectId: string;
		target: SignoffTarget;
		list: SignoffList | PackSignoffList;
		onsigned: (s: Signoff) => void;
		onstale: () => void;
	} = $props();

	const uid = `so-${Math.random().toString(36).slice(2, 9)}`;
	const statement = $derived(list.statement);
	const engines = $derived(statementEngines(statement));
	const pack = $derived('packVersion' in statement ? statement : null);
	let ticked = $state(new Set<string>());
	let readAll = $state(false);
	let fullName = $state('');
	let registrationBody = $state<RegistrationBodyCode>(DEFAULT_REGISTRATION_BODY);
	let registrationCategory = $state('');
	let registrationField = $state('');
	let registrationNo = $state('');
	let scope = $state('');
	let busy = $state(false);
	let error = $state('');
	let box: HTMLElement | undefined = $state();

	const fields = $derived({ fullName, registrationBody, registrationCategory, registrationField, registrationNo, scope });
	const blockers = $derived(signoffBlockers(fields, statement.confirmations.map((c) => c.id), ticked, readAll));
	const advice = $derived(registrationAdvice(fields));
	const body = $derived(bodyInfo(registrationBody)!);
	const categories = $derived(registrationCategoriesOf(registrationBody));
	const fieldChoices = $derived(registrationFieldsOf(registrationBody));

	// Category and field belong to a body: choosing another body clears them.
	function chooseBody(code: RegistrationBodyCode) {
		registrationBody = code;
		registrationCategory = '';
		registrationField = '';
	}

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
			const request = {
				fullName,
				registrationBody,
				registrationCategory,
				registrationField,
				registrationNo,
				scope,
				confirmed: [...ticked],
				statementSha256: list.statementSha256
			};
			const s = target.kind === 'pack' ? await api.packs.sign(projectId, target.id, request) : await api.signoffs.create(projectId, target.id, request);
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

<Dialog bind:open title={pack ? 'Sign off this evidence pack' : 'Sign off this run'} wide>
	<form id="{uid}-form" onsubmit={submit}>
		{#if pack}
			<p>
				You sign as a registered professional, for version {pack.packVersion} of this evidence pack, identified by its manifest SHA-256
				<code class="hash">{pack.manifestSha256}</code>, whose runs were made with engine {engines}. A sign-off is permanent: it can’t be changed or
				withdrawn, only followed by another.
			</p>
			<p class="alert alert-warning" data-testid="signoff-public">{PACK_SIGNER_PUBLIC}</p>
		{:else}
			<p>
				You sign as a registered professional, for this run as it was made (engine {engines}). A sign-off is permanent: it can’t be
				changed or withdrawn, only followed by another.
			</p>
		{/if}
		<!-- Before the confirmations: the first refers to "the person named above". -->
		<div class="grid">
			<label>Full name <input bind:value={fullName} maxlength="200" autocomplete="name" required /></label>
			<!-- Labels beside, not around, the selects: a wrapping label would add the chosen option to the select's name. -->
			<div>
				<label for="{uid}-body">Registration body</label>
				<select id="{uid}-body" value={registrationBody} onchange={(e) => chooseBody(e.currentTarget.value as RegistrationBodyCode)} required>
					{#each REGISTRATION_BODIES as b (b.code)}<option value={b.code}>{b.label}</option>{/each}
				</select>
			</div>
			<div>
				<label for="{uid}-cat">Registration category</label>
				<select id="{uid}-cat" bind:value={registrationCategory} required aria-describedby="{uid}-cat-note">
					<option value="" disabled>Choose…</option>
					{#each categories as c (c.code)}<option value={c.code} disabled={c.status === 'blocked'}>{c.label}</option>{/each}
				</select>
			</div>
			<div>
				<label for="{uid}-field">{body.fieldName}</label>
				<select id="{uid}-field" bind:value={registrationField} required>
					<option value="" disabled>Choose…</option>
					{#each fieldChoices as f (f.code)}<option value={f.code}>{f.label}</option>{/each}
				</select>
			</div>
			<label>Registration number <input bind:value={registrationNo} maxlength="50" required placeholder="e.g. {body.numberExample}" /></label>
		</div>
		<p class="muted small" id="{uid}-cat-note">{BLOCKED_CATEGORIES_NOTE}</p>
		<div aria-live="polite">
			{#if advice.block}<p class="alert alert-error small">{advice.block}</p>{/if}
			{#each advice.warnings as w (w)}<p class="alert alert-warning small">{w}</p>{/each}
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

		<p class="small">
			Methods: methodology statement <strong>{statement.methodology.version}</strong> (docs/methodology in the app's source, SHA-256
			<code>{statement.methodology.sha256.slice(0, 12)}…</code>).
		</p>
		<h3 id="{uid}-lim">Known limitations ({statement.limitations.length}) and errata of engine {engines} ({statement.errata.length})</h3>
		<!-- Focusable so a keyboard can scroll it; reading to the end is what enables the sign-off. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="limits" bind:this={box} onscroll={checkRead} tabindex="0" role="region" aria-labelledby="{uid}-lim">
			<ul>
				{#each statement.limitations as l (l.id)}<li><strong>{l.id}</strong> {l.title}. <span class="muted">{l.status}.</span></li>{/each}
			</ul>
			<p class="small"><strong>Errata</strong> (known bugs recorded for engine {engines} or the engine of its fit, docs/engine-errata.md):</p>
			{#if statement.errata.length}
				<ul>
					{#each statement.errata as e (e.id)}<li><strong>{e.id}</strong> {e.summary}. <span class="muted">Applies when: {e.appliesWhen}. {e.fixedIn ? `Fixed in engine ${e.fixedIn}.` : 'Not fixed yet.'}</span></li>{/each}
				</ul>
			{:else}
				<p class="small muted">None recorded for this engine version in docs/engine-errata.md.</p>
			{/if}
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
	/* A long option ("SACNASP (South African Council …)") stays inside its column. */
	.grid select,
	.grid input {
		display: block;
		width: 100%;
		margin-top: 0.2rem;
	}
	.notes {
		padding-left: 1.2rem;
	}
	.hash {
		overflow-wrap: anywhere;
		font-size: 0.8em;
	}
</style>
