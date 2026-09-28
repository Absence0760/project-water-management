<!--
	The monthly flow-duration curves on the EWR for two runs (engine ≥ 1.19.0,
	calibration research CR-29; docs/run-comparison.md): per EWR site in run
	A, its natural and present-day curves with run B's (a scenario's) curve
	over them, against the EWR curve. Sites are matched as the Reserve table
	above matches them (the outlet, then gauge id, then name).
-->
<script lang="ts">
	import type { EwrAssuranceSite } from '@water-management/engine';
	import EwrFdcOverlay from '$lib/components/runs/EwrFdcOverlay.svelte';
	import { matchSite } from '$lib/components/runs/ewrReporting';

	let { a, b, labelA, labelB }: { a: EwrAssuranceSite[]; b: EwrAssuranceSite[]; labelA: string; labelB: string } = $props();

	const pairs = $derived(
		a.map((s) => ({ s, o: matchSite(s, b) })).filter((p) => p.o && p.s.byMonth.some((m) => m.fdc.some((f) => f.natural !== undefined)))
	);
	const siteName = (s: EwrAssuranceSite) => (s.isOutlet ? `Outlet (${s.name})` : s.name);
</script>

{#if pairs.length}
	<h3>Flow-duration curves on the EWR</h3>
	<p class="muted small">Natural flow is run A’s. Compare runs of the same period for a like-for-like curve.</p>
	{#each pairs as p (p.s.nodeId ?? '(outlet)')}
		<h4>{siteName(p.s)}</h4>
		<EwrFdcOverlay site={p.s} presentLabel={labelA} other={{ label: labelB, site: p.o! }} />
	{/each}
{/if}
