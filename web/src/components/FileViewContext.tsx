// Lets deeply-nested chat-message renderers (notably AssistantMarkdown's
// custom `a` component) ask the window manager to open a FileView
// window without threading a callback through every intermediate
// component. Pure plumbing — no state of its own. The window-manager
// owns the actual window state.

import { createContext, type ReactNode, useContext } from 'react';

type OpenFileView = (path: string) => void;

const FileViewContext = createContext<OpenFileView | null>(null);

export function FileViewProvider({
  open,
  children,
}: {
  open: OpenFileView;
  children: ReactNode;
}) {
  return <FileViewContext.Provider value={open}>{children}</FileViewContext.Provider>;
}

/** Returns the opener, or null when no provider is mounted (e.g. unit
 *  tests of AssistantMarkdown in isolation). Components must handle
 *  the null case by falling back to default browser navigation. */
export function useFileViewOpener(): OpenFileView | null {
  return useContext(FileViewContext);
}
