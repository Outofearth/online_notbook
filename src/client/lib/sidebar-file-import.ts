/**
 * Global trigger channel for file import: any UI component (SidebarRail button,
 * folder context menu, etc.) simply calls openFileImport(folderId). The actual hidden
 * <input type="file"> is registered as a listener inside the top-level Sidebar component.
 *
 * Rationale: inkstone's SidebarRail / FolderSection / FolderItem are independent components;
 * passing folderId through every level of props drilling is awkward. A module-level singleton
 * listener decouples the trigger from the handler — a lightweight version of DOM EventTarget.
 */

type ImportListener = (folderId: string | null) => void

/** Currently registered listener; registered by the top-level Sidebar on mount, cleared on unmount */
let registeredListener: ImportListener | null = null

/**
 * Registers an import event handler. The top-level Sidebar uses this to know when
 * to click the hidden file input. Returns an unsubscribe function that Sidebar calls
 * in its useEffect cleanup to avoid dangling listeners after component unmount.
 */
export function registerImportTrigger(listener: ImportListener): () => void {
  registeredListener = listener
  return () => {
    if (registeredListener === listener) registeredListener = null
  }
}

/**
 * Triggers the file picker. Any UI entry point (Rail button / context menu item) calls this directly.
 * @param folderId Target folder id for the import; null means root (unfiled)
 */
export function openFileImport(folderId: string | null = null): void {
  registeredListener?.(folderId)
}
