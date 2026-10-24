<script lang="ts">
	// A catchment's status as words in a coloured pill: its EWR ("Red: EWR not
	// met 9 of 30 days", the teams list and the team page) or its irrigation
	// supply ("Amber: 88.0% supplied, …", the project list since issue #558).
	// The words carry the meaning; the colour repeats it, and an unknown gets
	// a dashed outline.
	import type { PortfolioProject } from '$lib/api/types';
	import { ewrText, irrigationText } from './portfolio';

	let { p, kind = 'ewr' }: { p: Pick<PortfolioProject, 'ewr' | 'irrigation'>; kind?: 'ewr' | 'irrigation' } = $props();
</script>

<!-- The irrigation pill is the status and the share alone; the list says the units below 95 % under it. -->
<span class="st st-{p[kind].status}">{kind === 'ewr' ? ewrText(p) : irrigationText(p, true)}</span>

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
