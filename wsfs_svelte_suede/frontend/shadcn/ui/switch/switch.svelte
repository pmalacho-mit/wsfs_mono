<script lang="ts">
  import { Switch as SwitchPrimitive } from "bits-ui";
  import { cn } from "../../ui-utils.js";

  let {
    ref = $bindable(null),
    checked = $bindable(false),
    class: className,
    "data-slot": dataSlot = "switch",
    ...restProps
  }: SwitchPrimitive.RootProps = $props();
</script>

<SwitchPrimitive.Root
  bind:ref
  bind:checked
  data-slot={dataSlot}
  class={cn(
    "peer focus-visible:border-ring focus-visible:ring-ring/50 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50",
    "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
    className,
  )}
  {...restProps}
>
  {#snippet children()}
    <SwitchPrimitive.Thumb
      data-slot="switch-thumb"
      class={cn(
        "bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground pointer-events-none block size-4 rounded-full ring-0 transition-transform",
        "data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0",
      )}
    />
  {/snippet}
</SwitchPrimitive.Root>
