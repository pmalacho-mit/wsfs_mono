<script lang="ts">
	import { ScrollArea } from "../../../../../wsfs_svelte_suede/frontend/shadcn/ui/scroll-area/index";
	import { cn } from "../../../../../wsfs_svelte_suede/frontend/shadcn/ui-utils";
	import type { Snippet } from "svelte";

	interface Props {
		children?: Snippet;
		class?: string;
		orientation?: "vertical" | "horizontal" | "both";
		scrollbarXClasses?: string;
		scrollbarYClasses?: string;
	}

	let {
		children,
		class: className,
		orientation = "horizontal",
		scrollbarXClasses,
		scrollbarYClasses,
		...restProps
	}: Props = $props();
</script>

<ScrollArea
	{orientation}
	{scrollbarXClasses}
	{scrollbarYClasses}
	class="w-full whitespace-nowrap"
	{...restProps}
>
	<div class={cn("flex w-max flex-nowrap items-center gap-2", className)}>
		{@render children?.()}
	</div>
</ScrollArea>
