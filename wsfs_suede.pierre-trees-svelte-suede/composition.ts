import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTreeCompositionOptions,
} from "@pierre/trees";

export type ContextMenuTrigger = {
  item: ContextMenuItem;
  context: ContextMenuOpenContext;
};

type ContextMenuSignals = {
  opened: (trigger: ContextMenuTrigger) => void;
  closed: () => void;
};

type ContextMenu = NonNullable<FileTreeCompositionOptions["contextMenu"]>;

const slotDriven = (
  baseline: ContextMenu | undefined,
  signals: ContextMenuSignals,
): ContextMenu => {
  const { render, ...rest } = baseline ?? {};
  return {
    ...rest,
    enabled: true,
    onOpen: (item, context) => {
      signals.opened({ item, context });
      baseline?.onOpen?.(item, context);
    },
    onClose: () => {
      baseline?.onClose?.();
      signals.closed();
    },
  };
};

const isEmpty = (composition: FileTreeCompositionOptions): boolean =>
  composition.header === undefined && composition.contextMenu === undefined;

/**
 * A snippet renders into the tree's light DOM, so wherever one is supplied the
 * matching declarative composition option has to step aside: the header slot
 * replaces `composition.header`, and the context menu slot replaces
 * `composition.contextMenu.render` while keeping the rest of its configuration.
 */
export const composedWithSlots = (
  baseline: FileTreeCompositionOptions | undefined,
  slots: { header: boolean; contextMenu: ContextMenuSignals | undefined },
): FileTreeCompositionOptions | undefined => {
  const composition: FileTreeCompositionOptions = { ...baseline };
  if (slots.header) delete composition.header;
  if (slots.contextMenu)
    composition.contextMenu = slotDriven(baseline?.contextMenu, slots.contextMenu);
  return isEmpty(composition) ? undefined : composition;
};
