<!--
	"Notes about your farm" on the farmer's page (WP-2.7): the farmer's own
	notes and the WUA's farm-visible ones on this farm, and a form to add one
	(always shown to the farm). RLS gives a farmer nothing else. The WUA
	previewing the page sees the same farm-visible notes, read only.
-->
<script lang="ts">
	import NotesList from '$lib/components/notes/NotesList.svelte';

	let { projectId, nodeId, farmName, preview }: { projectId: string; nodeId: string; farmName: string; preview: boolean } = $props();
</script>

<section class="card" aria-labelledby="farm-notes-h">
	<h2 id="farm-notes-h">Notes about your farm</h2>
	<p class="sub">Your notes and the WUA’s on {farmName}. Anything you add here is read by the WUA and anyone else linked to this farm.</p>
	<NotesList
		{projectId}
		target={{ kind: 'node', nodeId, name: farmName, isFarm: true }}
		farmer
		farmOnly={preview}
		canWrite={!preview}
		emptyText="No notes about this farm yet."
	/>
</section>
