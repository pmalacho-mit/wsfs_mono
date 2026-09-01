import {
  DockviewCompositeDisposable,
  DockviewEmitter,
  DockviewEvent,
  DockviewMutableDisposable,
} from "dockview";
import type {
  GroupPanelPartInitParameters,
  IContentRenderer,
  IDockviewPanelProps,
  IDockviewPanelHeaderProps,
  ITabRenderer,
  TabPartInitParameters,
  IWatermarkRenderer,
  IWatermarkPanelProps,
  WatermarkRendererInitParameters,
  IDockviewHeaderActionsProps,
  IGroupHeaderProps,
  IHeaderActionsRenderer,
  ITabGroupChipRenderer,
  IGroupDragGhostRenderer,
  ITabGroup,
  PanelUpdateEvent,
  DockviewApi,
  DockviewGroupPanel,
  IDockviewPanel,
} from "dockview";
import PanelRendererBase, {
  type ConstructorConfigWithout,
} from "../utils/PanelRendererBase.js";
import type { PropsUpdater } from "../utils/PropsUpdater.svelte.js";
import type {
  ITabGroupChipProps,
  IGroupDragGhostProps,
} from "../utils/index.js";

export class SvelteDockComponentRenderer<Props extends IDockviewPanelProps>
  extends PanelRendererBase<Props, GroupPanelPartInitParameters>
  implements IContentRenderer
{
  private readonly _onDidFocus = new DockviewEmitter<void>();
  readonly onDidFocus: DockviewEvent<void> = this._onDidFocus.event;

  private readonly _onDidBlur = new DockviewEmitter<void>();
  readonly onDidBlur: DockviewEvent<void> = this._onDidBlur.event;

  constructor(
    config: ConstructorConfigWithout<Props, GroupPanelPartInitParameters>
  ) {
    super({
      ...config,
      panelTarget: "dock",
      initOptionsToProps: ({ params, api, containerApi }) =>
        ({ params, api, containerApi } as Props),
    });
  }

  public dispose(): void {
    super.dispose();
    this._onDidFocus.dispose();
    this._onDidBlur.dispose();
  }
}

/**
 * What a tab hands its context menu. Deliberately the argument shape
 * upstream's `IContextMenuItemComponentProps` carries, less the `close`
 * the menu itself supplies.
 */
export type TabContextMenuTarget = {
  panel: IDockviewPanel;
  group: DockviewGroupPanel;
  api: DockviewApi;
};

export type OnTabContextMenu = (
  event: MouseEvent,
  target: TabContextMenuTarget
) => void;

const tabContextMenuTarget = ({
  api,
  containerApi,
}: TabPartInitParameters): TabContextMenuTarget | undefined => {
  const panel = containerApi.getPanel(api.id);
  return panel && { panel, group: api.group, api: containerApi };
};

export class SvelteDockHeaderRenderer<Props extends IDockviewPanelHeaderProps>
  extends PanelRendererBase<Props, TabPartInitParameters>
  implements ITabRenderer
{
  private readonly onContextMenu?: OnTabContextMenu;

  constructor(
    config: ConstructorConfigWithout<Props, TabPartInitParameters> & {
      onContextMenu?: OnTabContextMenu;
    }
  ) {
    super({
      ...config,
      panelTarget: "dockheader",
      initOptionsToProps: ({ params, api, containerApi, tabLocation }) =>
        ({ params, api, containerApi, tabLocation } as Props),
    });

    this.onContextMenu = config.onContextMenu;
  }

  init(parameters: TabPartInitParameters): void {
    super.init(parameters);

    const { onContextMenu } = this;
    if (!onContextMenu) return;

    this.element.addEventListener("contextmenu", (event) => {
      const target = tabContextMenuTarget(parameters);
      if (target) onContextMenu(event, target);
    });
  }
}

export class SvelteWatermarkRenderer<Props extends IWatermarkPanelProps>
  extends PanelRendererBase<Props, WatermarkRendererInitParameters>
  implements IWatermarkRenderer
{
  constructor(
    config: ConstructorConfigWithout<Props, WatermarkRendererInitParameters>
  ) {
    super({
      ...config,
      panelTarget: "dockwatermark",
      initOptionsToProps: ({ group, containerApi }) =>
        ({ group, containerApi } as Props),
    });
  }
}

export class SvelteTabGroupChipRenderer<Props extends ITabGroupChipProps>
  extends PanelRendererBase<Props, ITabGroupChipProps>
  implements ITabGroupChipRenderer
{
  constructor(config: ConstructorConfigWithout<Props, ITabGroupChipProps>) {
    super({
      ...config,
      panelTarget: "docktabgroupchip",
      initOptionsToProps: ({ tabGroup, api }) => ({ tabGroup, api } as Props),
    });
  }

  /** A chip is handed its tab group again, where a panel would get `params`. */
  update(event: PanelUpdateEvent | { tabGroup: ITabGroup }): void {
    if (!("tabGroup" in event)) return super.update(event);

    (
      this.propsUpdater as unknown as PropsUpdater<ITabGroupChipProps>
    )?.updateSingle("tabGroup", event.tabGroup);
  }
}

export class SvelteGroupDragGhostRenderer<Props extends IGroupDragGhostProps>
  extends PanelRendererBase<Props, IGroupDragGhostProps>
  implements IGroupDragGhostRenderer
{
  constructor(config: ConstructorConfigWithout<Props, IGroupDragGhostProps>) {
    super({
      ...config,
      panelTarget: "dockdragghost",
      initOptionsToProps: ({ group, api }) => ({ group, api } as Props),
    });
  }
}

/** The header action props that track their group rather than sitting still. */
const liveHeaderActionProps = (group: DockviewGroupPanel) => ({
  panels: group.model.panels,
  activePanel: group.model.activePanel,
  isGroupActive: group.api.isActive,
  headerPosition: group.api.getHeaderPosition(),
  location: group.api.location,
});

type LiveHeaderActionProps = ReturnType<typeof liveHeaderActionProps>;

export class SvelteDockActionsHeaderRenderer<
    Props extends IDockviewHeaderActionsProps
  >
  extends PanelRendererBase<Props, IGroupHeaderProps>
  implements IHeaderActionsRenderer
{
  private readonly mutableDisposable = new DockviewMutableDisposable();
  private readonly group: DockviewGroupPanel;

  constructor(
    group: DockviewGroupPanel,
    config: ConstructorConfigWithout<Props, IGroupHeaderProps>
  ) {
    super({
      ...config,
      panelTarget: "dockactions",
      initOptionsToProps: ({ api, containerApi }) =>
        ({
          api,
          containerApi,
          group,
          ...liveHeaderActionProps(group),
        } as Props),
    });

    this.group = group;
  }

  init(parameters: IGroupHeaderProps): void {
    const { model, api } = this.group;

    this.mutableDisposable.value = new DockviewCompositeDisposable(
      model.onDidAddPanel(this.refresh("panels")),
      model.onDidRemovePanel(this.refresh("panels")),
      model.onDidActivePanelChange(this.refresh("activePanel")),
      api.onDidActiveChange(this.refresh("isGroupActive")),
      api.onDidHeaderDirectionChange(this.refresh("headerPosition")),
      api.onDidLocationChange(this.refresh("location"))
    );

    super.init(parameters);
  }

  dispose(): void {
    super.dispose();
    this.mutableDisposable.dispose();
  }

  private refresh =
    <Key extends keyof LiveHeaderActionProps>(key: Key) =>
    (): void => {
      (
        this.propsUpdater as unknown as PropsUpdater<IDockviewHeaderActionsProps>
      )?.updateSingle(key, liveHeaderActionProps(this.group)[key]);
    };
}
