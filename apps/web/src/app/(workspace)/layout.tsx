import type { ReactNode } from 'react';

/**
 * Full-screen workspaces (the research assistant). No newsroom navigation or footer: the page owns
 * the whole viewport. Signed-out visitors are redirected by the proxy, and each page checks the
 * session itself.
 */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <main className="bg-paper">{children}</main>;
}
