<script lang="ts">
	import { Streamdown, type StreamdownProps } from "streamdown-svelte";
	// import { code } from "@streamdown-svelte/code";
	// import { mermaid } from '@streamdown-svelte/mermaid';
	// import { cjk } from '@streamdown-svelte/cjk';

	/**
	 * MATH, EVERYWHERE MARKDOWN IS DRAWN.
	 *
	 * This component is the one that actually draws it -- the problem above a
	 * file, the tutor's replies, and each branch of an edited turn all arrive
	 * here -- so turning math on here turns it on for all three at once, which
	 * is the only setting worth having. A problem statement that poses the
	 * question and a reply that works through it have to set the same
	 * expression the same way, or the reply reads as though it is answering
	 * something else.
	 *
	 * `$$...$$` for display, `$...$` for inline. Only those two -- this
	 * renderer's tokenizer has no rule for `\(...\)` or `\[...\]`, so those
	 * arrive as literal backslashes and are worth knowing not to type.
	 *
	 * SINGLE `$` IS ON, which is not the library's default and is the point of
	 * passing options at all. It is what everyone who has written LaTeX
	 * already types, and leaving it off would have most authored inline math
	 * render as plain text with the dollars showing -- indistinguishable, to
	 * whoever wrote it, from math being broken.
	 *
	 * The cost is the obvious one: "it cost $5 and then $6" reads as a
	 * formula. The tokenizer guards that case specifically -- it declines a
	 * span that looks like a price, a range, or a number sitting near words
	 * like "cost" or "dollar" -- which is what makes the trade worth taking
	 * rather than a coin flip. Prose that needs a literal dollar and defeats
	 * the guard escapes it as `\$`.
	 *
	 * Bad LaTeX does not throw: `Math.svelte` renders with `throwOnError:
	 * false`, so a mistyped expression shows in the error colour and the rest
	 * of the answer still draws.
	 *
	 * THE ERROR COLOUR IS SET HERE because it cannot be set anywhere else.
	 * KaTeX writes it as an inline `style` on the failed span, which no
	 * stylesheet outranks without `!important`, and its default `#cc0000` is a
	 * red chosen against white -- on the dark theme it goes muddy against the
	 * background. Handing it the theme's own token means the one thing a
	 * reader sees when a formula is wrong looks like the rest of the app being
	 * wrong, rather than like something bled through from another page.
	 */
	import { createMathPlugin } from "@streamdown-svelte/math";
	import "katex/dist/katex.min.css";

	const math = createMathPlugin({
		singleDollarTextMath: true,
		errorColor: "var(--destructive)",
	});

	import { mode } from "mode-watcher";
	import githubDarkDefault from "@shikijs/themes/github-dark-default";
	import githubLightDefault from "@shikijs/themes/github-light-default";
	import { cn } from "../../../ui-utils";
	type Props = StreamdownProps;

	let { content, class: className, ...rest }: Props = $props();
	let currentTheme = $derived(
		mode.current === "dark" ? "github-dark-default" : "github-light-default"
	);
</script>

<div class={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}>
	<Streamdown
		{content}
		baseTheme="shadcn"
		shikiTheme={currentTheme}
		shikiThemes={{
			"github-light-default": githubLightDefault,
			"github-dark-default": githubDarkDefault,
		}}
		plugins={{ math }}
		{...rest}
	/>
</div>
