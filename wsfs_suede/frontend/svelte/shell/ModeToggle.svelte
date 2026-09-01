<script lang="ts">
  /**
   * Light, dark, or whatever the machine says.
   *
   * Three choices rather than a flip, because "follow the system" is a state
   * a person can want back once they have left it, and a two-way switch has
   * no way to say it.
   */
  import { resetMode, setMode, userPrefersMode } from "mode-watcher";
  import MonitorIcon from "@lucide/svelte/icons/monitor";
  import MoonIcon from "@lucide/svelte/icons/moon";
  import SunIcon from "@lucide/svelte/icons/sun";
  import { Button } from "../shadcn/ui/button";
  import * as DropdownMenu from "../shadcn/ui/dropdown-menu";

  const choices = [
    { mode: "light", label: "Light", icon: SunIcon, choose: () => setMode("light") },
    { mode: "dark", label: "Dark", icon: MoonIcon, choose: () => setMode("dark") },
    { mode: "system", label: "System", icon: MonitorIcon, choose: () => resetMode() },
  ] as const;

  const chosen = $derived(
    choices.find(({ mode }) => mode === userPrefersMode.current) ?? choices[2],
  );
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="icon-sm"
        aria-label="Appearance"
        data-region="mode-toggle"
        data-mode={chosen.mode}
      >
        <chosen.icon />
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="min-w-36">
    {#each choices as choice (choice.mode)}
      <DropdownMenu.Item onSelect={choice.choose} data-checked={choice === chosen}>
        <choice.icon class="size-4" />
        {choice.label}
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
