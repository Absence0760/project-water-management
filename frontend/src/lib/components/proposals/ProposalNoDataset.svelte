<!-- "Nothing is loaded" in a map-proposal panel, in plain words: what is missing, what follows, and what to do by
     hand instead (ProposalPanel.svelte). The loader command is the operator's and lives in docs/maps.md only: the
     people reading this notice are hydrologists, not the server's operator (issue #586, C5). -->
<script lang="ts">
	let { testid, what, consequence, instead }: { testid: string; what: string; consequence: string; instead: string } = $props();
</script>

<p class="alert alert-info slim" data-testid={testid}>
	There’s no {what} on this server yet, so {consequence}. {instead}
</p>

<style>
	.slim {
		padding: 0.5rem 0.75rem;
		margin: 0;
	}
</style>
