<script lang="ts">
	import { cn } from "../../../../../../wsfs_svelte_suede/frontend/shadcn/ui-utils";
	import * as DropdownMenu from "../../../../../../wsfs_svelte_suede/frontend/shadcn/ui/dropdown-menu/index";

	interface Props {
		class?: string;
		children?: import("svelte").Snippet;
	}

	let { class: className, children, ...props }: Props = $props();
</script>

<DropdownMenu.Content preventScroll={false} align="start" class={cn(className)} {...props}>
	{#if children}
		{@render children()}
	{/if}
</DropdownMenu.Content>
