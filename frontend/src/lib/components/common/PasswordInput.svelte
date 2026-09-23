<script lang="ts">
	// Password field with a Show/Hide toggle. The toggle's accessible name is
	// "Show password" / "Hide password" from its content, so the field itself
	// stays the only control labelled "Password".
	import type { HTMLInputAttributes } from 'svelte/elements';

	let {
		value = $bindable(''),
		id,
		...rest
	}: { value?: string; id: string } & Omit<HTMLInputAttributes, 'type' | 'value' | 'id'> = $props();

	let shown = $state(false);
</script>

<div class="pw">
	<input {...rest} {id} type={shown ? 'text' : 'password'} bind:value autocapitalize="off" spellcheck="false" />
	<button type="button" class="toggle" aria-controls={id} onclick={() => (shown = !shown)}>
		{shown ? 'Hide' : 'Show'}<span class="visually-hidden"> password</span>
	</button>
</div>

<style>
	.pw {
		position: relative;
		display: flex;
	}
	.pw input {
		flex: 1;
		padding-right: 4.25rem !important;
	}
	.toggle {
		position: absolute;
		right: 4px;
		top: 50%;
		transform: translateY(-50%);
		min-height: 34px;
		padding: 0 0.7rem;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--accent);
		font: inherit;
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
	}
	.toggle:hover {
		background: var(--accent-soft);
	}
</style>
