import { useT } from "@agent-native/core/client/i18n";
import { HeaderActionsProvider } from "@agent-native/toolkit/app-shell/header-actions";

import { Header } from "./Header";

export function Layout({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <HeaderActionsProvider>
      <div className="flex h-dvh w-full flex-col bg-background text-foreground">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-1.5 focus:text-primary-foreground"
        >
          {t("root.skipToContent")}
        </a>
        <Header />
        <main
          id="main-content"
          className="flex-1 overflow-y-auto px-4 py-6 lg:px-8"
        >
          {children}
        </main>
      </div>
    </HeaderActionsProvider>
  );
}
