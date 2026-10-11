<script lang="ts">
	// The remembered "Explain each setting under its field" switch (explain.svelte.ts), the same words and
	// store wherever a form hides its explanations: Settings, a node's sheet, the scenario editor.
	import { explainSwitch } from './explain.svelte';
</script>

<label class="check explain-switch">
	<input type="checkbox" checked={explainSwitch.on} onchange={(e) => explainSwitch.set(e.currentTarget.checked)} />
	Explain each setting under its field
</label>

<style>
	.explain-switch {
		margin: 0;
		font-size: 0.85rem;
		font-weight: 400;
		color: var(--text-2);
	}
</style>
