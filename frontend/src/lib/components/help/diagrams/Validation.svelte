<!-- The validation tests of Fit automatically, over eight example water
     years: which years each test fits on and which it scores. 660 wide, so
     it fits the guide's column whole from 1280 px.
     Styles: ../Diagram.svelte. -->
<svg
	viewBox="0 0 660 310"
	role="img"
	aria-label="Eight example water years, with their mean observed flow: years 2, 4, 5 and 7 are wet, years 1, 3, 6 and 8 dry. The in-sample fit fits and scores all eight years. The split-sample test fits on years 1 to 4 and tests on years 5 to 8. The dry to wet test fits on the four driest years, 1, 3, 6 and 8, and tests on the four wettest, 2, 4, 5 and 7, which interleave with them. The other-record test scores the fitted parameters against a second instrument's record."
>
	<text class="m lbl" x="10" y="56">mean observed flow<tspan x="10" dy="14">per water year</tspan></text>
	<rect class="bar" x="163" y="66" width="30" height="24" rx="2" />
	<text class="m lbl" x="178" y="106" text-anchor="middle">WY 1</text>
	<rect class="bar" x="225" y="38" width="30" height="52" rx="2" />
	<text class="m lbl" x="240" y="106" text-anchor="middle">WY 2</text>
	<rect class="bar" x="287" y="72" width="30" height="18" rx="2" />
	<text class="m lbl" x="302" y="106" text-anchor="middle">WY 3</text>
	<rect class="bar" x="349" y="46" width="30" height="44" rx="2" />
	<text class="m lbl" x="364" y="106" text-anchor="middle">WY 4</text>
	<rect class="bar" x="411" y="26" width="30" height="64" rx="2" />
	<text class="m lbl" x="426" y="106" text-anchor="middle">WY 5</text>
	<rect class="bar" x="473" y="76" width="30" height="14" rx="2" />
	<text class="m lbl" x="488" y="106" text-anchor="middle">WY 6</text>
	<rect class="bar" x="535" y="50" width="30" height="40" rx="2" />
	<text class="m lbl" x="550" y="106" text-anchor="middle">WY 7</text>
	<rect class="bar" x="597" y="68" width="30" height="22" rx="2" />
	<text class="m lbl" x="612" y="106" text-anchor="middle">WY 8</text>

	<text class="t lbl" x="10" y="141">In-sample fit</text>
	<rect class="box fit" x="150" y="122" width="56" height="28" rx="4" />
	<text class="s" x="178" y="140" text-anchor="middle">fit</text>
	<rect class="box fit" x="212" y="122" width="56" height="28" rx="4" />
	<text class="s" x="240" y="140" text-anchor="middle">fit</text>
	<rect class="box fit" x="274" y="122" width="56" height="28" rx="4" />
	<text class="s" x="302" y="140" text-anchor="middle">fit</text>
	<rect class="box fit" x="336" y="122" width="56" height="28" rx="4" />
	<text class="s" x="364" y="140" text-anchor="middle">fit</text>
	<rect class="box fit" x="398" y="122" width="56" height="28" rx="4" />
	<text class="s" x="426" y="140" text-anchor="middle">fit</text>
	<rect class="box fit" x="460" y="122" width="56" height="28" rx="4" />
	<text class="s" x="488" y="140" text-anchor="middle">fit</text>
	<rect class="box fit" x="522" y="122" width="56" height="28" rx="4" />
	<text class="s" x="550" y="140" text-anchor="middle">fit</text>
	<rect class="box fit" x="584" y="122" width="56" height="28" rx="4" />
	<text class="s" x="612" y="140" text-anchor="middle">fit</text>

	<text class="t lbl" x="10" y="181">Split-sample</text>
	<rect class="box fit" x="150" y="162" width="56" height="28" rx="4" />
	<text class="s" x="178" y="180" text-anchor="middle">fit</text>
	<rect class="box fit" x="212" y="162" width="56" height="28" rx="4" />
	<text class="s" x="240" y="180" text-anchor="middle">fit</text>
	<rect class="box fit" x="274" y="162" width="56" height="28" rx="4" />
	<text class="s" x="302" y="180" text-anchor="middle">fit</text>
	<rect class="box fit" x="336" y="162" width="56" height="28" rx="4" />
	<text class="s" x="364" y="180" text-anchor="middle">fit</text>
	<rect class="box test" x="398" y="162" width="56" height="28" rx="4" />
	<text class="s" x="426" y="180" text-anchor="middle">test</text>
	<rect class="box test" x="460" y="162" width="56" height="28" rx="4" />
	<text class="s" x="488" y="180" text-anchor="middle">test</text>
	<rect class="box test" x="522" y="162" width="56" height="28" rx="4" />
	<text class="s" x="550" y="180" text-anchor="middle">test</text>
	<rect class="box test" x="584" y="162" width="56" height="28" rx="4" />
	<text class="s" x="612" y="180" text-anchor="middle">test</text>

	<text class="t lbl" x="10" y="221">Dry → wet</text>
	<rect class="box fit" x="150" y="202" width="56" height="28" rx="4" />
	<text class="s" x="178" y="220" text-anchor="middle">fit</text>
	<rect class="box test" x="212" y="202" width="56" height="28" rx="4" />
	<text class="s" x="240" y="220" text-anchor="middle">test</text>
	<rect class="box fit" x="274" y="202" width="56" height="28" rx="4" />
	<text class="s" x="302" y="220" text-anchor="middle">fit</text>
	<rect class="box test" x="336" y="202" width="56" height="28" rx="4" />
	<text class="s" x="364" y="220" text-anchor="middle">test</text>
	<rect class="box test" x="398" y="202" width="56" height="28" rx="4" />
	<text class="s" x="426" y="220" text-anchor="middle">test</text>
	<rect class="box fit" x="460" y="202" width="56" height="28" rx="4" />
	<text class="s" x="488" y="220" text-anchor="middle">fit</text>
	<rect class="box test" x="522" y="202" width="56" height="28" rx="4" />
	<text class="s" x="550" y="220" text-anchor="middle">test</text>
	<rect class="box fit" x="584" y="202" width="56" height="28" rx="4" />
	<text class="s" x="612" y="220" text-anchor="middle">fit</text>

	<text class="t lbl" x="10" y="261">Other record</text>
	<rect class="box test" x="150" y="242" width="56" height="28" rx="4" />
	<text class="s" x="178" y="260" text-anchor="middle">test</text>
	<rect class="box test" x="212" y="242" width="56" height="28" rx="4" />
	<text class="s" x="240" y="260" text-anchor="middle">test</text>
	<rect class="box test" x="274" y="242" width="56" height="28" rx="4" />
	<text class="s" x="302" y="260" text-anchor="middle">test</text>
	<rect class="box test" x="336" y="242" width="56" height="28" rx="4" />
	<text class="s" x="364" y="260" text-anchor="middle">test</text>
	<rect class="box test" x="398" y="242" width="56" height="28" rx="4" />
	<text class="s" x="426" y="260" text-anchor="middle">test</text>
	<rect class="box test" x="460" y="242" width="56" height="28" rx="4" />
	<text class="s" x="488" y="260" text-anchor="middle">test</text>
	<rect class="box test" x="522" y="242" width="56" height="28" rx="4" />
	<text class="s" x="550" y="260" text-anchor="middle">test</text>
	<rect class="box test" x="584" y="242" width="56" height="28" rx="4" />
	<text class="s" x="612" y="260" text-anchor="middle">test</text>

	<rect class="box fit" x="150" y="284" width="22" height="14" rx="3" />
	<text class="s lbl" x="178" y="295">fitted on</text>
	<rect class="box test" x="260" y="284" width="22" height="14" rx="3" />
	<text class="s lbl" x="288" y="295">scored on, never seen by the fit</text>
</svg>
