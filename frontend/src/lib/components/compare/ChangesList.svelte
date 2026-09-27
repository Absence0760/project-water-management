<script lang="ts">
	// "What changed" between the two runs' inputs (engine diffInputs), and
	// on the compare page who changed each line and when (issue #42).
	import type { InputChange, InputChangeArea } from '@water-management/engine';
	import type { HistoryRevision } from '$lib/api/types';
	import { byline } from './attribution';

	let {
		changes,
		authors = []
	}: {
		changes: InputChange[];
		/** authors[i]: the saved change that set changes[i] (compare/attribution.ts lineAuthors); null or absent for none. */
		authors?: (HistoryRevision | null)[];
	} = $props();

	const AREAS: { area: InputChangeArea; label: string }[] = [
		{ area: 'network', label: 'Network' },
		{ area: 'crops', label: 'Crops' },
		{ area: 'transfers', label: 'Transfers' },
		{ area: 'settings', label: 'Settings' },
		{ area: 'series', label: 'Time series' }
	];
	const KIND = { added: 'Added', removed: 'Removed', changed: 'Changed' } as const;

	const groups = $derived(
		AREAS.map((g) => ({
			...g,
			items: changes.map((c, i) => ({ c, by: authors[i] ?? null })).filter(({ c }) => c.area === g.area)
		})).filter((g) => g.items.length)
	);
</script>

{#if changes.length === 0}
	<p class="muted">
		No differences in the saved model, settings or series. Runs saved before series values were fingerprinted only
		record each series' dates, so an edit that kept the dates won't show for those.
	</p>
{:else}
	<div class="groups">
		{#each groups as g (g.area)}
			<section aria-label={g.label}>
				<h3>{g.label} <span class="count">({g.items.length})</span></h3>
				<ul>
					{#each g.items as { c, by }, i (i)}
						<li><span class="kind {c.kind}">{KIND[c.kind]}</span> {c.text}{#if by}<span class="by">{byline(by)}{by.reason ? ` · “${by.reason}”` : ''}</span>{/if}</li>
					{/each}
				</ul>
			</section>
		{/each}
	</div>
{/if}

<style>
	.groups {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		gap: 0.5rem 1.5rem;
	}
	h3 {
		margin: 0.25rem 0 0.35rem;
	}
	.count {
		color: var(--text-muted);
		font-weight: 400;
	}
	ul {
		list-style: none;
		margin: 0 0 0.5rem;
		padding: 0;
	}
	li {
		padding: 0.2rem 0;
		border-bottom: 1px solid var(--border);
		overflow-wrap: anywhere;
	}
	li:last-child {
		border-bottom: 0;
	}
	.kind {
		display: inline-block;
		min-width: 4.6rem;
		font-size: 0.72rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.02em;
		color: var(--text-2);
	}
	.by {
		display: block;
		margin-left: 4.6rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.added {
		color: var(--success);
	}
	.removed {
		color: var(--danger);
	}
</style>
