<script lang="ts">
	import { onMount } from 'svelte';
	import { api, ROLES, type Member, type Role } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';

	let {
		projectId,
		isOwner,
		currentUserId,
		onLeftProject
	}: { projectId: string; isOwner: boolean; currentUserId: string; onLeftProject: () => void } = $props();

	let members = $state<Member[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);

	let email = $state('');
	let role = $state<Role>('viewer');
	let adding = $state(false);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function load() {
		loading = true;
		loadError = null;
		try {
			members = await api.members.list(projectId);
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
		try {
			const m = await api.members.add(projectId, email.trim(), role);
			members = [...members.filter((x) => x.userId !== m.userId), m];
			email = '';
		} catch (err) {
			error = msg(err);
		} finally {
			adding = false;
		}
	}

	async function setRole(m: Member, next: Role) {
		busy = m.userId;
		error = null;
		try {
			const updated = await api.members.setRole(projectId, m.userId, next);
			members = members.map((x) => (x.userId === m.userId ? updated : x));
		} catch (err) {
			error = msg(err);
			await load(); // restore the select to the server's value
		} finally {
			busy = null;
		}
	}

	async function remove(m: Member) {
		const self = m.userId === currentUserId;
		const q = self
			? 'Leave this project? You will lose access unless someone adds you again.'
			: `Remove ${m.displayName} (${m.email}) from this project?`;
		if (!confirm(q)) return;
		busy = m.userId;
		error = null;
		try {
			await api.members.remove(projectId, m.userId);
			if (self) return onLeftProject();
			members = members.filter((x) => x.userId !== m.userId);
		} catch (err) {
			error = msg(err);
		} finally {
			busy = null;
		}
	}
</script>

<section class="panel" aria-labelledby="members-h">
	<div class="panel-head">
		<h2 id="members-h">Members</h2>
		{#if !isOwner}<span class="muted small">Only owners can manage members.</span>{/if}
	</div>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<LoadState {loading} error={loadError} retry={load} empty={members.length === 0} emptyText="No members.">
		<div class="table-wrap">
			<table class="data">
				<thead>
					<tr>
						<th scope="col">Name</th>
						<th scope="col">Email</th>
						<th scope="col">Role</th>
						<th scope="col"><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each members as m (m.userId)}
						<tr>
							<th scope="row">{m.displayName}{#if m.userId === currentUserId} <span class="muted">(you)</span>{/if}</th>
							<td>{m.email}</td>
							<td>
								{#if isOwner}
									<select
										aria-label="Role for {m.displayName}"
										value={m.role}
										disabled={busy === m.userId}
										onchange={(e) => setRole(m, e.currentTarget.value as Role)}
									>
										{#each ROLES as r (r)}<option value={r}>{r}</option>{/each}
									</select>
								{:else}
									<span class="badge" class:badge-owner={m.role === 'owner'}>{m.role}</span>
								{/if}
							</td>
							<td class="act">
								{#if isOwner || m.userId === currentUserId}
									<button
										type="button"
										class="btn btn-sm btn-danger"
										disabled={busy === m.userId}
										onclick={() => remove(m)}
									>
										{m.userId === currentUserId ? 'Leave' : 'Remove'}
									</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</LoadState>

	{#if isOwner}
		<form class="add form-row" onsubmit={add}>
			<div class="field grow">
				<label for="mem-email">Add member by email</label>
				<input id="mem-email" type="email" required placeholder="colleague@example.com" bind:value={email} />
			</div>
			<div class="field">
				<label for="mem-role">Role</label>
				<select id="mem-role" bind:value={role}>
					{#each ROLES as r (r)}<option value={r}>{r}</option>{/each}
				</select>
			</div>
			<div class="field">
				<button class="btn btn-primary" type="submit" disabled={adding || !email.trim()}>{adding ? 'Adding…' : 'Add'}</button>
			</div>
		</form>
		<p class="muted small">The person must already have an account. Viewers can read; editors can change the model and run it; owners also manage members.</p>
	{/if}
</section>

<style>
	.small {
		font-size: 0.8rem;
	}
	.add {
		margin-top: 1rem;
	}
	.grow {
		flex: 1;
		min-width: 200px;
	}
	.add .field {
		margin-bottom: 0;
	}
	.act {
		text-align: right;
	}
	select {
		text-transform: capitalize;
	}
</style>
