<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { api, type Team } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fmtDate } from '$lib/format/number';

	let teams = $state<Team[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	let createOpen = $state(false);
	let name = $state('');
	let creating = $state(false);
	let createError = $state<string | null>(null);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function load() {
		loading = true;
		loadError = null;
		try {
			teams = await api.teams.list();
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	function openCreate() {
		name = '';
		createError = null;
		createOpen = true;
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		creating = true;
		createError = null;
		try {
			const t = await api.teams.create(name.trim());
			createOpen = false;
			await goto(`${base}/teams/${t.id}`);
		} catch (err) {
			createError = msg(err);
		} finally {
			creating = false;
		}
	}
</script>

<svelte:head><title>Teams · Water Management</title></svelte:head>

<main class="page">
	<div class="page-head">
		<div>
			<h1>Teams</h1>
			<p class="muted sub">
				A team owns catchments together. Members edit the team's projects, viewers only read them, and admins are owners and
				manage the team.
			</p>
		</div>
		<button type="button" class="btn btn-primary" onclick={openCreate}>New team</button>
	</div>

	<LoadState {loading} error={loadError} retry={load} empty={teams.length === 0} emptyText="You're not in any team yet.">
		<ul class="teams">
			{#each teams as t (t.id)}
				<li>
					<a class="card" href="{base}/teams/{t.id}">
						<span class="top">
							<span class="name">{t.name}</span>
							<span class="badge" class:badge-owner={t.role === 'admin'}>{t.role}</span>
						</span>
						<span class="facts">
							<span><strong>{t.projectCount}</strong> project{t.projectCount === 1 ? '' : 's'}</span>
							<span><strong>{t.memberCount}</strong> member{t.memberCount === 1 ? '' : 's'}</span>
							<span class="muted">since {fmtDate(t.createdAt)}</span>
						</span>
					</a>
				</li>
			{/each}
		</ul>
		{#snippet emptyAction()}
			<p class="muted help">
				Create one for your consultancy or department, then add colleagues by the email they registered
				with. Anyone can still share a single project directly from its Overview tab.
			</p>
			<button type="button" class="btn btn-primary" onclick={openCreate}>New team</button>
		{/snippet}
	</LoadState>
</main>

<Dialog bind:open={createOpen} title="New team">
	<form id="team-form" onsubmit={create}>
		{#if createError}<div class="alert alert-error" role="alert">{createError}</div>{/if}
		<div class="field">
			<label for="team-name">Team name</label>
			<input id="team-name" required maxlength="200" placeholder="e.g. Breede Hydrology Consultants" bind:value={name} />
			<span class="hint">You'll be its admin. Add members on the next page.</span>
		</div>
	</form>
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (createOpen = false)}>Cancel</button>
		<button type="submit" form="team-form" class="btn btn-primary" disabled={creating || !name.trim()}>
			{creating ? 'Creating…' : 'Create team'}
		</button>
	{/snippet}
</Dialog>

<style>
	.page-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.25rem;
	}
	.page-head h1 {
		margin: 0 0 0.2rem;
	}
	.sub {
		margin: 0;
		max-width: 65ch;
	}
	.teams {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 0.75rem;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 1rem 1.1rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		color: var(--text);
		height: 100%;
	}
	.card:hover {
		text-decoration: none;
		border-color: var(--accent);
	}
	.top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.name {
		font-weight: 600;
		font-size: 1rem;
		color: var(--accent);
	}
	.card:hover .name {
		text-decoration: underline;
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 1rem;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.help {
		max-width: 55ch;
	}
	@media (max-width: 560px) {
		.page-head {
			flex-direction: column;
			align-items: stretch;
		}
		.page-head .btn {
			justify-content: center;
		}
	}
</style>
