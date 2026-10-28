<script lang="ts">
	// The source run's drought badge on the project list and the team page (issue #620, docs/ui.md §
	// Project list): "Severely dry · SPEI-12", the value and the months in the tooltip, from the run
	// summary (summary.drought) so no row loads a series. A muted dash when the run has none, the tooltip
	// saying why; nothing without a run. The words carry the class; the colour only repeats it.
	// Workspace only: no farmer page shows it (#620 open question 4).
	import type { PortfolioProject } from '#lib/api/types.js';
	import { droughtTag } from './portfolio';

	let { p }: { p: Pick<PortfolioProject, 'drought' | 'source'> } = $props();
	const tag = $derived(droughtTag(p));
</script>

{#if tag?.kind === 'index'}
	<span class="badge drought tone-{tag.tone}" title={tag.title} data-testid="drought-tag" data-tone={tag.tone}
		>{tag.label} · {tag.index}<span class="visually-hidden">. {tag.title}</span></span
	>
{:else if tag}
	<span class="drought muted" title={tag.title} data-testid="drought-tag" data-tone="none"
		>Drought –<span class="visually-hidden">. {tag.title}</span></span
	>
{/if}

<style>
	.drought {
		font-size: var(--font-xs);
		position: relative;
		z-index: 1;
	}
	.tone-dry {
		background: var(--warning-soft);
		color: var(--warning);
		border-color: transparent;
	}
	.tone-wet {
		background: var(--accent-soft);
		color: var(--accent);
		border-color: transparent;
	}
</style>
