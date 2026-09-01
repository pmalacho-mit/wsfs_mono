<script lang="ts">
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import { modeStorageKey, resetMode, userPrefersMode } from "mode-watcher";
  import ModeToggle from "../../../../../release/frontend/svelte/shell/ModeToggle.svelte";

  const remembered = () => localStorage.getItem(modeStorageKey.current);
  const painted = () => document.documentElement.classList.contains("dark");
  const machinePrefersDark = () =>
    window.matchMedia("(prefers-color-scheme: dark)").matches;

  /**
   * The menu that is open, rather than whichever items happen to be in the
   * document -- a portal leaves them there, and this file has two toggles.
   */
  /**
   * The menu that just opened. The one before it is still in the document
   * while it animates away, and its items answer to nobody.
   */
  const opened = () =>
    [...document.querySelectorAll("[data-slot='dropdown-menu-content']")]
      .filter((menu) => (menu as HTMLElement).checkVisibility())
      .at(-1);

  const choose = (label: string) =>
    [...(opened()?.querySelectorAll("[role='menuitem']") ?? [])].find(
      (item) => item.textContent?.trim() === label,
    ) as HTMLElement | undefined;

  /**
   * Nothing is carried between the body and the vest here -- these are
   * capture tests, and what they assert is on screen. It is declared anyway
   * because an untyped vest leaves `Sweater` unable to tell a test from a
   * config block.
   */
  class Pocket {}
</script>

<Sweater config category="ModeToggle" mode="serial" />

<Sweater
  name="follows the machine until somebody says otherwise"
  body={async ({ expect, capture, delay }) => {
    resetMode();
    await delay({ frames: 2 });

    expect(userPrefersMode.current).toBe("system");
    expect(remembered()).toBe("system");
    expect(painted()).toBe(machinePrefersDark());
    capture("png");
  }}
>
  {#snippet vest(_pocket: Pocket)}
    <div class="bg-background flex w-24 justify-center p-3">
      <ModeToggle />
    </div>
  {/snippet}
</Sweater>

<Sweater
  name="an override is remembered, and undone by choosing System again"
  body={async ({ container, expect, delay, note, withUserFocus, onAbort }) => {
    onAbort(resetMode);
    await delay({ frames: 2 });
    const trigger = container.querySelector(
      "[data-region='mode-toggle']",
    ) as HTMLElement;

    const pick = async (label: string) => {
      await withUserFocus(async (user) => {
        await user.click(trigger);
      });
      await delay({ milliseconds: 400 });
      const item = choose(label);
      note(`${label}: ${item === undefined ? "no such menu item" : "found"}`);
      expect(item).toBeDefined();
      await withUserFocus(async (user) => {
        await user.click(item!);
      });
      await delay({ milliseconds: 400 });
    };

    await pick("Dark");
    expect(remembered()).toBe("dark");
    expect(painted()).toBe(true);

    await pick("System");
    expect(remembered()).toBe("system");
    expect(painted()).toBe(machinePrefersDark());
  }}
>
  {#snippet vest(_pocket: Pocket)}
    <div class="bg-background flex w-24 justify-center p-3">
      <ModeToggle />
    </div>
  {/snippet}
</Sweater>
