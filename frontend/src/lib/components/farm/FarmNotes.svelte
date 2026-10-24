<!-- i18n-section: farm.notes -->
<!--
	"Notes about your farm" on the farmer's page (WP-2.7): the farmer's own
	notes and the WUA's farm-visible ones on this farm, and a form to add one
	(always shown to the farm). RLS gives a farmer nothing else. The WUA
	previewing the page sees the same farm-visible notes, read only. The list
	is the workspace's NotesList, worded from the catalogue (./notesWords.ts).
-->
<script lang="ts">
	import NotesList from '#lib/components/notes/NotesList.svelte';
	import { t } from '#lib/i18n/locale.svelte.js';
	import { farmNotesWords } from './notesWords';

	let { projectId, nodeId, farmName, preview }: { projectId: string; nodeId: string; farmName: string; preview: boolean } = $props();
</script>

<section class="card farm-notes" aria-labelledby="farm-notes-h">
	<h2 id="farm-notes-h">{t('Notes about your hydrological unit')}</h2>
	<p class="sub">{t('Your notes and the WUA’s on {farm}. Anything you add here is read by the WUA and anyone else linked to this hydrological unit.', { farm: farmName })}</p>
	<NotesList
		{projectId}
		target={{ kind: 'node', nodeId, name: farmName, isFarm: true }}
		farmer
		farmOnly={preview}
		canWrite={!preview}
		emptyText={t('No notes about this hydrological unit yet.')}
		words={farmNotesWords()}
	/>
</section>

<style>
	/* NotesList is the workspace's, sized for its 14 px root (.small, .meta and
	   .btn-sm at 0.85rem, 11.9 px; the button 24 px tall above 640 px). The farm
	   pages' floor is 13 px text and 44 px targets at every width (ui.md §
	   Farmer view), so the farm's copy lifts them here. */
	.farm-notes :global(.small),
	.farm-notes :global(.meta) {
		font-size: 14px;
	}
	.farm-notes :global(.btn-sm) {
		min-height: var(--tap);
		padding: 0 16px;
		font-size: 15px;
	}
	/* "No notes … yet." sat on the form's label with no gap between them. */
	.farm-notes :global(.notes > p.muted) {
		margin: 0 0 12px;
	}
</style>
