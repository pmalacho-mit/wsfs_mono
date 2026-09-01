<script lang="ts">
	import { cn } from "../../../ui-utils";
	import * as DropdownMenu from "../../../ui/dropdown-menu/index";

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
