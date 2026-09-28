<!-- The validation tests of Fit automatically, over eight example water
     years: which years each test fits on and which it scores.
     Styles: ../Diagram.svelte. -->
<svg
	viewBox="0 0 720 310"
	role="img"
	aria-label="Eight example water years, with their mean observed flow: years 2, 4, 5 and 7 are wet, years 1, 3, 6 and 8 dry. The in-sample fit fits and scores all eight years. The split-sample test fits on years 1 to 4 and tests on years 5 to 8. The dry to wet test fits on the four driest years, 1, 3, 6 and 8, and tests on the four wettest, 2, 4, 5 and 7, which interleave with them. The other-record test scores the fitted parameters against a second instrument's record."
>
	<text class="m lbl" x="20" y="56">mean observed flow<tspan x="20" dy="14">per water year</tspan></text>
	<rect class="bar" x="204" y="66" width="30" height="24" rx="2" />
	<text class="m lbl" x="219" y="106" text-anchor="middle">WY 1</text>
	<rect class="bar" x="268" y="38" width="30" height="52" rx="2" />
	<text class="m lbl" x="283" y="106" text-anchor="middle">WY 2</text>
	<rect class="bar" x="332" y="72" width="30" height="18" rx="2" />
	<text class="m lbl" x="347" y="106" text-anchor="middle">WY 3</text>
	<rect class="bar" x="396" y="46" width="30" height="44" rx="2" />
	<text class="m lbl" x="411" y="106" text-anchor="middle">WY 4</text>
	<rect class="bar" x="460" y="26" width="30" height="64" rx="2" />
	<text class="m lbl" x="475" y="106" text-anchor="middle">WY 5</text>
	<rect class="bar" x="524" y="76" width="30" height="14" rx="2" />
	<text class="m lbl" x="539" y="106" text-anchor="middle">WY 6</text>
	<rect class="bar" x="588" y="50" width="30" height="40" rx="2" />
	<text class="m lbl" x="603" y="106" text-anchor="middle">WY 7</text>
	<rect class="bar" x="652" y="68" width="30" height="22" rx="2" />
	<text class="m lbl" x="667" y="106" text-anchor="middle">WY 8</text>

	<text class="t lbl" x="20" y="141">In-sample fit</text>
	<rect class="box fit" x="190" y="122" width="58" height="28" rx="4" />
	<text class="s" x="219" y="140" text-anchor="middle">fit</text>
	<rect class="box fit" x="254" y="122" width="58" height="28" rx="4" />
	<text class="s" x="283" y="140" text-anchor="middle">fit</text>
	<rect class="box fit" x="318" y="122" width="58" height="28" rx="4" />
	<text class="s" x="347" y="140" text-anchor="middle">fit</text>
	<rect class="box fit" x="382" y="122" width="58" height="28" rx="4" />
	<text class="s" x="411" y="140" text-anchor="middle">fit</text>
	<rect class="box fit" x="446" y="122" width="58" height="28" rx="4" />
	<text class="s" x="475" y="140" text-anchor="middle">fit</text>
	<rect class="box fit" x="510" y="122" width="58" height="28" rx="4" />
	<text class="s" x="539" y="140" text-anchor="middle">fit</text>
	<rect class="box fit" x="574" y="122" width="58" height="28" rx="4" />
	<text class="s" x="603" y="140" text-anchor="middle">fit</text>
	<rect class="box fit" x="638" y="122" width="58" height="28" rx="4" />
	<text class="s" x="667" y="140" text-anchor="middle">fit</text>

	<text class="t lbl" x="20" y="181">Split-sample</text>
	<rect class="box fit" x="190" y="162" width="58" height="28" rx="4" />
	<text class="s" x="219" y="180" text-anchor="middle">fit</text>
	<rect class="box fit" x="254" y="162" width="58" height="28" rx="4" />
	<text class="s" x="283" y="180" text-anchor="middle">fit</text>
	<rect class="box fit" x="318" y="162" width="58" height="28" rx="4" />
	<text class="s" x="347" y="180" text-anchor="middle">fit</text>
	<rect class="box fit" x="382" y="162" width="58" height="28" rx="4" />
	<text class="s" x="411" y="180" text-anchor="middle">fit</text>
	<rect class="box test" x="446" y="162" width="58" height="28" rx="4" />
	<text class="s" x="475" y="180" text-anchor="middle">test</text>
	<rect class="box test" x="510" y="162" width="58" height="28" rx="4" />
	<text class="s" x="539" y="180" text-anchor="middle">test</text>
	<rect class="box test" x="574" y="162" width="58" height="28" rx="4" />
	<text class="s" x="603" y="180" text-anchor="middle">test</text>
	<rect class="box test" x="638" y="162" width="58" height="28" rx="4" />
	<text class="s" x="667" y="180" text-anchor="middle">test</text>

	<text class="t lbl" x="20" y="221">Dry → wet</text>
	<rect class="box fit" x="190" y="202" width="58" height="28" rx="4" />
	<text class="s" x="219" y="220" text-anchor="middle">fit</text>
	<rect class="box test" x="254" y="202" width="58" height="28" rx="4" />
	<text class="s" x="283" y="220" text-anchor="middle">test</text>
	<rect class="box fit" x="318" y="202" width="58" height="28" rx="4" />
	<text class="s" x="347" y="220" text-anchor="middle">fit</text>
	<rect class="box test" x="382" y="202" width="58" height="28" rx="4" />
	<text class="s" x="411" y="220" text-anchor="middle">test</text>
	<rect class="box test" x="446" y="202" width="58" height="28" rx="4" />
	<text class="s" x="475" y="220" text-anchor="middle">test</text>
	<rect class="box fit" x="510" y="202" width="58" height="28" rx="4" />
	<text class="s" x="539" y="220" text-anchor="middle">fit</text>
	<rect class="box test" x="574" y="202" width="58" height="28" rx="4" />
	<text class="s" x="603" y="220" text-anchor="middle">test</text>
	<rect class="box fit" x="638" y="202" width="58" height="28" rx="4" />
	<text class="s" x="667" y="220" text-anchor="middle">fit</text>

	<text class="t lbl" x="20" y="261">Other record</text>
	<rect class="box test" x="190" y="242" width="58" height="28" rx="4" />
	<text class="s" x="219" y="260" text-anchor="middle">test</text>
	<rect class="box test" x="254" y="242" width="58" height="28" rx="4" />
	<text class="s" x="283" y="260" text-anchor="middle">test</text>
	<rect class="box test" x="318" y="242" width="58" height="28" rx="4" />
	<text class="s" x="347" y="260" text-anchor="middle">test</text>
	<rect class="box test" x="382" y="242" width="58" height="28" rx="4" />
	<text class="s" x="411" y="260" text-anchor="middle">test</text>
	<rect class="box test" x="446" y="242" width="58" height="28" rx="4" />
	<text class="s" x="475" y="260" text-anchor="middle">test</text>
	<rect class="box test" x="510" y="242" width="58" height="28" rx="4" />
	<text class="s" x="539" y="260" text-anchor="middle">test</text>
	<rect class="box test" x="574" y="242" width="58" height="28" rx="4" />
	<text class="s" x="603" y="260" text-anchor="middle">test</text>
	<rect class="box test" x="638" y="242" width="58" height="28" rx="4" />
	<text class="s" x="667" y="260" text-anchor="middle">test</text>

	<rect class="box fit" x="190" y="284" width="22" height="14" rx="3" />
	<text class="s lbl" x="218" y="295">fitted on</text>
	<rect class="box test" x="300" y="284" width="22" height="14" rx="3" />
	<text class="s lbl" x="328" y="295">scored on, never seen by the fit</text>
</svg>
