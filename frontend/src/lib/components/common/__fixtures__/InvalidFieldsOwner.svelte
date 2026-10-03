<script lang="ts">
	// Test fixture (invalidFieldsScope.test.ts): provides `owners[0]`, then
	// renders itself with the rest, and at the bottom a probe that reports the
	// registry it finds. An empty list provides nothing.
	import { provideInvalidFields, type InvalidFields } from '../invalidFields.svelte';
	import InvalidFieldsProbe from './InvalidFieldsProbe.svelte';
	import Self from './InvalidFieldsOwner.svelte';

	let { owners, onfound }: { owners: InvalidFields[]; onfound: (f: InvalidFields) => void } = $props();
	// svelte-ignore state_referenced_locally
	const [first, ...rest] = owners;
	if (first) provideInvalidFields(first);
</script>

{#if first}<Self owners={rest} {onfound} />{:else}<InvalidFieldsProbe {onfound} />{/if}
