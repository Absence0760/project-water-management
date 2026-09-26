<script lang="ts">
	// Farmers on the project (WP-2.1): members who see only the farms linked
	// to them. Owners add existing accounts and choose their farms; a farmer is
	// removed like any member (their links go with the membership).
	import { onMount } from 'svelte';
	import { api, type Farmer } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import EmailText from '$lib/components/common/EmailText.svelte';
	import { farmNames, toggleFarm, type FarmOption } from './farmers';

	let {
		projectId,
		isOwner,
		farms
	}: {
		projectId: string;
		isOwner: boolean;
		/** The project's farm nodes (from the model), in network-table order. */
		farms: FarmOption[];
	} = $props();

	let farmers = $state<Farmer[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);

	let email = $state('');
	let picked = $state<string[]>([]);
	let adding = $state(false);
	let added = $state<string | null>(null);

	/** The farmer whose farms are being edited, and the draft selection. */
	let editing = $state<string | null>(null);
	let draft = $state<string[]>([]);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function load() {
		loading = true;
		loadError = null;
		try {
			farmers = await api.farmers.list(projectId);
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function add(e: SubmitEvent) {
		e.preventDefault();
		adding = true;
		error = null;
		added = null;
		try {
			const f = await api.farmers.add(projectId, email.trim(), picked);
			farmers = [...farmers.filter((x) => x.userId !== f.userId), f];
			added = `${f.displayName} added as a farmer on ${farmNames(f, farms).join(', ')}.`;
			email = '';
			picked = [];
		} catch (err) {
			error = msg(err);
		} finally {
			adding = false;
		}
	}

	function edit(f: Farmer) {
		editing = f.userId;
		draft = farms.filter((x) => f.nodeIds.includes(x.id)).map((x) => x.id);
	}

	async function save(f: Farmer) {
		busy = f.userId;
		error = null;
		try {
			const updated = await api.farmers.setFarms(projectId, f.userId, draft);
			farmers = farmers.map((x) => (x.userId === f.userId ? updated : x));
			editing = null;
		} catch (err) {
			error = msg(err);
		} finally {
			busy = null;
		}
	}

	async function remove(f: Farmer) {
		if (!confirm(`Remove ${f.displayName} (${f.email}) as a farmer? They lose access to ${farmNames(f, farms).join(', ') || 'their farms'}.`)) return;
		busy = f.userId;
		error = null;
		try {
			await api.members.remove(projectId, f.userId);
			farmers = farmers.filter((x) => x.userId !== f.userId);
		} catch (err) {
			error = msg(err);
		} finally {
			busy = null;
		}
	}
</script>

<section class="panel" aria-labelledby="farmers-h">
	<div class="panel-head">
		<h2 id="farmers-h">Farmers{#if !loading && !loadError}&nbsp;({farmers.length}){/if}</h2>
	</div>
	<p class="muted small intro">
		A farmer sees only the farms linked to them, never another farm’s name or figures, and none of the model. The farmer
		view itself is still to come (roadmap WP-2.6).
	</p>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<LoadState {loading} error={loadError} retry={load} empty={farmers.length === 0} emptyText="No farmers yet.">
		<div class="table-wrap">
			<table class="data">
				<thead>
					<tr>
						<th scope="col">Name</th>
						<th scope="col">Farms</th>
						<th scope="col"><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each farmers as f (f.userId)}
						<tr>
							<th scope="row">
								{f.displayName}
								<span class="sub-email"><EmailText email={f.email} /></span>
							</th>
							<td>
								{#if editing === f.userId}
									<fieldset class="farms">
										<legend class="visually-hidden">Farms for {f.displayName}</legend>
										{#each farms as farm (farm.id)}
											<label class="check">
												<input
													type="checkbox"
													checked={draft.includes(farm.id)}
													onchange={() => (draft = toggleFarm(draft, farm.id, farms))}
												/>
												{farm.name}
											</label>
										{/each}
									</fieldset>
								{:else}
									{farmNames(f, farms).join(', ') || '–'}
								{/if}
							</td>
							<td class="act">
								{#if isOwner}
									{#if editing === f.userId}
										<button type="button" class="btn btn-sm btn-primary" disabled={busy === f.userId || draft.length === 0} onclick={() => save(f)}>Save</button>
										<button type="button" class="btn btn-sm" disabled={busy === f.userId} onclick={() => (editing = null)}>Cancel</button>
									{:else}
										<button type="button" class="btn btn-sm" disabled={busy === f.userId} onclick={() => edit(f)}>Change farms</button>
										<button type="button" class="btn btn-sm btn-danger" disabled={busy === f.userId} onclick={() => remove(f)}>Remove</button>
									{/if}
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</LoadState>

	{#if isOwner}
		{#if farms.length === 0}
			<p class="muted small add-hint">Add a farm on the Network tab before linking a farmer to it.</p>
		{:else}
			<form class="add" onsubmit={add}>
				<div class="field">
					<label for="farmer-email">Add a farmer by email</label>
					<input id="farmer-email" type="email" required placeholder="farmer@example.com" bind:value={email} />
				</div>
				<fieldset class="farms">
					<legend>Their farms</legend>
					{#each farms as farm (farm.id)}
						<label class="check">
							<input type="checkbox" checked={picked.includes(farm.id)} onchange={() => (picked = toggleFarm(picked, farm.id, farms))} />
							{farm.name}
						</label>
					{/each}
				</fieldset>
				<div>
					<button class="btn btn-primary" type="submit" disabled={adding || !email.trim() || picked.length === 0}>
						{adding ? 'Adding…' : 'Add farmer'}
					</button>
				</div>
			</form>
			<p class="added" role="status" aria-live="polite">{added ?? ''}</p>
			<p class="muted small add-hint">The farmer needs an account with a confirmed email address. Invitations for farmers come later (WP-2.2).</p>
		{/if}
	{/if}
</section>

<style>
	.small {
		font-size: 0.8rem;
	}
	.intro {
		margin: -0.25rem 0 0.75rem;
	}
	.add {
		margin-top: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.add .field {
		margin-bottom: 0;
		max-width: 28rem;
	}
	.farms {
		border: 0;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
	}
	.add .farms legend {
		font-size: 0.85rem;
		color: var(--text-2);
		margin-bottom: 0.25rem;
		padding: 0;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 24px;
	}
	.act {
		text-align: right;
		white-space: nowrap;
	}
	.act .btn + .btn {
		margin-left: 0.35rem;
	}
	.sub-email {
		display: block;
		font-weight: 400;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.added {
		margin: 0.5rem 0 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.added:empty {
		margin: 0;
	}
	.add-hint {
		margin: 0.5rem 0 0;
	}
</style>
