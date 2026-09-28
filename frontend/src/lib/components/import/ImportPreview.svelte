<script lang="ts">
	// The import dialog's preview step: what the file holds, the importer's
	// notes, and the choices (name, team, run after import). Source-agnostic:
	// it takes an already-parsed document, whichever file it came from. A
	// source with more to show (a workbook's notes and unmapped report) passes
	// it as `extra`, rendered after the contents and before the run choice.
	import type { Snippet } from 'svelte';
	import type { Team } from '$lib/api';
	import { fmtNum } from '$lib/format/number';
	import { kindLabel } from '$lib/series/kinds';
	import { summarizeImport, type ParsedImport } from './projectFile';

	let {
		parsed,
		teams,
		name = $bindable(),
		teamId = $bindable(),
		run = $bindable(),
		disabled = false,
		fileLabel = 'In this file',
		extra
	}: {
		parsed: ParsedImport;
		/** Teams the user may add projects to (member or admin). */
		teams: Team[];
		name: string;
		/** '' = personal. */
		teamId: string;
		run: boolean;
		disabled?: boolean;
		/** The contents section's heading. */
		fileLabel?: string;
		extra?: Snippet;
	} = $props();

	const summary = $derived(summarizeImport(parsed.file));
	const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
	const nodeText = $derived(
		[
			plural(summary.farms, 'unit'),
			plural(summary.gauges, 'gauge'),
			...(summary.users ? [plural(summary.users, 'other water user')] : [])
		].join(', ')
	);
</script>

{#if parsed.notes.length}
	<div class="alert alert-info notes">
		<p class="notes-head">Before you import:</p>
		<ul>
			{#each parsed.notes as note, i (i)}<li>{note}</li>{/each}
		</ul>
	</div>
{/if}

<div class="field">
	<label for="imp-name">Name</label>
	<input id="imp-name" required maxlength="200" bind:value={name} {disabled} />
</div>

{#if teams.length}
	<div class="field">
		<label for="imp-team">Belongs to</label>
		<select id="imp-team" bind:value={teamId} {disabled} aria-describedby="imp-team-hint">
			<option value="">Personal</option>
			{#each teams as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
		</select>
		<span class="hint" id="imp-team-hint">In a team, members can edit, viewers can only read and team admins are owners.</span>
	</div>
{/if}

<section class="contents" aria-labelledby="imp-contents-h">
	<h3 id="imp-contents-h">{fileLabel}</h3>
	<dl>
		<div><dt>Network</dt><dd>{nodeText}</dd></div>
		<div><dt>Crops</dt><dd>{plural(summary.crops, 'crop')}, {plural(summary.cropAreas, 'planted area')}</dd></div>
		<div><dt>Transfers</dt><dd>{summary.transfers}</dd></div>
		<div><dt>Time series</dt><dd>{summary.series.length}</dd></div>
	</dl>
	{#if summary.series.length}
		<div class="table-wrap">
			<table class="data compact">
				<caption class="visually-hidden">Time series in the file</caption>
				<thead><tr><th scope="col">Series</th><th scope="col" class="num">Days</th><th scope="col">Dates</th></tr></thead>
				<tbody>
					{#each summary.series as s, i (i)}
						<tr>
							<th scope="row">{kindLabel(s.kind)}{#if s.name}<span class="muted"> · {s.name}</span>{/if}</th>
							<td class="num">{fmtNum(s.days)}</td>
							<td class="dates">{s.startDate}{#if s.endDate} – {s.endDate}{/if}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
	<p class="hint muted">Model runs aren't part of a project file. Everything gets new ids, so the same file can be imported again.</p>
</section>

{@render extra?.()}

<label class="check">
	<input type="checkbox" bind:checked={run} {disabled} aria-describedby="imp-run-hint" />
	Run the model after importing
</label>
<p class="hint muted run-hint" id="imp-run-hint">
	If the model can't run yet (no rainfall or A-pan evaporation, say), the project is still imported and the reason is shown.
</p>

<style>
	.notes-head {
		margin: 0;
		font-weight: 600;
	}
	.contents h3 {
		font-size: 0.9rem;
		margin: 0.5rem 0 0.4rem;
	}
	dl {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 0.4rem 1rem;
		margin: 0 0 0.6rem;
	}
	dl div {
		min-width: 0;
	}
	dt {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.table-wrap {
		overflow-x: auto;
		margin-bottom: 0.5rem;
	}
	table {
		width: 100%;
	}
	th[scope='row'] {
		font-weight: 500;
		text-align: left;
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.dates {
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.hint {
		font-size: 0.8rem;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.75rem;
		font-weight: 500;
	}
	.run-hint {
		margin: 0.25rem 0 0 1.5rem;
	}
</style>
