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

	The rail (issue #468): given the page's content as `children` and `railFrom`
	(rem), from that content width the menu is a sticky column on the left
	instead, every group's name shown as a heading over its links, and the
	arrow keys move between its links; narrower it is the bar above. `find`
	adds a box that narrows the menu to the sections and the settings inside
	them (labels, legends, sub-headings, table rows) whose names match, and
	jumps to the setting itself: at the rail's top, or behind a Find button at
	the bar's start.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { activeSectionId, findEntries, navFitCount, type FindEntry, type NavGroup, type NavSection } from './sectionNav';

	let {
		groups,
		label,
		groupNames = false,
		railFrom,
		layout = $bindable('bar'),
		find,
		children
	}: {
		groups: NavGroup[];
		label: string;
		/** Show each group's name on the bar, before its first link (a small muted label). */
		groupNames?: boolean;
		/** From this content width (rem) the menu is a side rail; needs `children`. */
		railFrom?: number;
		/** The layout drawn now, for a page whose links differ between the two. */
		layout?: 'bar' | 'rail';
		/** A find box: its label ("Find a setting"). */
		find?: string;
		/** The page's content, laid out beside the rail (or under the bar). */
		children?: Snippet;
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
	/** The sections on this page (a link to another page is never the one being read). */
	const local = $derived(flat.filter((s) => !s.href));
	let height = $state(0);
	let wrapWidth = $state(0);
	let activeSection = $state<string | null>(null);
	let flowEl = $state<HTMLDivElement>();
	let measureEl = $state<HTMLDivElement>();
	let phone = $state(false);
	/** How many links stay on the bar; the rest are in More. */
	let kept = $state(Number.POSITIVE_INFINITY);
	let moreOpen = $state(false);
	let moreWrap = $state<HTMLElement>();
	let moreBtn = $state<HTMLButtonElement>();
	let findOpen = $state(false);
	let findWrap = $state<HTMLElement>();
	let findBtn = $state<HTMLButtonElement>();
	let findInput = $state<HTMLInputElement>();
	let query = $state('');
	let railEl = $state<HTMLElement>();

	const rail = $derived(!!railFrom && !!children && wrapWidth > 0 && wrapWidth >= railFrom * rootRem());
	$effect(() => {
		layout = rail ? 'rail' : 'bar';
	});
	function rootRem() {
		return typeof document === 'undefined' ? 14 : parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;
	}
	const hrefOf = (sec: NavSection) => sec.href ?? `#${sec.id}`;

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
	const overflow = $derived(!rail && !phone && kept < flat.length);
	const currentInMore = $derived(overflow && flat.slice(kept).some((s) => s.id === activeSection));

	// The find box's list: the sections and the settings inside them whose names match. The
	// settings are read from the page when the query changes (labels, legends, sub-headings and
	// table rows), so the list follows what is drawn; the elements are kept to jump to.
	let scanned: { sectionId: string; text: string; el: HTMLElement }[] = [];
	function scan() {
		const out: typeof scanned = [];
		for (const sec of local) {
			for (const id of [sec.id, ...(sec.covers ?? [])]) {
				const root = document.getElementById(id);
				if (!root) continue;
				for (const el of root.querySelectorAll<HTMLElement>('h2, h3, legend, label, th[scope="row"]')) {
					if (el.closest('dialog, [inert], [aria-hidden="true"]')) continue;
					const copy = el.cloneNode(true) as HTMLElement;
					copy.querySelectorAll('.helptip, .visually-hidden, select, input, textarea, button').forEach((n) => n.remove());
					const text = (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
					if (text && text.length <= 90) out.push({ sectionId: sec.id, text, el });
				}
			}
		}
		return out;
	}
	const results = $derived.by((): FindEntry[] => {
		if (!find || !query.trim()) return [];
		scanned = scan();
		return findEntries(local, scanned, query);
	});
	const sectionLabel = (id: string) => flat.find((s) => s.id === id)?.label ?? '';

	/** Goes to a setting: opens what folds it away, brings it to the middle of the window and focuses its control. */
	function jump(entry: FindEntry) {
		const el = scanned[entry.index]?.el;
		if (!el || !el.isConnected) return;
		for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true;
		let target: HTMLElement | null = null;
		if (el instanceof HTMLLabelElement) target = el.control as HTMLElement | null;
		else if (el.tagName === 'LEGEND') target = el.parentElement?.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea') ?? null;
		else if (el.tagName === 'TH') target = el.closest('tr')?.querySelector<HTMLElement>('input, select, textarea') ?? null;
		const focusEl = target && !(target as HTMLInputElement).disabled ? target : el;
		if (focusEl === el && !el.hasAttribute('tabindex')) el.tabIndex = -1;
		(target ?? el).scrollIntoView({ block: 'center' });
		focusEl.focus({ preventScroll: true });
		findOpen = false;
	}
	function findKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			// Not on to the list's own handler too, which would then move one further.
			e.stopPropagation();
			focusItems()[0]?.focus();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const first = results[0];
			if (!first) return;
			if (first.index >= 0) jump(first);
			else {
				findOpen = false;
				location.hash = first.sectionId;
			}
		} else if (e.key === 'Escape' && query && rail) {
			// In the rail Escape clears the box; in the bar's popover it closes the popover (findPopKeydown).
			e.preventDefault();
			e.stopPropagation();
			query = '';
		}
	}

	/** The rail's (or the find popover's) links and result buttons, for the arrow keys. */
	function focusItems(): HTMLElement[] {
		const root = rail ? railEl : findWrap;
		return root ? [...root.querySelectorAll<HTMLElement>('[data-item]')] : [];
	}
	function listKeydown(e: KeyboardEvent) {
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
		const items = focusItems();
		const i = items.indexOf(document.activeElement as HTMLElement);
		if (i < 0) return;
		e.preventDefault();
		const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : i + (e.key === 'ArrowDown' ? 1 : -1);
		if (next < 0 && find) findInput?.focus();
		else items[Math.max(0, Math.min(items.length - 1, next))]?.focus();
	}

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
		if (phone || rail) {
			kept = items.length;
			return;
		}
		if (!flowEl || !measureEl) return;
		const flow = flowEl;
		const copy = measureEl;
		const measure = () => {
			const rem = rootRem();
			const marked = [...copy.querySelectorAll<HTMLElement>('[data-m]')];
			const plain = [...copy.querySelectorAll<HTMLElement>('[data-p]')];
			const width = (el: Element | null | undefined) => el?.getBoundingClientRect().width ?? 0;
			const lead = width(copy.querySelector('.nav-h')) + (find ? width(copy.querySelector('[data-find]')) + GAP_REM * rem : 0);
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
	$effect(() => {
		if (rail) findOpen = false;
	});

	// More (and the find popover) close on Escape (focus back on its button), on a click outside,
	// when focus leaves it and when one of its links is followed.
	function moreKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !moreOpen) return;
		e.preventDefault();
		moreOpen = false;
		moreBtn?.focus();
	}
	function moreFocusOut(e: FocusEvent) {
		if (moreWrap && !moreWrap.contains(e.relatedTarget as Node | null)) moreOpen = false;
	}
	function findPopKeydown(e: KeyboardEvent) {
		listKeydown(e);
		if (e.key !== 'Escape' || !findOpen || e.defaultPrevented) return;
		e.preventDefault();
		findOpen = false;
		findBtn?.focus();
	}
	function findFocusOut(e: FocusEvent) {
		// Not when the focus goes to the setting a result jumped to: jump() closes it.
		if (findWrap && e.relatedTarget && !findWrap.contains(e.relatedTarget as Node)) findOpen = false;
	}
	$effect(() => {
		if (!moreOpen && !findOpen) return;
		const onDoc = (e: PointerEvent) => {
			if (moreWrap && !moreWrap.contains(e.target as Node)) moreOpen = false;
			if (findWrap && !findWrap.contains(e.target as Node)) findOpen = false;
		};
		document.addEventListener('pointerdown', onDoc);
		return () => document.removeEventListener('pointerdown', onDoc);
	});
	$effect(() => {
		if (findOpen) findInput?.focus();
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
	// The bar sits over the content's top, so jumps and focus keep clear of it; the rail sits beside it.
	$effect(() => {
		const root = document.documentElement;
		const header = parseFloat(getComputedStyle(root).getPropertyValue('--header-h')) || 0;
		root.style.scrollPaddingTop = `${header + (rail ? 0 : height) + 12}px`;
		return () => {
			root.style.scrollPaddingTop = '';
		};
	});
	$effect(() => {
		// Each section with the panels it stands for, in page order.
		const watched = local.flatMap((s) => [s.id, ...(s.covers ?? [])].map((el) => ({ el, id: s.id })));
		let frame = 0;
		// The URL's fragment, the section a followed link named (a malformed one names none).
		const fragment = () => {
			try {
				const id = decodeURIComponent(location.hash.slice(1)) || null;
				return id ? (watched.find((w) => w.el === id)?.id ?? id) : null;
			} catch {
				return null;
			}
		};
		const update = () => {
			frame = 0;
			const root = document.documentElement;
			// A section counts as reached once its top passes under the sticky menu.
			const line = (parseFloat(getComputedStyle(root).scrollPaddingTop) || 0) + 8;
			const tops = watched
				.flatMap(({ el, id }) => {
					const node = document.getElementById(el);
					return node ? [{ id, top: node.getBoundingClientRect().top }] : [];
				})
				.sort((a, b) => a.top - b.top);
			activeSection = activeSectionId(tops, line, window.innerHeight + window.scrollY >= root.scrollHeight - 2, fragment(), window.innerHeight);
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		update();
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		window.addEventListener('hashchange', schedule);
		// Panels open, close and load their charts late, which moves every later section.
		const grow = new ResizeObserver(schedule);
		grow.observe(document.body);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
			window.removeEventListener('hashchange', schedule);
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
{#snippet findText()}
	<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
	Find<span class="visually-hidden"> a setting</span>
{/snippet}

<!-- The find box and what it lists: in the rail, or in the bar's Find popover. -->
{#snippet findBox()}
	<div class="find">
		<label class="find-l" for="{uid}-find">{find}</label>
		<input
			id="{uid}-find"
			type="search"
			autocomplete="off"
			placeholder="Name of a setting"
			aria-describedby="{uid}-find-n"
			bind:value={query}
			bind:this={findInput}
			onkeydown={findKeydown}
		/>
		<p class="find-n" id="{uid}-find-n" role="status">
			{#if query.trim()}{results.length ? `${results.length} ${results.length === 1 ? 'match' : 'matches'}` : `No setting matches “${query.trim()}”`}{/if}
		</p>
	</div>
	{#if query.trim()}
		<ul class="results" aria-label="Matches">
			{#each results as r, i (i)}
				<li>
					{#if r.index < 0}
						<a data-item href="#{r.sectionId}" onclick={() => (findOpen = false)}>{r.text}</a>
					{:else}
						<button type="button" data-item onclick={() => jump(r)}>
							<span>{r.text}</span><span class="in"><span class="visually-hidden">{', in '}</span>{sectionLabel(r.sectionId)}</span>
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<!-- Without content of its own (the pages that keep the bar) the wrapper draws no box, so the bar sticks down the whole page. -->
<div class="nav-layout" class:rail class:bare={!children} bind:clientWidth={wrapWidth}>
	{#if rail}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions (the arrow keys move between its links) -->
		<nav class="rail-nav" aria-label={label} bind:this={railEl} onkeydown={listKeydown}>
			{#if find}{@render findBox()}{/if}
			{#if !query.trim()}
				{#each groups as g, gi (gi)}
					{#if g.sections.length}
						{#if g.label}<p class="rail-h" id="{uid}-r{gi}">{g.label}</p>{/if}
						<ul aria-labelledby={g.label ? `${uid}-r${gi}` : undefined}>
							{#each g.sections as sec (sec.id)}
								<li>
									<a
										data-item
										href={hrefOf(sec)}
										aria-current={!sec.href && sec.id === activeSection ? 'location' : undefined}
									>{@render linkText(sec)}{#if sec.href}<span class="ext" aria-hidden="true">↗</span>{/if}</a>
								</li>
							{/each}
						</ul>
					{/if}
				{/each}
			{/if}
		</nav>
	{:else}
		<nav class="sections" aria-label={label} bind:clientHeight={height} style:--bar-h="{height}px">
			<div class="flow" bind:this={flowEl}>
				{#if find}
					<div class="item find-wrap" bind:this={findWrap} onkeydown={findPopKeydown} onfocusout={findFocusOut} role="presentation">
						<button
							type="button"
							class="pill find-btn"
							aria-expanded={findOpen}
							aria-controls="{uid}-findpop"
							bind:this={findBtn}
							onclick={() => (findOpen = !findOpen)}
						>
							{@render findText()}
						</button>
						{#if findOpen}
							<div class="pop find-pop" id="{uid}-findpop">{@render findBox()}</div>
						{/if}
					</div>
				{/if}
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
											<a class="pill" href={hrefOf(sec)} aria-current={!sec.href && sec.id === activeSection ? 'location' : undefined}>{@render linkText(sec)}</a>
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
													<a href={hrefOf(sec)} aria-current={!sec.href && sec.id === activeSection ? 'location' : undefined} onclick={() => (moreOpen = false)}>{@render linkText(sec)}</a>
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
				{#if find}<button type="button" class="pill find-btn" tabindex="-1" data-find>{@render findText()}</button>{/if}
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
	{/if}
	{#if children}<div class="nav-body">{@render children()}</div>{/if}
</div>

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
	.more-btn:hover,
	.find-btn:hover {
		border-color: var(--accent);
		color: var(--accent);
	}
	.more-btn,
	.find-btn {
		cursor: pointer;
	}
	.find-btn[aria-expanded='true'] {
		border-color: var(--accent);
		color: var(--accent);
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
		flex: none;
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
	/* The find popover opens from the bar's start, under its button. */
	.find-wrap {
		position: static;
	}
	.find-pop {
		left: 0;
		right: auto;
		width: min(24rem, 100%);
		padding: 0.5rem;
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

	/* The rail: a sticky column beside the content, as tall as the window from where it sticks. */
	.nav-layout.rail {
		display: grid;
		grid-template-columns: 13rem minmax(0, 1fr);
		gap: 1.25rem;
		align-items: start;
	}
	.nav-layout.bare {
		display: contents;
	}
	.nav-body {
		min-width: 0;
	}
	.rail-nav {
		position: sticky;
		top: calc(var(--header-h) + 0.75rem);
		max-height: calc(100vh - var(--header-h) - var(--dock-h, 0px) - 1.5rem);
		/* Only for a window shorter than the rail's tallest state (playbook § 2): never the usual case. */
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0.15rem 0.15rem 0.5rem 0;
		font-size: 0.85rem;
		line-height: 1.25;
	}
	.rail-h {
		margin: 0.85rem 0 0.2rem;
		padding: 0 0.6rem;
		font-size: 0.72rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}
	.rail-nav a,
	.results a,
	.results button {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 100%;
		min-height: 28px;
		padding: 0.25rem 0.6rem;
		border: 0;
		border-left: 3px solid transparent;
		border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
		background: none;
		font: inherit;
		text-align: left;
		color: var(--text-2);
		text-decoration: none;
		cursor: pointer;
	}
	.rail-nav a:hover,
	.results a:hover,
	.results button:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.rail-nav a[aria-current='location'] {
		border-left-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 600;
	}
	.ext {
		color: var(--text-muted);
		font-size: 0.75rem;
	}
	.find {
		display: grid;
		gap: 0.25rem;
	}
	.find-l {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-2);
	}
	.find input {
		width: 100%;
		min-height: 32px;
		font-size: 0.85rem;
	}
	.find-n {
		margin: 0;
		min-height: 1em;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.results {
		margin-top: 0.15rem;
		font-size: 0.85rem;
		line-height: 1.25;
	}
	.results button {
		flex-direction: column;
		align-items: flex-start;
		gap: 0;
	}
	.results .in {
		font-size: 0.75rem;
		color: var(--text-muted);
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
		/* The strip scrolls (overflow clips a popover inside it), so on a phone the find box opens under the whole bar. */
		.find-pop {
			position: fixed;
			left: 0.75rem;
			right: 0.75rem;
			top: calc(var(--header-h) + var(--bar-h, 48px));
			width: auto;
			max-height: calc(100vh - var(--header-h) - var(--bar-h, 48px) - var(--dock-h, 0px) - 0.75rem);
			white-space: normal;
		}
		.results button,
		.results a {
			min-height: 36px;
		}
	}
</style>
