<script lang="ts">
	import * as DropdownMenu from "../../../../../../wsfs_svelte_suede/frontend/shadcn/ui/dropdown-menu/index";

	interface Props {
		open?: boolean;
		children?: import("svelte").Snippet;
	}

	let { open = $bindable(false), children, ...props }: Props = $props();
</script>

<DropdownMenu.Root bind:open {...props}>
	{#if children}
		{@render children()}
	{/if}
</DropdownMenu.Root>
