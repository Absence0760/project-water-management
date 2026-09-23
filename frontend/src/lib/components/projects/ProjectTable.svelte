<script lang="ts">
	// One group of projects as a table. On phones the Team / Data / Last run /
	// Updated columns fold into a meta line under the name so nothing scrolls
	// sideways. Data freshness (dataUntil) is a badge: stale or missing data is
	// flagged, and editors get an "Add data" shortcut into the upload dialog.
	import { base } from '$app/paths';
	import { hasRole, type ProjectSummary } from '$lib/api';
	import { fmtDate } from '$lib/format/number';
	import { dataFreshness } from './freshness';

	let {
		projects,
		caption,
		showTeam = true,
		oncopy,
		ondelete
	}: {
		projects: ProjectSummary[];
		/** Accessible table name (the group heading's text). */
		caption: string;
		showTeam?: boolean;
		oncopy: (p: ProjectSummary) => void;
		ondelete: (p: ProjectSummary) => void;
	} = $props();

	// Owner as you see it: a team, someone's team you were shared into, your
	// own personal project, or someone else's shared with you directly.
	const teamLabel = (p: ProjectSummary) =>
		p.team ? (p.team.name ?? 'Another team') : p.role === 'owner' ? 'Personal' : 'Shared directly';

	// Opens the workspace with the upload dialog (the workspace reads ?add=data).
	const addDataHref = (p: ProjectSummary) => `${base}/projects/${p.id}?add=data`;
	const now = new Date();
</script>

{#snippet lastRun(p: ProjectSummary)}
	{#if p.lastRunAt}
		<span class="run" title="Newest run: {fmtDate(p.lastRunAt, true)}">last run {fmtDate(p.lastRunAt)}</span>
	{:else}
		<span class="run">not run yet</span>
	{/if}
{/snippet}

{#snippet fresh(p: ProjectSummary)}
	{@const f = dataFreshness(p.dataUntil, now)}
	<span class="badge fresh" class:badge-warn={f.stale} title={f.detail}>{f.label}</span>
{/snippet}

<div class="table-wrap">
	<table class="data projects">
		<caption class="visually-hidden">{caption}</caption>
		<thead>
			<tr>
				<th scope="col">Catchment</th>
				{#if showTeam}<th scope="col" class="wide xwide c-team">Team</th>{/if}
				<th scope="col" class="wide c-role">Your role</th>
				<th scope="col" class="wide c-data">Data and runs</th>
				<th scope="col" class="wide xwide num c-upd">Updated</th>
				<th scope="col" class="c-act"><span class="visually-hidden">Actions</span></th>
			</tr>
		</thead>
		<tbody>
			{#each projects as p (p.id)}
				<tr>
					<!-- Named by the project name alone, not the description under it. -->
					<th scope="row" aria-label={p.name}>
						<a class="name" href="{base}/projects/{p.id}">{p.name}</a>
						{#if showTeam}<span class="team-sub">{teamLabel(p)}</span>{/if}
						{#if p.description}<span class="desc">{p.description}</span>{/if}
						<span class="meta">
							<span class="meta-line">
								{#if showTeam}{teamLabel(p)} ·{/if}
								<span class="role">{p.role}</span> · updated {fmtDate(p.updatedAt)}
							</span>
							<span class="meta-line">
								{@render fresh(p)}
								{@render lastRun(p)}
							</span>
						</span>
					</th>
					{#if showTeam}<td class="wide xwide">
						{#if p.team}
							{#if p.team.name}
								<a class="team" href="{base}/teams/{p.team.id}">{p.team.name}</a>
							{:else}
								<span class="muted" title="You have access through direct sharing">Another team</span>
							{/if}
						{:else}
							<span class="muted">{teamLabel(p)}</span>
						{/if}
					</td>{/if}
					<td class="wide"><span class="badge" class:badge-owner={p.role === 'owner'}>{p.role}</span></td>
					<td class="wide status">
						{@render fresh(p)}
						{@render lastRun(p)}
					</td>
					<td class="wide xwide num" title={fmtDate(p.updatedAt, true)}>{fmtDate(p.updatedAt)}</td>
					<td class="actions"><div class="act">
						<a class="btn btn-sm open" href="{base}/projects/{p.id}">Open</a>
						{#if hasRole(p.role, 'editor')}
							<a class="btn btn-sm" href={addDataHref(p)} aria-label="Add data to {p.name}">Add data</a>
						{/if}
						<button type="button" class="btn btn-sm" onclick={() => oncopy(p)} aria-label="Copy {p.name}">Copy</button>
						{#if hasRole(p.role, 'owner')}
							<button type="button" class="btn btn-sm btn-danger" onclick={() => ondelete(p)} aria-label="Delete {p.name}">
								Delete
							</button>
						{/if}
					</div></td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	/* Fixed right-hand columns so tables in consecutive groups line up. */
	.projects {
		table-layout: fixed;
	}
	.c-team {
		width: 200px;
	}
	.c-role {
		width: 100px;
	}
	.c-data {
		width: 165px;
	}
	.c-upd {
		width: 105px;
	}
	.c-act {
		width: 250px;
	}
	.status {
		white-space: nowrap;
	}
	.run {
		display: block;
		margin-top: 0.2rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.meta .run {
		display: inline;
		margin: 0;
	}
	.team-sub {
		display: none;
		font-weight: 400;
		font-size: 0.83rem;
		color: var(--text-2);
	}
	.fresh {
		text-transform: none;
		font-weight: 500;
		white-space: nowrap;
	}
	.projects tbody th {
		padding-top: 0.6rem;
		padding-bottom: 0.6rem;
	}
	.projects td {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.name {
		font-weight: 600;
		font-size: 0.95rem;
	}
	.desc {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		margin-top: 0.15rem;
		max-width: 72ch;
		color: var(--text-2);
		font-weight: 400;
		font-size: 0.83rem;
	}
	.meta {
		display: none;
		margin-top: 0.2rem;
		color: var(--text-muted);
		font-weight: 400;
		font-size: 0.8rem;
	}
	.meta-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.45rem;
	}
	.meta-line + .meta-line {
		margin-top: 0.3rem;
	}
	.role {
		text-transform: capitalize;
	}
	.team {
		color: var(--text-2);
	}
	.team:hover {
		color: var(--accent);
	}
	.actions {
		text-align: right;
		white-space: nowrap;
		width: 1%;
	}
	.act {
		display: flex;
		justify-content: flex-end;
		gap: 0.25rem;
	}
	/* Updated, Team and Open go first when space runs short (the sort still
	   uses Updated; the team moves under the name; the name opens the project). */
	@media (max-width: 1200px) {
		.xwide,
		.open {
			display: none;
		}
		.team-sub {
			display: block;
		}
		.c-act {
			width: 190px;
		}
	}
	@media (max-width: 760px) {
		.wide,
		.open {
			display: none;
		}
		.meta {
			display: block;
		}
		/* The meta line carries the team on phones. */
		.team-sub {
			display: none;
		}
		/* Keep the fixed layout: the name column takes what the buttons leave. */
		.c-act {
			width: 6.5rem;
		}
		.actions {
			vertical-align: top;
			padding-top: 0.6rem;
		}
		.act {
			flex-direction: column;
			align-items: stretch;
			gap: 0.35rem;
		}
		.act .btn {
			justify-content: center;
		}
	}
</style>
