<script lang="ts">
	// § 1's locality map (evidence-12, issue #326 A5): the engine's SVG as an
	// image (see locality.ts for why an image), its legend and notes as text,
	// and the SVG's SHA-256 the report names. A pack from before evidence-12,
	// or a project without map features, says so instead.
	import type { EvidenceReport } from '@water-management/engine';
	import { localityView } from './locality';

	let { report, frozen = false }: { report: EvidenceReport; frozen?: boolean } = $props();
	const view = $derived(localityView(report, frozen));
</script>

<div class="sub-block" data-testid="evidence-locality">
	<h3>Locality</h3>
	{#if view.kind === 'none'}
		<p class="na" data-testid="evidence-locality-none">{view.text}</p>
	{:else}
		<figure class="locality">
			<img src={view.src} alt={view.alt} width={view.figure.width} height={view.figure.height} decoding="sync" data-testid="evidence-locality-figure" />
			<figcaption>
				<p class="small"><strong>Figure 1.</strong> Locality of the {report.mode === 'application' ? 'application' : 'catchment'}, from the project’s map features as they were when this report was built. Figure SHA-256 <code data-testid="evidence-locality-sha">{view.svgSha256 ?? 'not recorded'}</code>.</p>
				<!-- The figure's legend and notes as text, for a screen reader and a copy-paste (the image prints them already). -->
				<div class="visually-hidden">
					<ul aria-label="Locality map legend" data-testid="evidence-locality-legend">
						{#each view.figure.legend as e (e.layer)}<li>{e.label}</li>{/each}
					</ul>
					{#if view.figure.labels.length}<p data-testid="evidence-locality-labels">Labelled on the map: {view.figure.labels.join(', ')}.</p>{/if}
					{#each view.figure.notes as n, i (i)}<p data-testid="evidence-locality-note">{n}</p>{/each}
					<p>Scale bar: {view.figure.scaleBar.label}.</p>
				</div>
			</figcaption>
		</figure>
	{/if}
</div>

<style>
	.na {
		font-style: italic;
		color: var(--text-muted);
	}
	.locality {
		margin: 0;
	}
	.locality img {
		display: block;
		max-width: 100%;
		height: auto;
		/* The figure is drawn on white for print and its hash: a frame keeps it a figure in dark mode. */
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		break-inside: avoid;
	}
	code {
		overflow-wrap: anywhere;
	}
</style>
