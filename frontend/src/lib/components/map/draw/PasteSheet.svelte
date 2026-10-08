<!--
	Paste a shape (issue #326 C1; docs/ui.md § Map): GeoJSON or WKT in WGS84,
	the way to make or replace a shape without a pointer (WCAG 2.1.1, 2.5.7),
	and the way in for coordinates copied from QGIS or a survey. A shape that
	fits replaces the drawing on the map, where it can be adjusted and saved as
	any drawing is; nothing is saved here.
-->
<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import type { MapGeometry } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { parseShape } from './parseShape';
	import { draftProblem, editableCorners, shapeOf, type DraftShape } from './shape';

	let {
		open = $bindable(false),
		shape,
		onpasted
	}: {
		open?: boolean;
		/** The shape being drawn: a pasted shape must be one. */
		shape: DraftShape;
		onpasted: (g: MapGeometry) => void;
	} = $props();

	const uid = $props.id();
	const formId = `${uid}-form`;
	let text = $state('');
	let error = $state<string | null>(null);
	const example = $derived(
		shape === 'polygon'
			? 'POLYGON((21.30 -33.60, 21.40 -33.60, 21.40 -33.70, 21.30 -33.60))'
			: shape === 'line'
				? 'LINESTRING(21.30 -33.60, 21.35 -33.64, 21.40 -33.70)'
				: 'POINT(21.34 -33.62)'
	);
	const NAME: Record<DraftShape, string> = { point: 'a point', line: 'a line', polygon: 'a polygon' };

	function use(e: SubmitEvent) {
		e.preventDefault();
		const r = parseShape(text);
		if ('error' in r) {
			error = r.error;
			return;
		}
		const got = shapeOf(r.geometry);
		if (got !== shape) {
			error = `That’s ${NAME[got]}, and this drawing is ${NAME[shape]}. Pick ${got === 'line' ? 'River or Other line' : 'an area'} in the draw bar first, or paste ${NAME[shape]}.`;
			return;
		}
		const e1 = editableCorners(r.geometry);
		const problem = e1 ? draftProblem(e1.shape, e1.coords) : null;
		if (problem) {
			error = problem;
			return;
		}
		error = null;
		text = '';
		onpasted(r.geometry);
	}
</script>

<Dialog bind:open title="Paste a shape" side>
	<form id={formId} onsubmit={use} novalidate>
		<div class="field">
			<label for="{uid}-text">GeoJSON or WKT <HelpTip key="map-geojson-upload" label="About the shapes it takes" /></label>
			<textarea
				id="{uid}-text"
				rows="8"
				spellcheck="false"
				bind:value={text}
				aria-invalid={error ? 'true' : undefined}
				aria-describedby="{uid}-hint {uid}-err"
				data-testid="map-paste-text"
			></textarea>
			<span class="hint" id="{uid}-hint">
				One {NAME[shape].slice(NAME[shape].indexOf(' ') + 1)}, in WGS84: longitude first, then latitude (south is negative). As WKT, e.g. <code>{example}</code>, or a GeoJSON geometry or feature.
			</span>
			<span id="{uid}-err">{#if error}<span class="err" role="alert" data-testid="map-paste-error">{error}</span>{/if}</span>
		</div>
	</form>

	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
		<button type="submit" form={formId} class="btn btn-primary">Use this shape</button>
	{/snippet}
</Dialog>

<style>
	form {
		display: grid;
		gap: 0.75rem;
	}
	.field {
		display: grid;
		gap: 0.25rem;
	}
	textarea {
		font-family: var(--font-mono, monospace);
		font-size: 0.85rem;
		width: 100%;
	}
	.hint {
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	code {
		overflow-wrap: anywhere;
	}
	.err {
		color: var(--danger);
	}
</style>
