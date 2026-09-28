<!-- i18n-section: password -->
<script lang="ts">
	// Password field with a Show/Hide toggle. The toggle is named "Show
	// password" / "Hide password" (one message each, so a translation can
	// order the words its own way), and the field itself stays the only
	// control labelled "Password". Only the translated pages use it (sign-in,
	// register, reset, account), so its words go through t().
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { t } from '$lib/i18n/locale.svelte';

	let {
		value = $bindable(''),
		el = $bindable(),
		id,
		...rest
	}: { value?: string; el?: HTMLInputElement; id: string } & Omit<HTMLInputAttributes, 'type' | 'value' | 'id'> = $props();

	let shown = $state(false);
</script>

<div class="pw">
	<input {...rest} {id} type={shown ? 'text' : 'password'} bind:value bind:this={el} autocapitalize="off" spellcheck="false" />
	<!-- Named from its content, not aria-label, so a lookup by the label "Password" finds only the field. -->
	<button type="button" class="toggle" aria-controls={id} onclick={() => (shown = !shown)}>
		<span aria-hidden="true">{shown ? t('Hide', {}, 'password field') : t('Show', {}, 'password field')}</span>
		<span class="visually-hidden">{shown ? t('Hide password') : t('Show password')}</span>
	</button>
</div>

<style>
	/* The wrapper draws the field (border, fill, focus ring) and lays the input
	   and the toggle side by side, so the toggle takes exactly its own width.
	   It used to sit over the input's end with a fixed 4.25rem reserve, which
	   Afrikaans "Versteek" (70 px) overran, covering the end of a revealed
	   password (WCAG 1.4.4 / 1.4.10). */
	.pw {
		display: flex;
		align-items: center;
		gap: 2px;
		padding-right: 4px;
		background: var(--surface);
		border: 1px solid var(--border-input);
		border-radius: var(--radius-sm);
	}
	.pw:hover {
		border-color: var(--text-muted);
	}
	.pw:has(input:focus-visible) {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.pw input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
	}
	.pw input:focus-visible {
		outline: none;
	}
	.toggle {
		flex: none;
		min-height: 34px;
		padding: 0 0.7rem;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--accent);
		font: inherit;
		font-size: 1rem;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
	}
	.toggle:hover {
		background: var(--accent-soft);
	}
</style>
