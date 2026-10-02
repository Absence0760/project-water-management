<!-- A map-proposal panel's dataset citation and method, collapsed (ProposalPanel.svelte). -->
<script lang="ts">
	let { testid, citation, method }: { testid: string; citation: string; method: string } = $props();
</script>

<details class="method small">
	<summary>Source and method</summary>
	<p data-testid={testid}>{citation}</p>
	<p>{method}</p>
</details>

<style>
	.small {
		font-size: 0.85rem;
	}
	.method p {
		margin: 0.35rem 0 0;
		overflow-wrap: anywhere;
	}
</style>
