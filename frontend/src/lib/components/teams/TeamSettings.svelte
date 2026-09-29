<script lang="ts">
	// The team page's settings sheet (docs/ui.md § Teams): the team's name, the
	// portfolio's traffic-light thresholds (D11) and leaving or deleting the
	// team, out of the page's reading path in a side sheet. Every member opens
	// it: they read the thresholds and can leave; only admins rename, change the
	// thresholds or delete. Leaving and deleting are the page's (they need its
	// members and navigate away), so they come in as callbacks.
	import { untrack } from 'svelte';
	import { base } from '$app/paths';
	import { api, type Team } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { thresholdsError, thresholdsRule, thresholdsSource } from '$lib/components/portfolio/portfolio';

	let {
		open = $bindable(false),
		team = $bindable(),
		error = null,
		canLeave,
		leaving = false,
		onleave,
		ondelete
	}: {
		open?: boolean;
		team: Team;
		/** An error from leaving (the only admin, a failed request), shown at the sheet's top. */
		error?: string | null;
		/** You're a member (always, unless the list is still loading). */
		canLeave: boolean;
		leaving?: boolean;
		onleave: () => void;
		ondelete: () => void;
	} = $props();

	const isAdmin = $derived(team.role === 'admin');
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let newName = $state('');
	let renaming = $state(false);
	let renamed = $state(false);
	let renameError = $state<string | null>(null);

	// The cut-offs in percent.
	let green = $state(5);
	let amber = $state(20);
	let savingThresholds = $state(false);
	let thresholdsSaved = $state<string | null>(null);
	let thresholdsFailed = $state<string | null>(null);
	const thresholdsInvalid = $derived(thresholdsError(green, amber));
	const thresholdsUnchanged = $derived(team.portfolioThresholds.green === green && team.portfolioThresholds.amber === amber);

	// Each opening starts from the saved values, with no stale message (a save
	// updates `team`, which must not reset the form it came from: untracked).
	$effect(() => {
		if (!open) return;
		untrack(() => {
			newName = team.name;
			renamed = false;
			renameError = null;
			green = team.portfolioThresholds.green;
			amber = team.portfolioThresholds.amber;
			thresholdsSaved = null;
			thresholdsFailed = null;
		});
	});

	async function rename(e: SubmitEvent) {
		e.preventDefault();
		renaming = true;
		renameError = null;
		try {
			team = await api.teams.rename(team.id, newName.trim());
			newName = team.name;
			renamed = true;
		} catch (err) {
			renameError = msg(err);
		} finally {
			renaming = false;
		}
	}

	async function saveThresholds(next: { green: number; amber: number } | null) {
		savingThresholds = true;
		thresholdsFailed = null;
		thresholdsSaved = null;
		try {
			team = await api.teams.setThresholds(team.id, next);
			green = team.portfolioThresholds.green;
			amber = team.portfolioThresholds.amber;
			thresholdsSaved = next ? 'Saved. The portfolio now uses these thresholds.' : 'Saved. The portfolio uses the default thresholds again.';
		} catch (err) {
			thresholdsFailed = msg(err);
		} finally {
			savingThresholds = false;
		}
	}

	function submitThresholds(e: SubmitEvent) {
		e.preventDefault();
		if (!thresholdsInvalid) void saveThresholds({ green, amber });
	}
</script>

<Dialog bind:open title="Team settings" side>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

	{#if isAdmin}
		<section class="part" aria-labelledby="ts-h">
			<h3 id="ts-h">Team name</h3>
			<form onsubmit={rename}>
				{#if renameError}<div class="alert alert-error" role="alert">{renameError}</div>{/if}
				<div class="field">
					<label class="visually-hidden" for="tm-name">Team name</label>
					<input id="tm-name" required maxlength="200" bind:value={newName} oninput={() => (renamed = false)} />
				</div>
				<div class="row">
					<button class="btn" type="submit" disabled={renaming || !newName.trim() || newName.trim() === team.name}>
						{renaming ? 'Saving…' : 'Rename'}
					</button>
					<span class="muted small" role="status">{renamed ? 'Saved.' : ''}</span>
				</div>
			</form>
		</section>
	{/if}

	<section class="part" aria-labelledby="pt-h">
		<h3 id="pt-h">Portfolio traffic lights</h3>
		<p class="small rule">
			A catchment's EWR status on the <a href="{base}/teams/{team.id}/portfolio">portfolio</a> counts the days in the last 30 its outlet
			EWR was not met: {thresholdsRule(team.portfolioThresholds)}.
		</p>
		<p class="muted small">{thresholdsSource(team.portfolioThresholds)}</p>
		{#if isAdmin}
			<form onsubmit={submitThresholds} novalidate>
				{#if thresholdsFailed}<div class="alert alert-error" role="alert">{thresholdsFailed}</div>{/if}
				<div class="pair">
					<div class="field">
						<label for="pt-green">Green below (%)</label>
						<input
							id="pt-green"
							type="number"
							min="0"
							max="100"
							step="any"
							inputmode="decimal"
							required
							aria-describedby={thresholdsInvalid ? 'pt-error' : undefined}
							aria-invalid={thresholdsInvalid ? 'true' : undefined}
							bind:value={green}
							oninput={() => (thresholdsSaved = null)}
						/>
					</div>
					<div class="field">
						<label for="pt-amber">Amber below (%)</label>
						<input
							id="pt-amber"
							type="number"
							min="0"
							max="100"
							step="any"
							inputmode="decimal"
							required
							aria-describedby={thresholdsInvalid ? 'pt-error' : undefined}
							aria-invalid={thresholdsInvalid ? 'true' : undefined}
							bind:value={amber}
							oninput={() => (thresholdsSaved = null)}
						/>
					</div>
				</div>
				{#if thresholdsInvalid}<p id="pt-error" class="field-error small" role="alert">{thresholdsInvalid}</p>{/if}
				<div class="row">
					<button class="btn" type="submit" disabled={savingThresholds || !!thresholdsInvalid || thresholdsUnchanged}>
						{savingThresholds ? 'Saving…' : 'Save thresholds'}
					</button>
					{#if team.portfolioThresholds.source === 'team'}
						<button type="button" class="btn btn-sm" disabled={savingThresholds} onclick={() => saveThresholds(null)}>Use the defaults</button>
					{/if}
				</div>
				<p class="muted small saved" role="status">{thresholdsSaved ?? ''}</p>
			</form>
		{:else}
			<p class="muted small">Only owners can change them.</p>
		{/if}
	</section>

	<section class="part danger" aria-labelledby="dz-h">
		<h3 id="dz-h">Leave or delete</h3>
		{#if canLeave}
			<div class="dz-row">
				<p class="small">Leave the team. You keep projects that are also shared with you directly.</p>
				<button type="button" class="btn btn-danger" disabled={leaving} onclick={onleave}>Leave team</button>
			</div>
		{/if}
		{#if isAdmin}
			<div class="dz-row">
				<p class="small">
					Delete the team. Its projects are <strong>not</strong> deleted: they stay with the people they're shared with directly.
				</p>
				<button type="button" class="btn btn-danger" onclick={ondelete}>Delete team</button>
			</div>
		{/if}
	</section>

	{#snippet actions()}
		<button type="button" class="btn btn-primary" onclick={() => (open = false)}>Done</button>
	{/snippet}
</Dialog>

<style>
	.part {
		padding: 1rem 0;
		border-top: 1px solid var(--border);
	}
	.part:first-of-type {
		border-top: none;
		padding-top: 0.25rem;
	}
	.part h3 {
		margin: 0 0 0.6rem;
		font-size: 0.95rem;
	}
	.rule {
		margin: 0 0 0.35rem;
	}
	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
		margin-top: 0.75rem;
	}
	.pair .field {
		margin-bottom: 0;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.saved {
		margin: 0.4rem 0 0;
	}
	.saved:empty {
		margin: 0;
	}
	.field-error {
		margin: 0.25rem 0 0;
		color: var(--danger);
	}
	.danger h3 {
		color: var(--danger);
	}
	.dz-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.dz-row + .dz-row {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	.dz-row p {
		margin: 0;
		color: var(--text-2);
	}
	.dz-row .btn {
		flex: none;
	}
	@media (max-width: 560px) {
		.dz-row {
			flex-direction: column;
			align-items: stretch;
		}
		.dz-row .btn {
			justify-content: center;
		}
	}
</style>
