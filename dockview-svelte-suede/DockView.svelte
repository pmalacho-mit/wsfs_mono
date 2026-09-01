<script lang="ts" module>
  import {
    createDockview,
    DockviewGroupPanel,
    PROPERTY_KEYS_DOCKVIEW,
    type DockviewFrameworkOptions,
    type DockviewOptions,
    type IHeaderActionsRenderer,
  } from "dockview";
  import type { RecursivePartial } from "./utils/types.js";
  import {
    createExtendedAPI,
    extractCoreOptions,
    getComponentToMount,
    mappedDockviewOptionKeys,
    snippetIntoParams,
    type ITabContextMenuProps,
    type MappedDockviewOptionKey,
    type ComponentsConstraint,
    type CustomComponentConstraint,
    type CustomSnippetsConstraint,
    type DockviewSpecificComponentConstraint,
    type DockviewTabConstraint,
    type ModifiedProps,
    type SnippetsConstraint,
    type ViewAPI,
  } from "./utils/index.js";
  import SnippetRender from "./utils/SnippetRender.svelte";
  import {
    SvelteDockActionsHeaderRenderer,
    SvelteDockHeaderRenderer,
    SvelteWatermarkRenderer,
    SvelteDockComponentRenderer,
    SvelteTabGroupChipRenderer,
    SvelteGroupDragGhostRenderer,
    type OnTabContextMenu,
  } from "./dock/index.js";

  let dockCount = 0;

  type DockviewOptionKey = (typeof PROPERTY_KEYS_DOCKVIEW)[number];

  const isForwarded = (
    key: DockviewOptionKey,
  ): key is Exclude<DockviewOptionKey, MappedDockviewOptionKey> =>
    !(mappedDockviewOptionKeys as readonly string[]).includes(key);

  /** Every dockview option that is forwarded straight from props. */
  const forwardedOptionKeys = PROPERTY_KEYS_DOCKVIEW.filter(isForwarded);

  type Renderable<Props extends Record<string, any>> =
    | { component: CustomComponentConstraint<Props>[string] }
    | { snippet: CustomSnippetsConstraint<Props>[string] };

  /**
   * What to hand a renderer so it mounts `detail`, whichever of the two
   * shapes it was given. Snippets are mounted through `SnippetRender`.
   */
  const mountable = <Props extends Record<string, any>>(
    detail: Renderable<Props>,
    role: string
  ) => {
    if ("component" in detail)
      return {
        name: detail.component.name,
        svelteComponent: detail.component,
        propsPostProcessor: undefined,
      };

    if ("snippet" in detail)
      return {
        name: role,
        svelteComponent: SnippetRender as any,
        propsPostProcessor: snippetIntoParams(() => detail.snippet),
      };

    throw new Error(`The ${role} is neither a component nor a snippet`);
  };

  type GroupControlElementKey =
    | "leftHeaderActions"
    | "rightHeaderActions"
    | "prefixHeaderActions";

  type CreateGroupControlElement =
    | ((groupPanel: DockviewGroupPanel) => IHeaderActionsRenderer)
    | undefined;

  const createGroupControlElement = <Type extends GroupControlElementKey>(
    viewIndex: number,
    role: Type,
    detail?: DockviewSpecificComponentConstraint[Type]
  ): CreateGroupControlElement =>
    detail
      ? (groupPanel: DockviewGroupPanel) =>
          new SvelteDockActionsHeaderRenderer(groupPanel, {
            viewIndex,
            id: groupPanel.id,
            ...mountable(detail, role),
          })
      : undefined;

  /**
   * The chip labelling a tab group, and the ghost that follows the cursor
   * while a group is dragged. Both are dockview *options* rather than
   * framework options, which is why they are built here instead of forwarded.
   */
  const createTabGroupChip = (
    viewIndex: number,
    detail?: DockviewSpecificComponentConstraint["tabGroupChip"]
  ): DockviewOptions["createTabGroupChipComponent"] =>
    detail
      ? (tabGroup) =>
          new SvelteTabGroupChipRenderer({
            viewIndex,
            id: `tabGroupChip-${tabGroup.id}`,
            ...mountable(detail, "tabGroupChip"),
          })
      : undefined;

  const createGroupDragGhost = (
    viewIndex: number,
    detail?: DockviewSpecificComponentConstraint["groupDragGhost"]
  ): DockviewOptions["createGroupDragGhostComponent"] =>
    detail
      ? (group) =>
          new SvelteGroupDragGhostRenderer({
            viewIndex,
            id: `groupDragGhost-${group.id}`,
            ...mountable(detail, "groupDragGhost"),
          })
      : undefined;

  /** The name dockview asks for when a panel does not name its own tab. */
  const defaultTabName = "dockview-svelte-default-tab";
</script>

<script
  lang="ts"
  generics="
  const Components extends ComponentsConstraint<`dock`>,
  const Snippets extends SnippetsConstraint<`dock`>,
  const TabComponent extends DockviewTabConstraint[`components`],
  const TabSnippet extends DockviewTabConstraint[`snippets`],
  const Watermark extends DockviewSpecificComponentConstraint[`watermark`],
  const DefaultTab extends DockviewSpecificComponentConstraint[`defaultTab`],
  const RightHeaderActions extends DockviewSpecificComponentConstraint[`rightHeaderActions`],
  const LeftHeaderActions extends DockviewSpecificComponentConstraint[`leftHeaderActions`],
  const PrefixHeaderActions extends DockviewSpecificComponentConstraint[`prefixHeaderActions`],
  const TabGroupChip extends DockviewSpecificComponentConstraint[`tabGroupChip`],
  const GroupDragGhost extends DockviewSpecificComponentConstraint[`groupDragGhost`],
  const ContextMenu extends DockviewSpecificComponentConstraint[`tabContextMenu`],
"
>
  import { onDestroy, onMount } from "svelte";
  import { resolveTheme } from "./utils/themes.js";
  import DefaultDockTab from "./dock/DefaultDockTab.svelte";
  import TabContextMenu, { type At } from "./dock/TabContextMenu.svelte";

  type DockSpecific = {
    tabs: {
      components: TabComponent;
      snippets: TabSnippet;
    };
    watermark: Watermark;
    defaultTab: DefaultTab;
    rightHeaderActions: RightHeaderActions;
    leftHeaderActions: LeftHeaderActions;
    prefixHeaderActions: PrefixHeaderActions;
    tabGroupChip: TabGroupChip;
    groupDragGhost: GroupDragGhost;
    tabContextMenu: ContextMenu;
  };

  type Props = RecursivePartial<DockSpecific> &
    ModifiedProps<"dock", Components, Snippets, DockSpecific>;

  const index = dockCount++;

  let {
    components,
    snippets,
    tabs,
    theme: _theme,
    watermark,
    defaultTab,
    rightHeaderActions,
    leftHeaderActions,
    prefixHeaderActions,
    tabGroupChip,
    groupDragGhost,
    tabContextMenu,
    onReady,
    onDidDrop,
    onWillDrop,
    ...props
  }: Props = $props();

  const theme = $derived(resolveTheme(_theme));

  let openMenu = $state<{ at: At; target: ITabContextMenuProps }>();

  const closeTabContextMenu = () => (openMenu = undefined);

  const openTabContextMenu: OnTabContextMenu = (event, target) => {
    event.preventDefault();
    openMenu = {
      at: { x: event.clientX, y: event.clientY },
      target: { ...target, close: closeTabContextMenu },
    };
  };

  let dockView: ViewAPI<"dock", Components, Snippets>;

  for (const key of forwardedOptionKeys)
    $effect(() => dockView!?.updateOptions({ [key]: props[key] }));

  /**
   * A context menu can only be hooked onto a tab we render ourselves, so
   * configuring one settles what an unnamed tab falls back to.
   */
  const defaultTabDetail = (defaultTab ??
    (tabContextMenu ? { component: DefaultDockTab } : undefined)) as
    | DefaultTab
    | undefined;

  const onContextMenu = tabContextMenu ? openTabContextMenu : undefined;

  const createTabComponent = (
    options: Parameters<
      Required<DockviewFrameworkOptions>["createTabComponent"]
    >[0]
  ) => {
    if (defaultTabDetail && options.name === defaultTabName)
      return new SvelteDockHeaderRenderer({
        id: options.id,
        viewIndex: index,
        onContextMenu,
        ...mountable(defaultTabDetail, "defaultTab"),
      });

    const { component, propsPostProcessor, name } = getComponentToMount(
      "dock",
      tabs?.components as ComponentsConstraint<"dock">,
      tabs?.snippets as SnippetsConstraint<"dock">,
      options
    );

    return new SvelteDockHeaderRenderer({
      name,
      id: options.id,
      viewIndex: index,
      svelteComponent: component,
      propsPostProcessor,
      onContextMenu,
    });
  };

  const frameworkOptions: DockviewFrameworkOptions = {
    createLeftHeaderActionComponent: createGroupControlElement(
      index,
      "leftHeaderActions",
      leftHeaderActions as LeftHeaderActions
    ),
    createRightHeaderActionComponent: createGroupControlElement(
      index,
      "rightHeaderActions",
      rightHeaderActions as RightHeaderActions
    ),
    createPrefixHeaderActionComponent: createGroupControlElement(
      index,
      "prefixHeaderActions",
      prefixHeaderActions as PrefixHeaderActions
    ),
    createComponent: (options) => {
      const { component, propsPostProcessor, name } = getComponentToMount(
        "dock",
        components,
        snippets,
        options
      );

      return new SvelteDockComponentRenderer({
        name,
        id: options.id,
        viewIndex: index,
        svelteComponent: component,
        propsPostProcessor,
      });
    },
    createTabComponent:
      tabs || defaultTabDetail ? createTabComponent : undefined,
    createWatermarkComponent: watermark
      ? () =>
          new SvelteWatermarkRenderer({
            id: "watermark",
            viewIndex: index,
            ...mountable(watermark as Watermark, "watermark"),
          })
      : undefined,
  };

  let element = $state<HTMLElement>();

  onMount(() => {
    const api = createDockview(element!, {
      ...extractCoreOptions(props, forwardedOptionKeys),
      ...frameworkOptions,
      defaultTabComponent: defaultTabDetail ? defaultTabName : undefined,
      createTabGroupChipComponent: createTabGroupChip(
        index,
        tabGroupChip as TabGroupChip
      ),
      createGroupDragGhostComponent: createGroupDragGhost(
        index,
        groupDragGhost as GroupDragGhost
      ),
      theme,
    });

    dockView = Object.assign(
      api,
      createExtendedAPI<"dock", Components, Snippets>("dock", api, index)
    );

    const { clientWidth, clientHeight } = element!;
    dockView.layout(clientWidth, clientHeight);

    onReady?.({ api: dockView });
  });

  $effect(() => {
    if (onDidDrop) dockView?.onDidDrop(onDidDrop);
  });

  $effect(() => {
    if (onWillDrop) dockView?.onWillDrop(onWillDrop);
  });

  onDestroy(() => {
    dockView?.dispose();
  });

  $effect(() => {
    dockView?.updateOptions({ theme });
  });
</script>

<div
  id={`dock${index}`}
  bind:this={element}
  style:width="100%"
  style:height="100%"
></div>

{#if openMenu && tabContextMenu}
  <TabContextMenu
    at={openMenu.at}
    target={openMenu.target}
    menu={tabContextMenu as ContextMenu}
  />
{/if}
