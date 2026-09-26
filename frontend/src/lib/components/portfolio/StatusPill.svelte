<script lang="ts">
	// A catchment's EWR status as words in a coloured pill: "Red: EWR not met
	// 9 of 30 days". The words carry the meaning; the colour repeats it, and an
	// unknown gets a dashed outline. The teams list, the team page and the
	// portfolio all show it the same way.
	import type { PortfolioProject } from '$lib/api/types';
	import { ewrText } from './portfolio';

	let { p }: { p: Pick<PortfolioProject, 'ewr'> } = $props();
</script>

<span class="st st-{p.ewr.status}">{ewrText(p)}</span>

<style>
	.st {
		display: inline-block;
		padding: 0.1rem 0.5rem;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		font-weight: 600;
		font-size: 0.85rem;
		line-height: 1.35;
		background: var(--surface-2);
		color: var(--text-2);
	}
	.st-red {
		background: var(--danger-soft);
		border-color: color-mix(in srgb, var(--danger) 40%, transparent);
		color: var(--danger);
	}
	.st-amber {
		background: var(--warning-soft);
		border-color: color-mix(in srgb, var(--warning) 40%, transparent);
		color: var(--warning);
	}
	.st-green {
		background: var(--success-soft);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
		color: var(--success);
	}
	.st-unknown {
		border-style: dashed;
	}
</style>
