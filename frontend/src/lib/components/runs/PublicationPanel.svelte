<!--
	The project's published baseline (WP-2.3, docs/ui.md § Publishing a run):
	whether the shown run is the one stakeholders see, the action to publish it
	(editors, with a confirm dialog saying what changes for them) and the WUA's
	restriction notice, which an editor can change without re-publishing.
	Farmers see the published run's figures for their own farm; everyone on
	the project sees the notice.
-->
<script lang="ts">
	import { api, PUBLICATION_TEXT_MAX, type Publication, type PublicationMeta, type Run } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { fmtDate, fmtDay } from '$lib/format/number';
	import { damsWithoutStopLevel, draftFrom, emptyDraft, LEVEL_LABEL, noticeLanguages, noticeTextFields, parseDraft, publishBlocker, restrictionSummary, type NoticeDraft } from './publication';

	let {
		projectId,
		run,
		current,
		history,
		canEdit,
		onChange
	}: {
		projectId: string;
		/** The shown run, with its model snapshot (for the stop-level warning). */
		run: Run;
		current: Publication | null;
		history: PublicationMeta[];
		canEdit: boolean;
		onChange?: (p: { current: Publication; history: PublicationMeta[] }) => void;
	} = $props();

	const uid = $props.id();
	const fmt = (iso: string) => fmtDate(iso, true);
	const isCurrent = $derived(current?.runId === run.id);
	const blocker = $derived(publishBlocker(run));
	const noStop = $derived(damsWithoutStopLevel(run.model?.nodes as { kind?: string; damCapacityM3?: number; damMinPct?: number }[] | undefined));
	const wasPublished = $derived(!isCurrent && history.some((h) => h.runId === run.id));

	let dialogOpen = $state(false);
	let editing = $state(false);
	let draft = $state<NoticeDraft>(emptyDraft());
	let note = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);
	let done = $state<string | null>(null);

	function openPublish() {
		// Start from the current notice: re-publishing usually keeps it.
		draft = draftFrom(current);
		note = '';
		error = null;
		done = null;
		dialogOpen = true;
	}
	function openEdit() {
		draft = draftFrom(current);
		error = null;
		done = null;
		editing = true;
	}

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function publish() {
		const parsed = parseDraft(draft);
		if (!parsed.ok) {
			error = parsed.error;
			return;
		}
		saving = true;
		error = null;
		try {
			const { publication, farms } = await api.publication.publish(projectId, {
				runId: run.id,
				restriction: parsed.restriction,
				nextExpectedOn: parsed.nextExpectedOn,
				...(note.trim() ? { note: note.trim() } : {})
			});
			const { history: h } = await api.publication.get(projectId);
			dialogOpen = false;
			done = `Published. ${farms === 1 ? '1 farmer view' : `${farms} farmer views`} updated.`;
			onChange?.({ current: publication, history: h });
		} catch (e) {
			error = msg(e);
		} finally {
			saving = false;
		}
	}

	async function saveNotice(e: SubmitEvent) {
		e.preventDefault();
		if (!current) return;
		const parsed = parseDraft(draft);
		if (!parsed.ok) {
			error = parsed.error;
			return;
		}
		saving = true;
		error = null;
		try {
			const publication = await api.publication.update(projectId, current.id, { restriction: parsed.restriction, nextExpectedOn: parsed.nextExpectedOn });
			editing = false;
			done = 'Notice saved.';
			// The history entry of the current publication carries its level too.
			onChange?.({ current: publication, history: history.map((h) => (h.id === publication.id ? { ...h, restriction: { level: publication.restriction.level } } : h)) });
		} catch (err) {
			error = msg(err);
		} finally {
			saving = false;
		}
	}
</script>

{#snippet noticeFields(prefix: string)}
	<fieldset class="notice-fields">
		<legend>The WUA’s notice</legend>
		<div class="row">
			<div class="field">
				<label for="{prefix}-level">Level</label>
				<select id="{prefix}-level" bind:value={draft.level}>
					{#each ['none', 'advisory', 'restricted'] as const as level (level)}<option value={level}>{LEVEL_LABEL[level]}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="{prefix}-pct">Cut <span class="muted">(%, optional)</span></label>
				<input id="{prefix}-pct" inputmode="decimal" bind:value={draft.pct} disabled={draft.level === 'none'} />
			</div>
			<div class="field">
				<label for="{prefix}-next">Next update expected <span class="muted">(optional)</span></label>
				<input id="{prefix}-next" type="date" bind:value={draft.nextExpectedOn} />
			</div>
		</div>
		{#each noticeTextFields() as f (f.code)}
			<label for="{prefix}-{f.code}">{f.label} <span class="muted">(optional)</span></label>
			<textarea id="{prefix}-{f.code}" lang={f.code} rows="3" maxlength={PUBLICATION_TEXT_MAX} bind:value={draft.notice[f.code]}></textarea>
		{/each}
		<p class="muted small">Farmers read the notice first, in their language (in English, or another one written, when theirs is empty). The app never writes restriction wording itself.</p>
	</fieldset>
{/snippet}

<section aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">
		Publication
		{#if isCurrent}<span class="badge badge-owner">Published</span>{/if}
	</h3>
	<p>
		{#if isCurrent && current}
			This run is the published baseline: stakeholders and farmers see its figures. Published {fmt(current.publishedAt)}{current.publishedBy ? ` by ${current.publishedBy}` : ''}.
		{:else if current}
			This run is not published. The published baseline is another run, published {fmt(current.publishedAt)}{current.publishedBy ? ` by ${current.publishedBy}` : ''}.
		{:else}
			Nothing is published yet: farmers see no figures until a run is published.
		{/if}
		{#if wasPublished}It was published before, so it is kept while the publication history holds it.{/if}
	</p>

	{#if current}
		<dl class="notice" aria-label="Current notice">
			<dt>Notice</dt>
			<dd>{restrictionSummary(current.restriction)}</dd>
			{#each noticeLanguages(current.restriction.notice) as n (n.code)}<dt>{n.name}</dt><dd class="text" lang={n.code}>{n.text}</dd>{/each}
			<dt>Next update</dt>
			<dd>{current.nextExpectedOn ? fmtDay(current.nextExpectedOn) : 'Not set'}</dd>
			{#if current.updatedAt}<dt>Notice changed</dt><dd>{fmt(current.updatedAt)}{current.updatedBy ? ` by ${current.updatedBy}` : ''}</dd>{/if}
		</dl>
	{/if}

	{#if canEdit}
		<div class="acts">
			{#if blocker}
				<p class="muted small">{blocker}</p>
			{:else if !isCurrent}
				<button type="button" class="btn btn-primary btn-sm" onclick={openPublish}>Publish this run</button>
			{/if}
			{#if current && !editing}
				<button type="button" class="btn btn-sm" onclick={openEdit}>Edit notice</button>
			{/if}
		</div>
		{#if editing && current}
			<form class="edit" onsubmit={saveNotice} aria-label="Edit the notice">
				{@render noticeFields(`${uid}-edit`)}
				<div class="acts">
					<button type="submit" class="btn btn-primary btn-sm" disabled={saving}>{saving ? 'Saving…' : 'Save notice'}</button>
					<button type="button" class="btn btn-sm" onclick={() => (editing = false)} disabled={saving}>Cancel</button>
				</div>
			</form>
		{/if}
	{/if}
	{#if error && !dialogOpen}<div class="alert alert-error" role="alert">{error}</div>{/if}
	{#if done}<p class="alert alert-info" role="status">{done}</p>{/if}
</section>

<Dialog bind:open={dialogOpen} title="Publish this run?" wide>
	<p>Publishing makes “{run.label || 'Untitled run'}” the run stakeholders see:</p>
	<ul>
		<li>each farmer sees this run’s figures for their own hydrological unit, from 1 October to {run.endDate}, and the notice below;</li>
		<li>{current ? 'it replaces the current published baseline, which stays in the history' : 'it becomes the first published baseline'}, and the run is kept while the history holds it.</li>
	</ul>
	{#if noStop}
		<p class="alert alert-warning" role="status">
			{noStop === 1 ? '1 hydrological unit’s dam has' : `${noStop} hydrological units’ dams have`} no stop level (0 %), so their farmers are told the model assumes the pump can empty the dam. Set each dam’s stop level on the Network tab to show them the water they can still use.
		</p>
	{/if}
	{@render noticeFields(`${uid}-pub`)}
	<label for="{uid}-note">Note for the project’s staff <span class="muted">(optional; farmers don’t see it)</span></label>
	<textarea id="{uid}-note" rows="2" maxlength={PUBLICATION_TEXT_MAX} bind:value={note}></textarea>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (dialogOpen = false)} disabled={saving}>Cancel</button>
		<button type="button" class="btn btn-primary" onclick={publish} disabled={saving}>{saving ? 'Publishing…' : 'Publish'}</button>
	{/snippet}
</Dialog>

<style>
	h3 .badge {
		margin-left: 0.4rem;
		vertical-align: 1px;
	}
	.notice {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.25rem 1rem;
		margin: 0.5rem 0 0.75rem;
		max-width: 90ch;
	}
	.notice dt {
		color: var(--text-muted);
	}
	.notice dd {
		margin: 0;
	}
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.acts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		margin: 0.5rem 0;
	}
	.notice-fields {
		border: 0;
		padding: 0;
		margin: 0.75rem 0;
		min-width: 0;
	}
	.notice-fields legend {
		font-weight: 600;
		padding: 0;
		margin-bottom: 0.4rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	.row .field {
		margin: 0 0 0.5rem;
		min-width: min(100%, 11rem);
	}
	textarea {
		width: 100%;
		max-width: 90ch;
		font: inherit;
		display: block;
		margin: 0.25rem 0 0.5rem;
	}
	.edit {
		max-width: 90ch;
	}
	.small {
		font-size: 0.85rem;
	}
</style>
