<script lang="ts">
	// The hydrologist plausibility checks of both runs side by side
	// (RunComparison.plausibility, docs/run-comparison.md § Plausibility checks):
	// per site, the outlet then each gauge with a record of its own, the water
	// years that fail "natural ≥ observed + abstraction" and the dry-season Q90
	// ratio, each with pass or fail; then the catchment-wide rain-source split
	// and double-mass breaks; then the recession diagnostics and the validation
	// signatures, with a note on a run that has none (and why) or on two runs
	// that scored different records. Each run's own result, as its
	// Plausibility checks panel showed it.
	import type { PlausibilityComparison } from '@water-management/engine';
	import { plausibilityNotes, plausibilityRows } from './plausibility';

	let { comparison }: { comparison: PlausibilityComparison } = $props();

	const rows = $derived(plausibilityRows(comparison));
	const mark = (ok: boolean | null) => (ok === null ? 'none' : ok ? 'good' : 'bad');
	const onlyIn = $derived(comparison.sites.filter((s) => s.onlyIn));
	const notes = $derived(plausibilityNotes(comparison));
</script>

<p class="muted small intro">
	Each run’s own checks: before and after a refit or new data, which water years stopped (or started) failing, and whether the simulated dry-season
	low flows moved inside the factor of 2 that low-flow gauging error allows, and whether the recessions and the validation signatures (base-flow index,
	low-flow curve, held-out recessions) moved inside their provisional limits. A gauge inside the network is checked only when its own observed record
	is attached to it (Data page).
</p>
{#each onlyIn as s (s.nodeId ?? 'outlet')}
	<p class="note small" role="note">Only run {s.onlyIn!.toUpperCase()} has checks at {s.isOutlet ? 'the outlet' : `gauge ${s.name}`}.</p>
{/each}
{#each notes as n (n)}
	<p class="note small" role="note">{n}</p>
{/each}

{#if rows.length}
	<div class="table-wrap">
		<table class="data" data-testid="plausibility-compare">
			<caption class="visually-hidden">Plausibility checks for both runs</caption>
			<thead>
				<tr>
					<th scope="col">Site</th>
					<th scope="col">Check</th>
					<th scope="col">Run A</th>
					<th scope="col">Run B</th>
					<th scope="col">Change</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.key)}
					<tr>
						<th scope="row">{r.site}</th>
						<td>{r.check}</td>
						<td class="res {mark(r.okA)}">{r.a}</td>
						<td class="res {mark(r.okB)}">{r.b}</td>
						<td>{r.change}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else}
	<p class="muted small">Neither run could make these checks: they need an observed flow record.</p>
{/if}

<style>
	.intro {
		max-width: 85ch;
		margin: 0 0 0.5rem;
	}
	.note {
		color: var(--warning);
		margin: 0 0 0.5rem;
	}
	td.res {
		border-left: 4px solid transparent;
	}
	td.res.good {
		border-left-color: var(--success);
	}
	td.res.bad {
		border-left-color: var(--danger);
	}
</style>
