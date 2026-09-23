<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { api, hasRole, type ProjectSummary } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fmtDate } from '$lib/format/number';

	let projects = $state<ProjectSummary[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	let createOpen = $state(false);
	let newName = $state('');
	let newDescription = $state('');
	let creating = $state(false);

	let copyOpen = $state(false);
	let copySource = $state<ProjectSummary | null>(null);
	let copyName = $state('');
	let copying = $state(false);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function load() {
		loading = true;
		loadError = null;
		try {
			projects = await api.projects.list();
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	function openCreate() {
		newName = '';
		newDescription = '';
		actionError = null;
		createOpen = true;
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		creating = true;
		actionError = null;
		try {
			const p = await api.projects.create(newName.trim(), newDescription.trim() || undefined);
			createOpen = false;
			await goto(`${base}/projects/${p.id}`);
		} catch (err) {
			actionError = msg(err);
		} finally {
			creating = false;
		}
	}

	function openCopy(p: ProjectSummary) {
		copySource = p;
		copyName = `${p.name} (copy)`;
		actionError = null;
		copyOpen = true;
	}

	async function copy(e: SubmitEvent) {
		e.preventDefault();
		if (!copySource) return;
		copying = true;
		actionError = null;
		try {
			await api.projects.copy(copySource.id, copyName.trim());
			copyOpen = false;
			await load();
		} catch (err) {
			actionError = msg(err);
		} finally {
			copying = false;
		}
	}

	async function remove(p: ProjectSummary) {
		if (!confirm(`Delete project "${p.name}"? Its model, time series and runs are removed permanently.`)) return;
		actionError = null;
		try {
			await api.projects.remove(p.id);
			projects = projects.filter((x) => x.id !== p.id);
		} catch (err) {
			actionError = msg(err);
		}
	}
</script>

<svelte:head><title>Projects · Water Management</title></svelte:head>

<main class="page">
	<div class="toolbar">
		<h1>Projects</h1>
		<div class="spacer"></div>
		<button type="button" class="btn btn-primary" onclick={openCreate}>New project</button>
	</div>

	{#if actionError && !createOpen && !copyOpen}
		<div class="alert alert-error" role="alert">{actionError}</div>
	{/if}

	<LoadState
		{loading}
		error={loadError}
		retry={load}
		empty={projects.length === 0}
		emptyText="You have no projects yet. Create one to start modelling a catchment."
	>
		<div class="table-wrap">
			<table class="data">
				<thead>
					<tr>
						<th scope="col">Name</th>
						<th scope="col">Description</th>
						<th scope="col">Your role</th>
						<th scope="col">Updated</th>
						<th scope="col"><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each projects as p (p.id)}
						<tr>
							<th scope="row"><a href="{base}/projects/{p.id}">{p.name}</a></th>
							<td class="desc">{p.description || ''}</td>
							<td><span class="badge" class:badge-owner={p.role === 'owner'}>{p.role}</span></td>
							<td class="num">{fmtDate(p.updatedAt, true)}</td>
							<td class="actions">
								<a class="btn btn-sm" href="{base}/projects/{p.id}">Open</a>
								<button type="button" class="btn btn-sm" onclick={() => openCopy(p)} aria-label="Copy {p.name}">Copy</button>
								{#if hasRole(p.role, 'owner')}
									<button type="button" class="btn btn-sm btn-danger" onclick={() => remove(p)} aria-label="Delete {p.name}">
										Delete
									</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#snippet emptyAction()}
			<button type="button" class="btn btn-primary" onclick={openCreate}>New project</button>
		{/snippet}
	</LoadState>
</main>

<Dialog bind:open={createOpen} title="New project">
	<form id="create-form" onsubmit={create}>
		{#if actionError}<div class="alert alert-error" role="alert">{actionError}</div>{/if}
		<div class="field">
			<label for="np-name">Name</label>
			<input id="np-name" required maxlength="200" bind:value={newName} />
		</div>
		<div class="field">
			<label for="np-desc">Description <span class="muted">(optional)</span></label>
			<textarea id="np-desc" rows="3" bind:value={newDescription}></textarea>
		</div>
	</form>
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (createOpen = false)}>Cancel</button>
		<button type="submit" form="create-form" class="btn btn-primary" disabled={creating || !newName.trim()}>
			{creating ? 'Creating…' : 'Create'}
		</button>
	{/snippet}
</Dialog>

<Dialog bind:open={copyOpen} title="Copy project">
	<form id="copy-form" onsubmit={copy}>
		{#if actionError}<div class="alert alert-error" role="alert">{actionError}</div>{/if}
		<p class="muted">The model and time series are copied; model runs are not.</p>
		<div class="field">
			<label for="cp-name">Name of the copy</label>
			<input id="cp-name" required maxlength="200" bind:value={copyName} />
		</div>
	</form>
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (copyOpen = false)}>Cancel</button>
		<button type="submit" form="copy-form" class="btn btn-primary" disabled={copying || !copyName.trim()}>
			{copying ? 'Copying…' : 'Copy'}
		</button>
	{/snippet}
</Dialog>

<style>
	h1 {
		margin: 0;
	}
	.desc {
		color: var(--text-2);
		max-width: 480px;
	}
	.actions {
		text-align: right;
		white-space: nowrap;
	}
	.actions .btn + .btn {
		margin-left: 0.25rem;
	}
</style>
