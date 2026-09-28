<script lang="ts">
	// A code-split chunk failed to download (a network blip, or a deploy that
	// removed it). Only a reload recovers (lazy.ts says why), so this offers
	// "Reload page", never "Try again", and never reloads by itself (no reload
	// loop if the chunk is really gone). The reload goes through the page's
	// beforeunload guard, so with unsaved changes the browser asks first; the
	// message warns about them (chunkFailed.ts, provideUnsaved).
	// A translated page passes its own `text` and `reload` wording (t()), since
	// this component stays off the i18n module; those pages keep no unsaved
	// state, so `text` is the whole message.
	import { chunkFailedText, unsavedCheck } from './chunkFailed';

	let {
		what = 'This part of the page',
		text,
		reload = 'Reload page'
	}: { what?: string; text?: string; reload?: string } = $props();

	const unsaved = unsavedCheck();
</script>

<div class="alert alert-error" role="alert">
	{text ?? chunkFailedText(what, unsaved())}
	<button type="button" class="btn btn-sm" onclick={() => location.reload()}>{reload}</button>
</div>

<style>
	.btn {
		margin-left: 0.75rem;
	}
</style>
