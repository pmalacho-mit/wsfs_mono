<script lang="ts">
	import { cn } from "../../../../../../wsfs_svelte_suede/frontend/shadcn/ui-utils";

	interface Props {
		class?: string;
		children?: import("svelte").Snippet;
	}

	let { class: className, children, ...props }: Props = $props();
	// indexing
</script>

<div
	class={cn("flex items-center gap-1", "[&_button:first-child]:rounded-bl-xl", className)}
	{...props}
>
	{#if children}
		{@render children()}
	{/if}
</div>
