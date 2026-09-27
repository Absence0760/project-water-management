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
