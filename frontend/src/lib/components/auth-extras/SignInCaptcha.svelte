<!-- i18n-section: captcha -->
<script lang="ts">
	// The WAF's sign-in puzzle (issue #126, $lib/auth/wafCaptcha). Shown only
	// after a sign-in got the CAPTCHA answer: it loads AWS's CAPTCHA script
	// then, renders the puzzle into its box, and hands the token back. Focus
	// moves to its heading, so a screen reader reads why it is there and the
	// next Tab reaches the puzzle, whose audio button plays a spoken version.
	import { onMount, tick } from 'svelte';
	import { loadCaptchaSdk, type CaptchaConfig } from '$lib/auth/wafCaptcha';
	import { t } from '$lib/i18n/locale.svelte';

	let {
		config,
		onsolved,
		onfailed
	}: {
		config: CaptchaConfig;
		/** The puzzle was solved: send the sign-in again with this token. */
		onsolved: (wafToken: string) => void;
		/** The script or the puzzle failed: the page says to wait instead. */
		onfailed: () => void;
	} = $props();

	let title: HTMLHeadingElement;
	let box: HTMLDivElement;
	/** For tests and styling: loading → ready (puzzle on screen) → solved. */
	let state = $state<'loading' | 'ready' | 'solved'>('loading');

	onMount(() => {
		let live = true;
		void tick().then(() => title?.focus());
		loadCaptchaSdk(config.scriptUrl)
			.then((sdk) => {
				if (!live) return;
				sdk.renderCaptcha(box, {
					apiKey: config.apiKey,
					// The puzzle's own words: AWS has no Afrikaans, so English for both of the app's languages.
					defaultLocale: 'en-US',
					dynamicWidth: true,
					skipTitle: true,
					onLoad: () => {
						if (live) state = 'ready';
					},
					onSuccess: (token) => {
						if (!live) return;
						state = 'solved';
						onsolved(token);
					},
					onError: () => {
						if (live) onfailed();
					}
				});
			})
			.catch(() => {
				if (live) onfailed();
			});
		return () => {
			live = false;
		};
	});
</script>

<section class="captcha" aria-labelledby="captcha-title" data-state={state}>
	<h2 id="captcha-title" tabindex="-1" bind:this={title}>{t('Check that you’re a person')}</h2>
	<p>{t('There were many sign-in attempts from your network, so we need to check this one is a person. Solve the puzzle and you’ll be signed in. The audio button in the puzzle plays a spoken version.')}</p>
	<div class="box" bind:this={box}></div>
	{#if state === 'loading'}<p class="muted" role="status">{t('Loading the puzzle…')}</p>{/if}
</section>

<style>
	.captcha {
		display: grid;
		gap: 0.5rem;
		padding: 0.75rem 0.9rem;
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent);
		border-radius: var(--radius);
		background: var(--surface-2);
		overflow-wrap: anywhere;
	}
	h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	p {
		margin: 0;
	}
	.box {
		/* The SDK sizes itself (dynamicWidth); keep it inside the card on a phone. */
		max-width: 100%;
		overflow-x: auto;
	}
</style>
