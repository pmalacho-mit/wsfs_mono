<script lang="ts">
	import { cn } from "../../../../../../wsfs_svelte_suede/frontend/shadcn/ui-utils";
	import { Button } from "../../../../../../wsfs_svelte_suede/frontend/shadcn/ui/button";
	import type { ButtonProps } from "../../../../../../wsfs_svelte_suede/frontend/shadcn/ui/button/index";

	interface Props extends ButtonProps {
		class?: string;
		children?: import("svelte").Snippet;
	}

	let { variant = "ghost", class: className, size, children, ...props }: Props = $props();

	let hasMultipleChildren = $derived.by(() => {
		// In Svelte, we can't easily count children like in React, so we'll default to checking if size is provided
		return size !== undefined;
	});

	let newSize = $derived.by((): "default" | "sm" | "lg" | "icon" => {
		return (size ?? hasMultipleChildren) ? "default" : "icon";
	});
	// indexing
</script>

<Button
	class={cn(
		"shrink-0 gap-1.5 rounded-lg",
		variant === "ghost" && "text-muted-foreground",
		newSize === "default" && "px-3",
		className
	)}
	size={newSize}
	type="button"
	{variant}
	{...props}
>
	{#if children}
		{@render children()}
	{/if}
</Button>
