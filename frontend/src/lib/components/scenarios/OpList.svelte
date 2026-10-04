<script lang="ts">
	// A scenario's changes (its ops) in order, each in words with its class
	// (proposal or baseline assumption), what applying it did, and why it
	// doesn't apply when it doesn't. The red "Baseline assumptions changed"
	// callout heads the list whenever any op is a baseline assumption
	// (docs/scenarios.md § Classification). Used by the Scenarios tab's
	// editor (with a remove button per op) and the compare page's Scenario
	// overrides section (read only).
	import { CLASS_LABEL, type OpItem } from './ops';

	let {
		items,
		other = [],
		label,
		onremove,
		disabled = false
	}: {
		items: OpItem[];
		/** Problems the server gave that name no op. */
		other?: string[];
		/** Accessible name of the list ("Changes in Dam raise"). */
		label: string;
		/** Offer a remove button per op (an editor on a draft). */
		onremove?: (index: number) => void;
		disabled?: boolean;
	} = $props();

	const baseline = $derived(items.filter((i) => i.cls === 'baseline').length);
</script>

{#if baseline}
	<div class="callout" data-testid="baseline-callout">
		<strong>Baseline assumptions changed</strong>
		<span>
			{baseline === 1 ? '1 change alters' : `${baseline} changes alter`} what the base run assumes (settings, rain, the Reserve, the catchment's split of runoff, or
			someone else's hydrological unit), not just the proposal. An assessor will want to see why.
		</span>
	</div>
{/if}

{#if items.length}
	<ol class="ops" aria-label={label}>
		{#each items as it, i (i)}
			<li class:bad={!!it.problem}>
				<span class="n" aria-hidden="true">{i + 1}</span>
				<div class="body">
					<span class="text">{it.text}</span>
					{#if it.cls}<span class="tag" class:tag-baseline={it.cls === 'baseline'}>{CLASS_LABEL[it.cls]}</span>{/if}
					{#if it.problem}<span class="problem"><strong>Doesn't apply:</strong> {it.problem}</span>{/if}
					{#each it.notes as note, j (j)}<span class="note">{note}</span>{/each}
				</div>
				{#if onremove}
					<button type="button" class="btn btn-icon" aria-label="Remove change {i + 1}: {it.text}" title="Remove this change" {disabled} onclick={() => onremove(i)}
						>✕</button
					>
				{/if}
			</li>
		{/each}
	</ol>
{/if}

{#if other.length}
	<ul class="other">
		{#each other as p, i (i)}<li>{p}</li>{/each}
	</ul>
{/if}

<style>
	.callout {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin: 0 0 0.75rem;
		padding: 0.6rem 0.8rem;
		border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
		border-left: 4px solid var(--danger);
		border-radius: var(--radius);
		background: var(--danger-soft);
		color: var(--text);
		font-size: 0.9rem;
	}
	.callout strong {
		color: var(--danger);
	}
	.ops {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.4rem;
	}
	.ops li {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.ops li.bad {
		border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
		background: var(--warning-soft);
	}
	.n {
		flex: none;
		min-width: 1.4rem;
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		color: var(--text-2);
	}
	.body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.5rem;
		overflow-wrap: anywhere;
	}
	.text {
		color: var(--text);
	}
	.tag {
		font-size: 0.72rem;
		font-weight: 600;
		line-height: 1.5;
		padding: 0 0.4rem;
		border-radius: 999px;
		white-space: nowrap;
		background: var(--accent-soft);
		color: var(--accent);
	}
	.tag-baseline {
		background: var(--danger-soft);
		color: var(--danger);
	}
	.problem,
	.note {
		flex-basis: 100%;
		font-size: 0.82rem;
	}
	.problem {
		color: var(--warning);
	}
	.note {
		color: var(--text-2);
	}
	.other {
		margin: 0.5rem 0 0;
		color: var(--warning);
		font-size: 0.85rem;
	}
</style>
