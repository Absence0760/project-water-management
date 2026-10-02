<script lang="ts">
	// The public-participation record of one application, for the applicant's
	// report to the authority (GN R267 reg 19; 166_public_participation;
	// licensing positions item 7, provisional position, pre-counsel research,
	// 2026-10-01; docs/ui.md § Applications → Public participation):
	// /projects/:id/scenarios/:sid/participation. For the application's owner
	// (the regulations put the register and the report on the applicant) and
	// the editors. Laid out under the headings of GN R267 Annexure D item 8
	// that the app holds material for, to print or save as a PDF; the same
	// comments as a CSV, one row per text. A commenter's email is here only
	// where they ticked the reg 18 box. Part of the workspace, so English.
	import { untrack } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError, type ParticipationExport } from '$lib/api';
	import { fmtDate } from '$lib/format/number';

	const projectId = $derived(page.params.id ?? '');
	const scenarioId = $derived(page.params.sid ?? '');
	const back = $derived(`${base}/projects/${encodeURIComponent(projectId)}?tab=scenarios&scenario=${encodeURIComponent(scenarioId)}`);

	let record = $state.raw<ParticipationExport | null>(null);
	let status = $state<'loading' | 'loaded' | 'not-found' | 'error'>('loading');
	let error = $state('');

	async function load(id: string, sid: string) {
		status = 'loading';
		try {
			record = await api.scenarios.participationExport(id, sid);
			status = 'loaded';
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) status = 'not-found';
			else {
				error = e instanceof Error ? e.message : String(e);
				status = 'error';
			}
		}
	}
	$effect(() => {
		const id = projectId;
		const sid = scenarioId;
		untrack(() => load(id, sid));
	});

	const STATE: Record<ParticipationExport['comments'][number]['state'], string> = {
		shown: 'Shown',
		withdrawn: 'Withdrawn by its author',
		removed: 'Removed by a moderator'
	};
	const on = (c: { target: 'application' | 'pack'; packVersion: number | null }) => (c.target === 'pack' ? `Evidence pack, version ${c.packVersion ?? '?'}` : 'The application');
	const shown = $derived(record ? record.comments.filter((c) => c.state === 'shown').length : 0);
</script>

<svelte:head><title>{record ? `Public participation · ${record.application.name} · ` : ''}Water Management</title></svelte:head>

<main class="page participation" aria-busy={status === 'loading'} data-testid="participation-record">
	<p class="no-print"><a href={back}>← Back to the application</a></p>
	{#if status === 'not-found'}
		<div class="alert alert-error" role="alert">This record is for the application’s applicant and the assessors.</div>
	{:else if status === 'error'}
		<div class="alert alert-error" role="alert">
			The record could not be loaded: {error}
			<button type="button" class="btn btn-sm" onclick={() => load(projectId, scenarioId)}>Try again</button>
		</div>
	{:else if status === 'loading'}
		<p class="muted" role="status">Loading the record…</p>
	{/if}

	{#if status === 'loaded' && record}
		{@const a = record.application}
		<header>
			<h1>Public participation · {a.name}</h1>
			<p class="muted">
				The comments made in this app on the application and its evidence packs, for the public participation report (GN R267 reg 19). Laid out under the headings
				of GN R267 Annexure D item 8 that the app holds material for; records of meetings, and comments sent outside the app, are yours to add.
			</p>
			<div class="no-print bar">
				<button type="button" class="btn" onclick={() => window.print()}>Print or save as PDF</button>
				<a class="btn" href={api.scenarios.participationCsvUrl(projectId, scenarioId)} download data-testid="participation-csv">Download the comments (CSV)</a>
			</div>
		</header>

		<section aria-labelledby="pp-app">
			<h2 id="pp-app">The application and its notice</h2>
			<dl>
				<dt>Status</dt>
				<dd>{a.status}{a.submittedAt ? `, submitted ${fmtDate(a.submittedAt, true)}` : ''}{a.decidedAt ? `, decided ${fmtDate(a.decidedAt, true)}` : ''}</dd>
				<dt>Where written objections go</dt>
				<dd class="text">{a.objectionAddress ?? 'Not given in the app'}</dd>
				<dt>Closing date for objections</dt>
				<dd>{a.objectionClosingDate ?? 'Not given in the app'}</dd>
			</dl>
			<p class="muted">Every comment box in the app says that a comment there is not a written objection, and names this address and date when given.</p>
		</section>

		<section aria-labelledby="pp-access">
			<h2 id="pp-access">Access and opportunity to comment</h2>
			{#if record.links.length}
				<table>
					<thead><tr><th scope="col">Read-only link to</th><th scope="col">Made</th><th scope="col">Expires</th><th scope="col">Withdrawn</th></tr></thead>
					<tbody>
						{#each record.links as l, i (i)}
							<tr><td>{on(l)}</td><td>{fmtDate(l.createdAt, true)}</td><td>{fmtDate(l.expiresAt, true)}</td><td>{l.revokedAt ? fmtDate(l.revokedAt, true) : '–'}</td></tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<p>No read-only link was made in the app.</p>
			{/if}
		</section>

		<section aria-labelledby="pp-comments">
			<h2 id="pp-comments">Written comments received ({shown} shown, {record.comments.length} in all)</h2>
			{#if record.comments.length}
				<ol class="comments">
					{#each record.comments as c (c.id)}
						<li data-testid="participation-comment" data-state={c.state}>
							<p class="meta">
								<strong>{c.author ?? 'A former account'}</strong>{c.email ? ` · ${c.email}` : ''} · {on(c)} · {fmtDate(c.createdAt, true)}{c.editedAt
									? ` · edited ${fmtDate(c.editedAt, true)}`
									: ''} · {c.viaLink ? 'through a read-only link' : 'by a member of the project'} · {STATE[c.state]}
							</p>
							{#if c.body !== null}<p class="text">{c.body}</p>{:else}<p class="muted">(Its words go to the assessors only.)</p>{/if}
							{#if c.revisions.length}
								<details>
									<summary>Earlier texts ({c.revisions.length})</summary>
									<ol>
										{#each c.revisions as r, i (i)}<li><span class="muted">{fmtDate(r.writtenAt, true)}:</span> <span class="text">{r.body}</span></li>{/each}
									</ol>
								</details>
							{/if}
						</li>
					{/each}
				</ol>
			{:else}
				<p>No comment was made in the app.</p>
			{/if}
		</section>

		<section aria-labelledby="pp-register">
			<h2 id="pp-register">Register of interested and affected parties (from the app)</h2>
			<p class="muted">Only the commenters who ticked “Give my name and email to the applicant for the register (GN R267 reg 18)”. The regulations make you keep the register while the application is considered and for two years after a licence is granted.</p>
			{#if record.register.length}
				<table>
					<thead><tr><th scope="col">Name</th><th scope="col">Email</th></tr></thead>
					<tbody>
						{#each record.register as r (r.email)}<tr><td>{r.name}</td><td>{r.email}</td></tr>{/each}
					</tbody>
				</table>
			{:else}
				<p>Nobody has asked to be on it through the app.</p>
			{/if}
		</section>

		<section aria-labelledby="pp-decision">
			<h2 id="pp-decision">Notifying interested and affected parties of the decision</h2>
			<p>{a.decidedAt ? `The decision was recorded ${fmtDate(a.decidedAt, true)}, and the application’s read-only links show it.` : 'No decision is recorded yet.'} Notify the people on the register as the authority asks.</p>
		</section>
	{/if}
</main>

<style>
	.participation {
		max-width: 960px;
	}
	.bar {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 8px 0 16px;
	}
	section {
		margin: 20px 0;
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 4px 12px;
	}
	dt {
		font-weight: 600;
	}
	dd {
		margin: 0;
	}
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.comments {
		display: grid;
		gap: 12px;
		padding-left: 1.2em;
	}
	.meta {
		margin: 0;
		font-size: 0.9rem;
	}
	table {
		border-collapse: collapse;
		width: 100%;
	}
	th,
	td {
		text-align: left;
		padding: 4px 8px;
		border-bottom: 1px solid var(--border);
		overflow-wrap: anywhere;
	}
	@media print {
		.no-print {
			display: none;
		}
	}
</style>
