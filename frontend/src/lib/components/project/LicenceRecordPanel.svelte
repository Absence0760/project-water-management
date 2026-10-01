<script lang="ts">
	// The licence record (161_licence_record, docs/ui.md § Project): the licence
	// decision this project's evidence supports, and so how long the names an
	// issued pack or a sign-off keeps are kept. Editors read it; owners record
	// the outcome or confirm a review (the API answers anyone else 403, and
	// ProjectTab renders it for editors and owners only). Provisional position
	// (pre-counsel research, 2026-10-01).
	import { onMount } from 'svelte';
	import { api, type LicenceRecord } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { formOf, formProblem, OUTCOME_LABEL, outcomeBody, recordStatus, type OutcomeForm } from './licenceRecord';

	let { projectId, isOwner }: { projectId: string; isOwner: boolean } = $props();

	let record = $state<LicenceRecord | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let error = $state<string | null>(null);
	let saving = $state(false);
	let form = $state<OutcomeForm>({ outcome: '', outcomeOn: '', expiresOn: '', reason: '' });
	let notice = $state('');

	const today = new Date().toISOString().slice(0, 10);
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const status = $derived(record ? recordStatus(record, today) : null);
	const problem = $derived(formProblem(form));

	async function load() {
		loading = true;
		loadError = null;
		try {
			record = await api.licenceRecord.get(projectId);
			form = formOf(record);
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (problem) return;
		saving = true;
		error = null;
		notice = '';
		try {
			record = await api.licenceRecord.set(projectId, outcomeBody(form));
			form = formOf(record);
			notice = 'Saved.';
		} catch (err) {
			error = msg(err);
		} finally {
			saving = false;
		}
	}

	async function confirm() {
		saving = true;
		error = null;
		notice = '';
		try {
			record = await api.licenceRecord.confirm(projectId);
			notice = `Confirmed. The next review is on ${record.reviewDueOn}.`;
		} catch (err) {
			error = msg(err);
		} finally {
			saving = false;
		}
	}
</script>

<section class="panel" aria-labelledby="licence-record" data-testid="licence-record">
	<div class="panel-head">
		<h2 id="licence-record">Licence record</h2>
	</div>
	<p class="muted small intro">
		An issued evidence pack and a signed-off run keep the names of the people who made and signed them, also after their accounts are
		deleted. They are kept until three years after the licence expires, or three years after the application is refused or withdrawn.
		Until the outcome is recorded here, an owner confirms every five years that the record is still needed. Nothing is deleted
		automatically.
	</p>
	<LoadState {loading} error={loadError} retry={load}>
		{#if record && status}
			<p class={status.due ? 'alert alert-warning' : 'muted'} data-testid="licence-record-status">{status.text}</p>
			{#if record.outcome && record.reason}<p class="muted small">Recorded because: {record.reason}</p>{/if}
			{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
			{#if notice}<p class="muted small" role="status">{notice}</p>{/if}
			{#if isOwner}
				{#if !record.outcome && record.reviewDueOn}
					<p>
						<button class="btn btn-sm" type="button" disabled={saving} onclick={confirm}>The record is still needed</button>
						<span class="muted small">Sets the next review five years from today.</span>
					</p>
				{/if}
				<form class="outcome" aria-label="Record the licence outcome" onsubmit={save}>
					<div class="field">
						<label for="lr-outcome">Outcome</label>
						<select id="lr-outcome" bind:value={form.outcome}>
							<option value="">Not recorded</option>
							{#each Object.entries(OUTCOME_LABEL) as [v, label] (v)}<option value={v}>{label}</option>{/each}
						</select>
					</div>
					{#if form.outcome !== ''}
						<div class="field">
							<label for="lr-on">Decided on</label>
							<input id="lr-on" type="date" bind:value={form.outcomeOn} />
						</div>
					{/if}
					{#if form.outcome === 'granted'}
						<div class="field">
							<label for="lr-expires">Licence expires on</label>
							<input id="lr-expires" type="date" bind:value={form.expiresOn} />
						</div>
					{/if}
					<div class="field">
						<label for="lr-reason">Why</label>
						<input id="lr-reason" maxlength="2000" placeholder="DWS letter 16/2/7/A of 1 March 2026" bind:value={form.reason} aria-describedby="lr-problem" />
						{#if problem && form.reason}<span class="hint" id="lr-problem">{problem}</span>{/if}
					</div>
					<div>
						<button class="btn btn-primary" type="submit" disabled={saving || !!problem}>{saving ? 'Saving…' : 'Save the outcome'}</button>
					</div>
				</form>
			{/if}
		{/if}
	</LoadState>
</section>

<style>
	.intro {
		margin-top: 0;
	}
	.outcome {
		display: grid;
		gap: 0.75rem;
	}
</style>
