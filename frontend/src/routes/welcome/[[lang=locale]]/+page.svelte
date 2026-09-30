<script lang="ts">
	import { untrack } from 'svelte';
	import Landing from '$lib/components/landing/Landing.svelte';
	import { setLocale } from '$lib/i18n/locale.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The address's language (issue #137), set before Landing renders: while
	// prerendering (the one render there is), at hydration, so the words match
	// the HTML, and again when the language switch moves between the two
	// addresses. With the catalogue in hand setLocale applies at once.
	untrack(() => void setLocale(data.locale, data.catalogue));
	$effect.pre(() => void setLocale(data.locale, data.catalogue));
</script>

<Landing lang={data.locale} />
