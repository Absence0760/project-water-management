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
	/* At least 24 px tall (WCAG 2.5.8), whatever the text's size. */
	.method > summary {
		box-sizing: border-box;
		min-height: 24px;
		padding-block: 0.2rem;
		cursor: pointer;
	}
	.method p {
		margin: 0.35rem 0 0;
		overflow-wrap: anywhere;
	}
</style>
