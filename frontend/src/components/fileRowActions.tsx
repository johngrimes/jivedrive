/**
 * The file-row action set shared by the folder listing and search
 * results, so both views offer the same items in the same order.
 */
import {
  DownloadIcon,
  FileMovedIcon,
  ShareAndroidIcon,
  TrashIcon,
} from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { RowAction } from "./RowActionsMenu";

/** Handlers for one file row; an omitted handler omits its item. */
export interface FileRowHandlers {
  onDownload?: () => void;
  onShare?: () => void;
  onMove?: () => void;
  onDelete?: () => void;
}

/**
 * Build a file row's menu actions: Download, Share, Move, Delete, each
 * present only when its handler is given.
 *
 * @param handlers - the row's bound action handlers
 * @returns the actions, in display order
 */
export function fileRowActions(handlers: FileRowHandlers): RowAction[] {
  const all: [string, ReactNode, (() => void) | undefined][] = [
    ["Download", <DownloadIcon aria-hidden="true" />, handlers.onDownload],
    ["Share", <ShareAndroidIcon aria-hidden="true" />, handlers.onShare],
    ["Move", <FileMovedIcon aria-hidden="true" />, handlers.onMove],
    ["Delete", <TrashIcon aria-hidden="true" />, handlers.onDelete],
  ];
  return all.flatMap(([label, icon, onSelect]) =>
    onSelect ? [{ label, icon, onSelect }] : [],
  );
}
