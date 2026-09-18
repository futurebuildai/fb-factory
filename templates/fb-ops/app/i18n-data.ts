import { type LocaleCode } from "@agent-native/core/client/i18n";

const enUS = {
  root: {
    skipToContent: "Skip to content",
    toggleTheme: "Toggle theme",
  },
  navigation: {
    openNavigation: "Open navigation",
    home: "Dashboard",
  },
  home: {
    title: "FB Ops",
    subtitle:
      "Read-only platform operations for FutureBuild Cloud. Ask the agent to check console health.",
    consoleHealth: "FB Console health",
    runtime: "Runtime",
    loading: "Loading...",
    loadFailed: "Could not load this panel.",
  },
} as const;

const catalog = {
  "en-US": enUS,
} as const;

export type Messages = typeof enUS;

export const SUPPORTED_LOCALES: LocaleCode[] = ["en-US"];

export const messagesByLocale: Record<string, Messages> = catalog;
