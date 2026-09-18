import { type LocaleCode } from "@agent-native/core/client/i18n";

import { enUS } from "./i18n/en-US.messages";

const catalog = {
  "en-US": enUS,
} as const;

export type Messages = typeof enUS;

export const SUPPORTED_LOCALES: LocaleCode[] = ["en-US"];

export const messagesByLocale: Record<string, Messages> = catalog;
