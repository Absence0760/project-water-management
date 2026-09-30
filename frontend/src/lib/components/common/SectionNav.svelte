<!--
	The "On this page" menu of a long workspace page: a bar of links that sticks
	under the app header and marks the section being read (scroll spy). On a
	laptop or wider the links flow like words across at most two rows, a group
	free to break across them (as whole blocks, a long group pushed the next one
	onto a row of its own: three rows at 1280 px); what doesn't fit goes, in
	page order, into a More menu at the bar's end (navFitCount). On a phone it
	is one strip that scrolls sideways, every link on it. Each group is a list
	labelled by its name for screen readers, and the More menu shows the names
	as headings. With `groupNames` the bar shows them too, each before its
	group's first link and set off by a wider gap; without it the links are
	evenly spaced (issue #162: a wider gap with no name read as a spacing bug). While it
	is shown, in-page jumps and focus scrolling keep clear of it (WCAG 2.4.11).
-->
<script lang="ts">
	import { activeSectionId, navFitCount, type NavGroup, type NavSection } from './sectionNav';

	let {
		groups,
		label,
		groupNames = false
	}: {
		groups: NavGroup[];
		label: string;
		/** Show each group's name on the bar, before its first link (a small muted label). */
		groupNames?: boolean;
	} = $props();

	/** The bar's most rows on a laptop or wider. */
	const ROWS = 2;
	/** The space after each link and before a group's first one, in rem (the CSS below uses the same). */
	const GAP_REM = 0.35;
	const GROUP_GAP_REM = 1.1;
	const PHONE = '(max-width: 640px)';

	const uid = $props.id();
	const flat = $derived(
		groups.flatMap((g, gi) =>
			g.sections.map((s, si) => {
				const groupName = groupNames && si === 0 ? g.label : null;
				// The wider gap only before a group whose name is on the bar: an unnamed gap reads as a bug (issue #162).
				return { ...s, groupStart: gi > 0 && !!groupName, groupName };
			})
		)
	);
	const ids = $derived(flat.map((s) => s.id));
	let height = $state(0);
	let activeSection = $state<string | null>(null);
	let flowEl = $state<HTMLDivElement>();
	let measureEl = $state<HTMLDivElement>();
	let phone = $state(false);
	/** How many links stay on the bar; the rest are in More. */
	let kept = $state(Number.POSITIVE_INFINITY);
	let moreOpen = $state(false);
	let moreWrap = $state<HTMLElement>();
	let moreBtn = $state<HTMLButtonElement>();

	/** Each group's links on the bar and in More, in page order. */
	const split = $derived.by(() => {
		let i = 0;
		return groups.map((g) => {
			const bar: NavSection[] = [];
			const more: NavSection[] = [];
			for (const s of g.sections) (i++ < kept ? bar : more).push(s);
			return { label: g.label, bar, more };
		});
	});
	const overflow = $derived(!phone && kept < flat.length);
	const currentInMore = $derived(overflow && flat.slice(kept).some((s) => s.id === activeSection));

	$effect(() => {
		const mq = matchMedia(PHONE);
		const on = () => (phone = mq.matches);
		on();
		mq.addEventListener('change', on);
		return () => mq.removeEventListener('change', on);
	});
	// How many links fit in two rows: measured from a hidden copy of every link (their widths don't
	// depend on the bar), again whenever the bar's width, the labels or the fonts change.
	$effect(() => {
		const items = flat;
		if (phone) {
			kept = items.length;
			return;
		}
		if (!flowEl || !measureEl) return;
		const flow = flowEl;
		const copy = measureEl;
		const measure = () => {
			const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
			const marked = [...copy.querySelectorAll<HTMLElement>('[data-m]')];
			const plain = [...copy.querySelectorAll<HTMLElement>('[data-p]')];
			const width = (el: Element | null | undefined) => el?.getBoundingClientRect().width ?? 0;
			const lead = width(copy.querySelector('.nav-h'));
			kept = navFitCount(
				items.map((it, i) => ({ width: Math.max(width(marked[i]), width(plain[i])), groupStart: it.groupStart })),
				{
					avail: flow.clientWidth,
					lead: lead ? lead + GAP_REM * rem : 0,
					gap: GAP_REM * rem,
					groupGap: GROUP_GAP_REM * rem,
					more: Math.max(width(copy.querySelector('[data-more]')), width(copy.querySelector('[data-more-p]'))),
					rows: ROWS
				}
			);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(flow);
		// The copy itself has no size (so it can't widen the page): watch each of its pills.
		for (const el of copy.children) ro.observe(el);
		return () => ro.disconnect();
	});
	// Nothing left to show in More (a wider window): close it.
	$effect(() => {
		if (!overflow) moreOpen = false;
	});

	// More closes on Escape (focus back on its button), on a click outside it, when focus leaves it
	// and when one of its links is followed.
	function moreKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !moreOpen) return;
		e.preventDefault();
		moreOpen = false;
		moreBtn?.focus();
	}
	function moreFocusOut(e: FocusEvent) {
		if (moreWrap && !moreWrap.contains(e.relatedTarget as Node | null)) moreOpen = false;
	}
	$effect(() => {
		if (!moreOpen) return;
		const onDoc = (e: PointerEvent) => {
			if (moreWrap && !moreWrap.contains(e.target as Node)) moreOpen = false;
		};
		document.addEventListener('pointerdown', onDoc);
		return () => document.removeEventListener('pointerdown', onDoc);
	});

	// On a phone the menu is one sideways strip: keep the marked link in it in view.
	$effect(() => {
		const link = activeSection ? flowEl?.querySelector<HTMLElement>(`.groups a[href="#${activeSection}"]`) : null;
		if (!flowEl || !link || flowEl.scrollWidth <= flowEl.clientWidth) return;
		const left = link.offsetLeft - flowEl.offsetLeft;
		if (left < flowEl.scrollLeft || left + link.offsetWidth > flowEl.scrollLeft + flowEl.clientWidth) {
			flowEl.scrollLeft = left - 16;
		}
	});
	$effect(() => {
		const root = document.documentElement;
		const header = parseFloat(getComputedStyle(root).getPropertyValue('--header-h')) || 0;
		root.style.scrollPaddingTop = `${header + height + 12}px`;
		return () => {
			root.style.scrollPaddingTop = '';
		};
	});
	$effect(() => {
		const watched = ids;
		let frame = 0;
		// The URL's fragment, the section a followed link named (a malformed one names none).
		const fragment = () => {
			try {
				return decodeURIComponent(location.hash.slice(1)) || null;
			} catch {
				return null;
			}
		};
		const update = () => {
			frame = 0;
			const root = document.documentElement;
			// A section counts as reached once its top passes under the sticky menu.
			const line = (parseFloat(getComputedStyle(root).scrollPaddingTop) || 0) + 8;
			const tops = watched.flatMap((id) => {
				const el = document.getElementById(id);
				return el ? [{ id, top: el.getBoundingClientRect().top }] : [];
			});
			activeSection = activeSectionId(tops, line, window.innerHeight + window.scrollY >= root.scrollHeight - 2, fragment(), window.innerHeight);
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		update();
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		// Panels open, close and load their charts late, which moves every later section.
		const grow = new ResizeObserver(schedule);
		grow.observe(document.body);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
			grow.disconnect();
		};
	});
</script>

{#snippet moreText(current: boolean)}
	More<span class="visually-hidden"> sections{current ? ', including the one being read' : ''}</span>
	<span aria-hidden="true">▾</span>
{/snippet}
{#snippet linkText(sec: NavSection)}
	{sec.label}{#if sec.problem}<span class="dot" aria-hidden="true"></span><span class="visually-hidden"> (has a problem)</span>{/if}
{/snippet}

<nav class="sections" aria-label={label} bind:clientHeight={height}>
	<div class="flow" bind:this={flowEl}>
		<span class="nav-h" aria-hidden="true">On this page</span>
		<ul class="groups">
			{#each split as g, gi (gi)}
				{#if g.bar.length}
					<li class="group">
						{#if g.label}<span class="visually-hidden" id="{uid}-g{gi}">{g.label}</span>{/if}
						<ul aria-labelledby={g.label ? `${uid}-g${gi}` : undefined}>
							{#each g.bar as sec, si (sec.id)}
								<li class="item" class:group-start={gi > 0 && si === 0 && groupNames && !!g.label}>
									{#if groupNames && g.label && si === 0}<span class="grp-h" aria-hidden="true">{g.label}</span>{/if}
									<a class="pill" href="#{sec.id}" aria-current={sec.id === activeSection ? 'location' : undefined}>{@render linkText(sec)}</a>
								</li>
							{/each}
						</ul>
					</li>
				{/if}
			{/each}
		</ul>
		{#if overflow}
			<div class="item group-start more" bind:this={moreWrap} onkeydown={moreKeydown} onfocusout={moreFocusOut} role="presentation">
				<button
					type="button"
					class="pill more-btn"
					class:current={currentInMore}
					aria-expanded={moreOpen}
					aria-controls="{uid}-more"
					bind:this={moreBtn}
					onclick={() => (moreOpen = !moreOpen)}
				>
					{@render moreText(currentInMore)}
				</button>
				{#if moreOpen}
					<div class="pop" id="{uid}-more">
						{#each split as g, gi (gi)}
							{#if g.more.length}
								{#if g.label}<p class="pop-h" id="{uid}-m{gi}">{g.label}</p>{/if}
								<ul aria-labelledby={g.label ? `${uid}-m${gi}` : undefined}>
									{#each g.more as sec (sec.id)}
										<li>
											<a href="#{sec.id}" aria-current={sec.id === activeSection ? 'location' : undefined} onclick={() => (moreOpen = false)}>{@render linkText(sec)}</a>
										</li>
									{/each}
								</ul>
							{/if}
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
	<!-- Every link's width, for the fit: a hidden copy, laid out apart from the bar, each link
	     twice, plain and marked as the one being read (bold), and the More button both ways too.
	     The fit takes the wider of each pair: bold is not always the wider, since a renderer that
	     rounds each glyph's advance to whole pixels (Chromium on Linux) can set the regular weight
	     a few pixels wider than the semibold, and a fit from the bold widths alone kept a link too
	     many there, so More wrapped to a third row. -->
	<div class="measure" aria-hidden="true" inert bind:this={measureEl}>
		<span class="nav-h">On this page</span>
		{#each flat as sec (sec.id)}
			{#if sec.groupName}
				<span class="named" data-m><span class="grp-h">{sec.groupName}</span><span class="pill marked">{@render linkText(sec)}</span></span>
				<span class="named" data-p><span class="grp-h">{sec.groupName}</span><span class="pill">{@render linkText(sec)}</span></span>
			{:else}
				<span class="pill marked" data-m>{@render linkText(sec)}</span>
				<span class="pill" data-p>{@render linkText(sec)}</span>
			{/if}
		{/each}
		<button type="button" class="pill more-btn current" tabindex="-1" data-more>{@render moreText(true)}</button>
		<button type="button" class="pill more-btn" tabindex="-1" data-more-p>{@render moreText(false)}</button>
	</div>
</nav>

<style>
	.sections {
		--gap: 0.35rem;
		--group-gap: 1.1rem;
		position: sticky;
		top: var(--header-h);
		z-index: 15;
		margin: 0 0 1rem;
		padding: 0.3rem 0;
		background: var(--bg);
		border-bottom: 1px solid var(--border);
	}
	/* The links flow like words (inline blocks), so a group breaks across rows where it must.
	   No font size here: the white space between the blocks would add to the gaps. */
	.flow {
		position: relative;
		font-size: 0;
		line-height: 0;
	}
	.nav-h,
	.item {
		display: inline-block;
		vertical-align: top;
		margin: 0.15rem var(--gap) 0.15rem 0;
	}
	.nav-h {
		line-height: 30px;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.groups,
	.group,
	.group > ul {
		display: inline;
	}
	/* A group's name, before its first link (groupNames): the two sit in one item, so they wrap as one. */
	.item {
		display: inline-flex;
		align-items: center;
	}
	.grp-h {
		margin-inline-end: var(--gap);
		font-size: 0.75rem;
		font-weight: 600;
		line-height: 30px;
		color: var(--text-muted);
		white-space: nowrap;
	}
	/* A wider gap sets a group off from the one before it. */
	.item.group-start {
		margin-inline-start: calc(var(--group-gap) - var(--gap));
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 30px;
		padding: 0 0.6rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		font: inherit;
		font-size: 0.8rem;
		line-height: 1.2;
		color: var(--text-2);
		text-decoration: none;
		white-space: nowrap;
	}
	a.pill:hover,
	.more-btn:hover {
		border-color: var(--accent);
		color: var(--accent);
	}
	.more-btn {
		cursor: pointer;
	}
	a.pill[aria-current='location'],
	.pill.marked,
	.more-btn.current {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 600;
	}
	.dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: var(--danger);
	}
	.pop {
		position: absolute;
		right: 0;
		top: calc(100% + 0.3rem);
		z-index: 20;
		width: min(18rem, 100%);
		max-height: min(60vh, 28rem);
		overflow-y: auto;
		padding: 0.3rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.14);
		font-size: 0.9rem;
		line-height: 1.3;
	}
	.pop-h {
		margin: 0.4rem 0.6rem 0.15rem;
		font-size: 0.72rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}
	.pop a {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 36px;
		padding: 0.4rem 0.6rem;
		border-radius: var(--radius-sm);
		color: var(--text);
		text-decoration: none;
	}
	.pop a:hover {
		background: var(--surface-2);
	}
	.pop a[aria-current='location'] {
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 600;
	}
	.measure {
		position: absolute;
		top: 0;
		left: 0;
		width: 0;
		height: 0;
		overflow: hidden;
		visibility: hidden;
		white-space: nowrap;
	}
	.measure > * {
		display: inline-flex;
	}
	/* Phones: one row that scrolls sideways inside the bar, never the page; no More. */
	@media (max-width: 640px) {
		.sections {
			padding: 0.45rem 0;
		}
		.nav-h {
			display: none;
		}
		.flow {
			white-space: nowrap;
			overflow-x: auto;
			scrollbar-width: none;
		}
		.item {
			margin-block: 0;
		}
		.pill {
			min-height: 36px;
		}
		.grp-h {
			line-height: 36px;
		}
	}
</style>
