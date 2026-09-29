<script lang="ts">
	// Which team (if any) owns the project, and — for owners — moving it into
	// one of your teams or back to personal.
	import { onMount, untrack } from 'svelte';
	import { base } from '$app/paths';
	import { api, hasTeamRole, type Member, type Project, type Team } from '$lib/api';
	import { cached } from './cache';

	let {
		project,
		isOwner,
		currentUserId,
		onProjectChange
	}: {
		project: Project;
		isOwner: boolean;
		currentUserId: string;
		onProjectChange: (p: Project) => void;
	} = $props();

	// Last-seen teams/members first so the panel doesn't change shape on revisit.
	const memo = untrack(() => cached(project.id));
	let teams = $state<Team[] | null>(memo.teams ?? null);
	let direct = $state<Member[] | null>(memo.members ?? null);
	let target = $state(untrack(() => project.team?.id ?? ''));
	let moving = $state(false);
	let error = $state<string | null>(null);

	onMount(async () => {
		if (!isOwner) return;
		const [t, m] = await Promise.allSettled([api.teams.list(), api.members.list(project.id)]);
		teams = memo.teams = t.status === 'fulfilled' ? t.value : [];
		if (m.status === 'fulfilled') direct = m.value;
	});

	// Owners through a team admin role alone would lose the project if it left
	// the team: the API can't move it to personal for them.
	const directOwner = $derived(direct?.some((m) => m.userId === currentUserId && m.role === 'owner') ?? true);
	const current = $derived(project.team?.id ?? '');
	// Only teams you may add projects to (member or admin); a team viewer can't.
	const movable = $derived(teams?.filter((t) => hasTeamRole(t.role, 'member')) ?? null);
	const targetName = $derived(target ? (teams?.find((t) => t.id === target)?.name ?? 'the team') : 'Personal');

	async function move(e: SubmitEvent) {
		e.preventDefault();
		if (target === current) return;
		const leaving = project.team
			? ` Members of ${project.team.name ?? 'the current team'} who aren't shared on it directly lose access.`
			: '';
		if (!confirm(`Move "${project.name}" to ${targetName}?${leaving}`)) return;
		moving = true;
		error = null;
		try {
			onProjectChange(await api.projects.update(project.id, { teamId: target || null }));
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			moving = false;
		}
	}
</script>

<section class="panel" aria-labelledby="team-h">
	<div class="panel-head"><h2 id="team-h">Team</h2></div>
	{#if project.team}
		<p class="owner-line">
			{#if project.team.name}
				Belongs to <a href="{base}/teams/{project.team.id}"><strong>{project.team.name}</strong></a>.
			{:else}
				Belongs to a team you're not in. You have access because it was shared with you directly.
			{/if}
		</p>
		<p class="muted small">Everyone in the team has the role they hold in the team on this project too, as does anyone listed under Members.</p>
	{:else}
		<p class="owner-line"><strong>Personal project.</strong> Only the people listed under Members can open it.</p>
	{/if}

	{#if isOwner}
		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
		<form class="form-row move" onsubmit={move}>
			<div class="field grow">
				<label for="move-team">Move to</label>
				<select id="move-team" bind:value={target} disabled={moving}>
					<option value="" disabled={!!project.team && !directOwner}>Personal</option>
					{#if project.team && !movable?.some((t) => t.id === project.team?.id)}
						<option value={project.team.id}>{project.team.name ?? 'Current team'}</option>
					{/if}
					{#each movable ?? [] as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
				</select>
			</div>
			<div class="field">
				<button class="btn" type="submit" disabled={moving || target === current}>{moving ? 'Moving…' : 'Move'}</button>
			</div>
		</form>
		{#if project.team && !directOwner}
			<p class="muted small">
				You're an owner through the team, so you can't make it personal: add yourself under Members as an owner first.
			</p>
		{:else if movable && !movable.length}
			<p class="muted small"><a href="{base}/teams">Create a team</a> to share this catchment with colleagues in one step.</p>
		{/if}
	{/if}
</section>

<style>
	.owner-line {
		margin-bottom: 0.4rem;
	}
	.move {
		margin-top: 0.75rem;
	}
	.move .field {
		margin-bottom: 0;
	}
	.grow {
		flex: 1;
		min-width: 180px;
	}
	.grow select {
		width: 100%;
	}
	p.small {
		margin: 0.5rem 0 0;
	}
	p.small a {
		text-decoration: underline;
	}
</style>
