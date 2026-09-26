<script lang="ts">
	// The assessors' Applications tab (?tab=applications, WP-3.3, docs/ui.md
	// § Applications): every application an applicant has submitted, with its
	// status, sortable by date or status. Opening one goes to the Scenarios
	// tab, where an editor who didn't make it decides it. Drafts never appear:
	// they are the applicant's alone (RLS, 045_contributor_scope). Evidence
	// packs (WP-3.14) will be linked from here once they exist.
	import { untrack } from 'svelte';
	import { api, OUTCOME_LABEL, type Scenario } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fmtDate } from '$lib/format/number';
	import { sortApplications, type ApplicationSort } from './applications';

	let { projectId }: { projectId: string } = $props();

	let items = $state<Scenario[] | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let sort = $state<ApplicationSort>('date');

	async function load() {
		loading = true;
		error = null;
		try {
			items = await api.scenarios.applications(projectId);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void projectId;
		untrack(load);
	});

	const sorted = $derived(sortApplications(items ?? [], sort));
	const STATUS: Record<Scenario['status'], string> = { draft: 'Draft', submitted: 'Awaiting a decision', withdrawn: 'Withdrawn', decided: 'Decided' };
</script>

<section class="panel" aria-labelledby="applications-h">
	<div class="panel-head">
		<!-- Not "Applications": the tab body is already the region of that name (landmarks need unique names). -->
		<h2 id="applications-h">Submitted applications</h2>
		{#if items?.length}
			<div class="field sort">
				<label for="applications-sort">Sort by</label>
				<select id="applications-sort" bind:value={sort}>
					<option value="date">Newest first</option>
					<option value="status">Status</option>
				</select>
			</div>
		{/if}
	</div>
	<p class="muted intro">
		Scenarios applicants have submitted on the published baseline. Open one to see its changes and runs, and to decide it. Drafts stay with the applicant.
	</p>
	<LoadState {loading} {error} retry={load}>
		{#if sorted.length}
			<div class="table-wrap">
				<table class="data">
					<thead>
						<tr>
							<th scope="col">Application</th>
							<th scope="col">Applicant</th>
							<th scope="col">Status</th>
							<th scope="col">Submitted</th>
							<th scope="col" class="num">Changes</th>
							<th scope="col" class="num">Runs</th>
						</tr>
					</thead>
					<tbody>
						{#each sorted as a (a.id)}
							<tr>
								<th scope="row"><a href="?tab=scenarios&scenario={encodeURIComponent(a.id)}">{a.name}</a></th>
								<td>{a.owner ?? '—'}{a.members.length ? ` (+${a.members.length})` : ''}</td>
								<td>
									<span class="status status-{a.status}">{STATUS[a.status]}</span>
									{#if a.outcome}<span class="outcome">{OUTCOME_LABEL[a.outcome]}</span>{/if}
								</td>
								<td>{a.submittedAt ? fmtDate(a.submittedAt, true) : '—'}</td>
								<td class="num">{a.ops.length}</td>
								<td class="num">{a.runCount}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<p class="empty" data-testid="applications-empty">No applications submitted.</p>
		{/if}
	</LoadState>
</section>

<style>
	.panel-head {
		gap: 1rem;
	}
	.sort {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0 0 0 auto;
	}
	.intro {
		margin: 0 0 0.75rem;
		max-width: 70ch;
	}
	.status {
		font-size: 0.8rem;
		font-weight: 600;
	}
	.status-submitted {
		color: var(--accent);
	}
	.outcome {
		display: block;
		font-size: 0.8rem;
		color: var(--text-2);
	}
	.empty {
		color: var(--text-2);
	}
	th[scope='row'] a {
		overflow-wrap: anywhere;
	}
</style>
