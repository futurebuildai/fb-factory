/**
 * `/mcp/connect` — frictionless external-agent connection. The legacy
 * `/_agent-native/mcp/connect` alias is mounted by the core route plugin.
 *
 * A logged-in user on a deployed agent-native app (e.g. mail.agent-native.com)
 * mints a per-user, scoped, revocable MCP bearer token WITHOUT ever copying a
 * shared deployment secret. Two surfaces:
 *
 *   1. Browser  — `GET /mcp/connect` renders a minimal in-app page (same inline
 *      HTML approach as the auth pages). The Authorize button POSTs to
 *      `/connect/token`, then shows the ready-to-paste `.mcp.json` entry, the
 *      `agent-native connect <origin>` one-liner, and the user's existing
 *      tokens with Revoke buttons.
 *   2. CLI      — an OAuth-2.0-device-authorization-style flow:
 *        POST /mcp/connect/device/start      (unauth)  → device_code + user_code
 *        GET  /mcp/connect?user_code=…       (browser) → user signs in & approves
 *        POST /mcp/connect/device/authorize  (session) → binds user to the code
 *        POST /mcp/connect/device/poll       (unauth)  → mints + returns the token
 *
 * When A2A_SECRET exists, the minted token reuses the existing A2A signer
 * (`signA2AToken`) and adds a random `jti` + `scope: "mcp-connect"` claim so
 * it can be revoked. Deployments without A2A_SECRET mint the same standard MCP
 * OAuth access-token format used by remote MCP OAuth, signed with the auth
 * secret fallback and bound to the exact MCP resource URL.
 *
 * Node-only (crypto + the A2A signer), bundled alongside the other framework
 * PostgreSQL SQL lives in `connect-store.ts`.
 */

import { randomUUID } from "node:crypto";

import type { H3Event } from "h3";
import { getMethod, getHeader } from "h3";

import { signA2AToken } from "../a2a/client.js";
import { getAppConfig } from "../app-config/index.js";
import { mcpSettingsMessagesForLocale } from "../localization/mcp-settings-messages.js";
import { resolveLocaleFromRequest } from "../localization/server.js";
import {
  localeDirection,
  normalizeLocaleCode,
  type LocaleCode,
} from "../localization/shared.js";
import { getOrgDomain } from "../org/context.js";
import {
  getSession,
  getConfiguredLoginHtml,
  isLoopbackRequest,
} from "../server/auth.js";
import { readBody } from "../server/h3-helpers.js";
import {
  MCP_CONNECT_MCP_URL_TEMPLATE,
  getMcpConnectGuides,
  getMcpStaticTokenFallback,
  interpolateMcpConnectTemplate,
  resolveMcpConnectGuideId,
  type McpConnectGuide,
  type McpConnectGuideId,
} from "../shared/mcp-connect-content.js";
import {
  recordMintedToken,
  listTokens,
  revokeToken,
  normalizeServiceName,
  serviceIdentityEmail,
  createDeviceCode,
  getDeviceCode,
  approveDeviceCode,
  consumeDeviceCode,
  claimDeviceCodeForMint,
  finishDeviceCodeMint,
  releaseDeviceCodeMint,
  expireDeviceCode,
  MCP_CONNECT_OAUTH_CLIENT_ID,
  MCP_CONNECT_SCOPE,
  DEFAULT_TOKEN_TTL_DAYS,
  MIN_TOKEN_TTL_DAYS,
  MAX_TOKEN_TTL_DAYS,
  DEVICE_CODE_TTL_MS,
} from "./connect-store.js";
import {
  MCP_OAUTH_DEFAULT_SCOPE,
  signMcpOAuthAccessToken,
} from "./oauth-token.js";
import { MCP_PUBLIC_ROUTE_PREFIX } from "./route-paths.js";

/** Device-flow poll interval hint (seconds). */
const DEVICE_POLL_INTERVAL_S = 3;

// Human-typable user code: 8 base32 chars, dashed XXXX-XXXX.
const USER_CODE_RE = /^[A-Z2-7]{4}-[A-Z2-7]{4}$/;

export interface McpConnectRouteOptions {
  /** App id (directory under apps/, e.g. `mail`). Used for the server name. */
  appId?: string;
  /** Human app name shown on the connect page. */
  appName?: string;
  /** Explicit MCP server id to return in copyable config/device-flow grants. */
  serverName?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Derive the running app's origin from request headers (same logic mountMCP
 *  uses) — `https` in prod / for non-loopback hosts, `http` for localhost. */
function deriveOrigin(event: H3Event): string {
  const forwardedProto = getHeader(event, "x-forwarded-proto");
  const host = getHeader(event, "x-forwarded-host") || getHeader(event, "host");
  const proto =
    forwardedProto?.split(",")[0]?.trim() ||
    (host && /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
  return host ? `${proto}://${host}` : "";
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname.startsWith("127.")
    );
  } catch {
    return false;
  }
}

function normalizeBasePath(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === "/") return "";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "");
}

function configuredBasePath(): string {
  return normalizeBasePath(
    process.env.APP_BASE_PATH || process.env.VITE_APP_BASE_PATH,
  );
}

function joinAppPath(basePath: string, path: string): string {
  if (!basePath) return path;
  if (path === "/") return basePath;
  return `${basePath}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Which app this deployment is, for naming its MCP server.
 *
 * The hostname is the LAST resort, not the first: every beta deployment is
 * `beta.<app>.agent-native.com`, so the leading label is `beta` for all of
 * them and every beta app advertised itself as `agent-native-beta`. A client
 * keys its config by that name, so connecting a second beta app overwrote the
 * first. Declared identity comes first now, and `app.slug` covers every
 * first-party template with no configuration at all.
 */
function appLabel(origin: string, options: McpConnectRouteOptions): string {
  const app = getAppConfig().app;
  const declared = options.appId ?? app.id ?? app.template ?? app.slug;
  if (declared) return declared;
  try {
    const h = new URL(origin).hostname;
    return h.split(".")[0] || h;
  } catch {
    return options.appName || "app";
  }
}

function serverName(origin: string, options: McpConnectRouteOptions): string {
  const explicit = options.serverName?.trim();
  if (explicit) return explicit;
  return `agent-native-${appLabel(origin, options)}`;
}

function canUseDevOpenConnect(event: H3Event): boolean {
  // Loopback determined from the real socket peer (isLoopbackRequest →
  // getRequestIP without xForwardedFor), NOT a parsed `Host` header — the
  // header is client-controlled, and it also handles IPv6 `::1`. A
  // misconfigured public deploy with no secret thus can't unlock dev-open
  // by spoofing `Host: localhost`.
  return (
    isLoopbackRequest(event) &&
    isLoopbackOrigin(deriveOrigin(event)) &&
    !process.env.A2A_SECRET?.trim() &&
    !process.env.ACCESS_TOKEN?.trim() &&
    !process.env.ACCESS_TOKENS?.trim()
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Resolve the org domain for a session. Used as the JWT `org_domain` claim so
 * the receiving MCP endpoint can map it back to an org id (same as A2A). Best
 * effort — a missing org just yields a user-scoped (no-org) token.
 */
async function resolveOrgDomain(
  orgId: string | undefined,
): Promise<string | undefined> {
  if (!orgId) return undefined;
  try {
    return (await getOrgDomain(orgId)) ?? undefined;
  } catch {
    return undefined;
  }
}

function clampTtlDays(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return DEFAULT_TOKEN_TTL_DAYS;
  return Math.min(
    MAX_TOKEN_TTL_DAYS,
    Math.max(MIN_TOKEN_TTL_DAYS, Math.floor(n)),
  );
}

/**
 * Mint a connect-scoped JWT and record it. The token value is returned to the
 * caller exactly once and never persisted; only the random `jti` is stored for
 * revocation.
 */
async function mintConnectToken(params: {
  email: string;
  orgId: string | undefined;
  label: string | null;
  ttlDays: number;
  appUrl: string;
  /** When `"full"`, embed `catalog_scope: "full"` in the JWT so this token
   *  bypasses the compact/connector-catalog tier (active by default whenever a
   *  `connectorCatalog` is declared) and gets the complete action surface. */
  catalogScope?: "full";
}): Promise<{ token: string; jti: string }> {
  const orgDomain = await resolveOrgDomain(params.orgId);
  const jti = randomUUID();
  const token = await signConnectToken({
    ownerEmail: params.email,
    orgId: params.orgId,
    orgDomain,
    appUrl: params.appUrl,
    expiresIn: `${params.ttlDays}d`,
    jti,
    ...(params.catalogScope === "full" ? { catalogScope: "full" } : {}),
  });
  await recordMintedToken({
    jti,
    ownerEmail: params.email,
    orgId: params.orgId ?? null,
    label: params.label,
  });
  return { token, jti };
}

async function signConnectToken(params: {
  ownerEmail: string;
  orgId: string | null | undefined;
  orgDomain: string | undefined;
  appUrl: string;
  expiresIn: string;
  jti: string;
  /**
   * When true, embed the org id directly as an `org_id` claim on the
   * A2A-signed path (the OAuth-signed path already carries `params.orgId`).
   * Used for org SERVICE tokens, whose synthetic identity must resolve to the
   * org even when the org has no domain mapping. Personal tokens keep the
   * original domain-based resolution — behavior unchanged.
   */
  includeOrgIdClaim?: boolean;
  /**
   * When `"full"`, embed a `catalog_scope: "full"` claim so this token
   * bypasses the compact/connector-catalog tier filter (active by default
   * whenever a `connectorCatalog` is declared) and gets the complete action
   * surface. Minted when the user connects with `agent-native connect --full-catalog`.
   */
  catalogScope?: "full";
}): Promise<string> {
  if (process.env.A2A_SECRET?.trim()) {
    return signA2AToken(params.ownerEmail, params.orgDomain, undefined, {
      preferGlobalSecret: true,
      expiresIn: params.expiresIn,
      extraClaims: {
        jti: params.jti,
        scope: MCP_CONNECT_SCOPE,
        ...(params.includeOrgIdClaim && params.orgId
          ? { org_id: params.orgId }
          : {}),
        ...(params.catalogScope === "full" ? { catalog_scope: "full" } : {}),
      },
    });
  }

  return signMcpOAuthAccessToken({
    ownerEmail: params.ownerEmail,
    orgId: params.orgId ?? null,
    orgDomain: params.orgDomain ?? null,
    clientId: MCP_CONNECT_OAUTH_CLIENT_ID,
    scope: MCP_OAUTH_DEFAULT_SCOPE,
    resource: mcpResourceUrl(params.appUrl),
    issuer: params.appUrl,
    jti: params.jti,
    expiresIn: params.expiresIn,
    ...(params.catalogScope === "full" ? { catalogScope: "full" } : {}),
  });
}

/**
 * Mint an ORG SERVICE token: a connect-scoped, revocable bearer whose subject
 * is the synthetic service identity `svc-<name>@service.<orgId>` instead of a
 * person. Built for CI (e.g. the `PLAN_RECAP_TOKEN` GitHub secret) so the
 * credential survives any individual leaving or revoking their personal
 * tokens, and so rows created by CI are org-scoped (visible to org members)
 * rather than owned by one person.
 *
 * The token value is returned exactly once and never persisted — only the
 * random `jti` is stored, so the standard revocation path
 * (`isJtiRevoked` in `verifyAuth`) applies to service tokens identically.
 *
 * Authorization is the CALLER'S responsibility: this function does not check
 * org membership/role. The `create-org-service-token` action gates on org
 * owner/admin before calling it.
 */
export async function mintOrgServiceToken(params: {
  /** Human-readable service principal name, e.g. "ci" or "pr-recap". */
  serviceName: string;
  /** Org the service token acts for; becomes the resolved session orgId. */
  orgId: string;
  /** The human minting the token — stored for audit, never used as identity. */
  createdBy: string;
  /** 1–365 days; clamped. Defaults to DEFAULT_TOKEN_TTL_DAYS. */
  ttlDays?: number;
  /** App origin used for OAuth-signed tokens (resource/issuer binding). */
  appUrl: string;
}): Promise<{
  token: string;
  jti: string;
  id: string;
  serviceName: string;
  serviceEmail: string;
  ttlDays: number;
}> {
  const serviceName = normalizeServiceName(params.serviceName);
  const serviceEmail = serviceIdentityEmail(serviceName, params.orgId);
  const orgDomain = await resolveOrgDomain(params.orgId);
  const ttlDays = clampTtlDays(params.ttlDays ?? DEFAULT_TOKEN_TTL_DAYS);
  const jti = randomUUID();
  const token = await signConnectToken({
    ownerEmail: serviceEmail,
    orgId: params.orgId,
    orgDomain,
    appUrl: params.appUrl,
    expiresIn: `${ttlDays}d`,
    jti,
    includeOrgIdClaim: true,
  });
  const id = await recordMintedToken({
    jti,
    ownerEmail: serviceEmail,
    orgId: params.orgId,
    label: `Service token: ${serviceName}`,
    kind: "service",
    serviceName,
    createdBy: params.createdBy,
  });
  return { token, jti, id, serviceName, serviceEmail, ttlDays };
}

function mcpResultPayload(
  appUrl: string,
  options: McpConnectRouteOptions,
  auth: { token?: string; ownerEmail?: string },
) {
  const mcpUrl = mcpResourceUrl(appUrl);
  const name = serverName(appUrl, options);
  const headers: Record<string, string> = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (!auth.token && auth.ownerEmail) {
    headers["X-Agent-Native-Owner-Email"] = auth.ownerEmail;
  }
  // Intentionally do NOT inject the full-catalog header here. Every connector
  // used to receive it, which silently forced the ~105-tool full catalog on
  // every client. Full-catalog intent now lives durably in the token itself
  // (`catalog_scope: "full"`, minted only by `connect --full-catalog`), so a
  // normal connection defaults to the compact/connector catalog + tool-search.
  return {
    token: auth.token ?? "",
    mcpUrl,
    serverName: name,
    mcpServerEntry: {
      type: "http" as const,
      url: mcpUrl,
      ...(Object.keys(headers).length ? { headers } : {}),
    },
    cli: `npx @agent-native/core@latest connect ${appUrl}`,
  };
}

function mcpResourceUrl(appUrl: string): string {
  return `${appUrl}${MCP_PUBLIC_ROUTE_PREFIX}`;
}

// ---------------------------------------------------------------------------
// Connect page (server-rendered HTML string)
// ---------------------------------------------------------------------------

// Fixed brand mark colors for the server-rendered connect page. The mark is
// brand art, not theme-aware UI, so it does not use the app theme tokens.
// guard:allow-raw-color: brand mark duo reds, see packages/core/src/assets/branding
const BRAND_MARK_RED = "#fd366e";
// guard:allow-raw-color: brand mark duo reds, see packages/core/src/assets/branding
const BRAND_MARK_RED_SECONDARY = "#f02e65";

const BRAND_MARK_HOUSE_BODY_D =
  "M 929 8 L 850 72 L 846 77 L 819 98 L 749 159 L 730 173 L 722 181 L 672 221 L 658 235 L 640 248 L 623 264 L 610 273 L 563 314 L 456 402 L 435 422 L 403 447 L 341 501 L 309 526 L 306 530 L 277 553 L 260 569 L 245 580 L 229 595 L 189 627 L 164 650 L 96 705 L 79 721 L 67 729 L 41 753 L 21 769 L 10 780 L 8 785 L 8 849 L 14 857 L 47 884 L 91 924 L 106 935 L 110 940 L 163 986 L 168 988 L 174 986 L 190 973 L 214 950 L 238 932 L 244 925 L 288 887 L 297 881 L 299 882 L 300 1430 L 306 1436 L 386 1435 L 390 1430 L 391 1423 L 389 1274 L 389 809 L 391 803 L 401 793 L 421 779 L 433 767 L 455 749 L 464 739 L 472 734 L 505 705 L 530 687 L 569 650 L 580 641 L 584 640 L 584 723 L 586 795 L 590 797 L 702 797 L 706 798 L 707 800 L 645 861 L 627 874 L 586 916 L 585 1056 L 577 1059 L 483 1059 L 480 1061 L 478 1066 L 479 1146 L 481 1149 L 486 1151 L 540 1150 L 582 1152 L 585 1156 L 585 1299 L 589 1307 L 632 1345 L 655 1362 L 707 1409 L 749 1443 L 806 1494 L 829 1512 L 851 1533 L 866 1545 L 872 1552 L 896 1570 L 927 1597 L 933 1597 L 973 1564 L 976 1560 L 983 1556 L 1038 1506 L 1073 1478 L 1114 1440 L 1157 1404 L 1161 1399 L 1183 1382 L 1207 1359 L 1210 1358 L 1233 1336 L 1237 1334 L 1272 1303 L 1274 1257 L 1274 1151 L 1276 1149 L 1312 1148 L 1371 1149 L 1380 1146 L 1380 1063 L 1377 1060 L 1274 1059 L 1273 917 L 1240 883 L 1188 835 L 1182 831 L 1166 815 L 1164 815 L 1151 799 L 1154 797 L 1168 796 L 1270 796 L 1273 794 L 1273 647 L 1274 640 L 1277 637 L 1313 666 L 1329 682 L 1344 693 L 1351 701 L 1353 701 L 1403 744 L 1406 745 L 1443 777 L 1447 782 L 1459 790 L 1473 805 L 1473 1409 L 1474 1431 L 1476 1433 L 1552 1434 L 1556 1433 L 1558 1429 L 1558 876 L 1560 875 L 1574 887 L 1577 888 L 1584 896 L 1595 903 L 1599 908 L 1617 922 L 1628 933 L 1630 933 L 1641 944 L 1655 954 L 1667 966 L 1670 967 L 1685 982 L 1691 985 L 1705 975 L 1748 935 L 1772 916 L 1847 848 L 1848 784 L 1839 774 L 1798 740 L 1776 719 L 1763 710 L 1744 692 L 1741 691 L 1709 662 L 1688 646 L 1670 629 L 1665 627 L 1644 608 L 1635 602 L 1611 579 L 1608 578 L 1589 561 L 1586 560 L 1575 549 L 1561 539 L 1558 530 L 1557 261 L 1549 252 L 1546 251 L 1535 240 L 1532 239 L 1526 231 L 1516 224 L 1501 210 L 1498 209 L 1491 201 L 1486 198 L 1483 194 L 1481 194 L 1459 173 L 1456 172 L 1429 145 L 1426 145 L 1425 142 L 1418 138 L 1393 115 L 1391 115 L 1382 105 L 1371 96 L 1364 96 L 1328 129 L 1325 130 L 1302 153 L 1271 178 L 1235 213 L 1225 220 L 1223 224 L 1222 223 L 1209 236 L 1205 236 L 1160 199 L 1131 172 L 1126 170 L 1119 163 L 1095 145 L 1092 141 L 1085 137 L 1051 106 L 1013 74 L 1000 65 L 950 21 L 944 18 L 936 10 Z M 1014 796 L 1019 797 L 1052 830 L 1058 834 L 1086 862 L 1100 873 L 1123 896 L 1128 899 L 1170 940 L 1174 942 L 1188 957 L 1187 1056 L 1183 1059 L 1164 1060 L 1078 1059 L 1075 1060 L 1071 1065 L 1070 1082 L 1071 1140 L 1073 1146 L 1076 1149 L 1175 1149 L 1187 1153 L 1188 1260 L 1165 1281 L 1161 1283 L 1157 1289 L 1154 1289 L 1133 1309 L 1109 1327 L 1074 1357 L 1052 1379 L 1049 1380 L 1044 1386 L 1027 1399 L 1016 1410 L 1005 1417 L 974 1444 L 958 1460 L 949 1466 L 934 1480 L 929 1481 L 904 1461 L 868 1427 L 844 1409 L 789 1358 L 744 1322 L 675 1260 L 673 1240 L 674 1153 L 676 1151 L 702 1150 L 724 1151 L 787 1149 L 790 1144 L 789 1136 L 791 1100 L 790 1065 L 788 1061 L 785 1059 L 686 1059 L 678 1058 L 674 1055 L 673 958 L 680 949 L 696 936 L 734 899 L 742 893 L 745 888 L 759 874 L 767 869 L 786 850 L 799 840 L 818 820 L 831 810 L 843 797 Z M 909 1203 L 889 1215 L 882 1223 L 877 1232 L 873 1249 L 873 1261 L 878 1282 L 883 1290 L 892 1299 L 909 1309 L 920 1312 L 943 1312 L 946 1310 L 950 1310 L 961 1305 L 976 1293 L 985 1278 L 988 1264 L 988 1252 L 986 1238 L 983 1229 L 980 1224 L 968 1212 L 951 1202 L 946 1202 L 942 1200 L 921 1200 Z M 922 901 L 911 904 L 894 913 L 880 930 L 874 946 L 873 962 L 875 976 L 883 990 L 900 1007 L 918 1015 L 945 1015 L 966 1004 L 984 982 L 988 968 L 988 951 L 981 930 L 968 914 L 949 903 L 938 901 Z M 673 566 L 680 558 L 749 503 L 795 461 L 802 457 L 823 438 L 835 430 L 838 426 L 855 413 L 879 391 L 894 380 L 913 362 L 921 357 L 927 351 L 933 349 L 949 362 L 953 367 L 959 370 L 969 381 L 976 385 L 1000 407 L 1018 421 L 1022 426 L 1027 428 L 1054 451 L 1058 456 L 1064 459 L 1087 481 L 1102 492 L 1106 497 L 1120 507 L 1128 515 L 1136 520 L 1164 545 L 1186 562 L 1188 570 L 1188 703 L 1184 708 L 1101 708 L 1052 706 L 676 706 L 673 704 L 672 701 Z M 933 513 L 915 515 L 904 519 L 896 524 L 881 540 L 877 548 L 873 572 L 877 593 L 885 605 L 900 619 L 915 626 L 927 628 L 950 625 L 964 618 L 975 607 L 984 594 L 988 578 L 988 564 L 986 553 L 976 535 L 959 520 L 947 515 Z M 1366 211 L 1371 212 L 1382 223 L 1389 227 L 1411 248 L 1422 256 L 1425 261 L 1431 264 L 1434 268 L 1436 268 L 1441 275 L 1447 279 L 1456 289 L 1460 291 L 1472 305 L 1474 315 L 1474 408 L 1472 422 L 1474 458 L 1473 461 L 1469 461 L 1457 449 L 1455 449 L 1414 413 L 1406 408 L 1393 395 L 1391 395 L 1385 387 L 1376 382 L 1371 375 L 1364 371 L 1354 361 L 1341 352 L 1330 341 L 1328 341 L 1322 334 L 1315 330 L 1283 303 L 1277 295 L 1286 284 L 1309 265 L 1324 249 L 1342 235 Z M 108 814 L 126 798 L 150 780 L 165 765 L 183 752 L 216 722 L 260 687 L 275 673 L 294 659 L 308 645 L 341 617 L 369 596 L 381 584 L 390 578 L 426 546 L 483 501 L 521 466 L 591 410 L 599 401 L 617 387 L 627 377 L 651 357 L 662 350 L 670 342 L 673 341 L 692 323 L 723 298 L 744 278 L 799 235 L 817 217 L 832 206 L 848 191 L 854 188 L 872 174 L 929 123 L 932 123 L 967 154 L 1009 188 L 1012 189 L 1019 197 L 1063 235 L 1088 253 L 1098 263 L 1119 279 L 1143 302 L 1159 313 L 1167 322 L 1185 334 L 1226 370 L 1236 377 L 1240 382 L 1264 400 L 1272 409 L 1277 411 L 1296 429 L 1326 452 L 1349 473 L 1363 482 L 1379 498 L 1407 520 L 1417 530 L 1421 531 L 1433 543 L 1488 587 L 1504 603 L 1517 612 L 1547 638 L 1549 638 L 1600 683 L 1618 696 L 1637 714 L 1640 715 L 1643 719 L 1669 739 L 1695 763 L 1698 764 L 1719 783 L 1739 798 L 1749 808 L 1753 810 L 1754 817 L 1697 868 L 1689 872 L 1603 798 L 1600 797 L 1597 793 L 1573 774 L 1553 755 L 1549 753 L 1540 744 L 1538 744 L 1532 737 L 1517 726 L 1513 721 L 1511 721 L 1506 715 L 1501 713 L 1482 695 L 1473 689 L 1469 684 L 1467 684 L 1461 677 L 1455 674 L 1431 651 L 1423 645 L 1421 645 L 1419 642 L 1417 642 L 1416 639 L 1389 619 L 1337 572 L 1319 558 L 1314 552 L 1286 531 L 1263 510 L 1261 510 L 1258 506 L 1248 499 L 1203 458 L 1177 438 L 1172 432 L 1150 416 L 1116 385 L 1096 370 L 1064 341 L 1061 340 L 980 270 L 953 250 L 947 243 L 944 242 L 933 232 L 929 232 L 923 236 L 894 262 L 876 275 L 852 296 L 846 303 L 835 311 L 831 316 L 823 321 L 807 336 L 750 381 L 735 396 L 717 410 L 707 420 L 665 452 L 614 498 L 551 548 L 500 594 L 476 612 L 469 619 L 458 626 L 404 674 L 349 718 L 290 770 L 244 806 L 173 867 L 166 867 L 116 825 L 108 817 Z";

const BRAND_MARK_HOUSE_ACCENT_D =
  "M 909 1203 L 889 1215 L 882 1223 L 877 1232 L 873 1249 L 873 1261 L 878 1282 L 883 1290 L 892 1299 L 909 1309 L 920 1312 L 943 1312 L 946 1310 L 950 1310 L 961 1305 L 976 1293 L 985 1278 L 988 1264 L 988 1252 L 986 1238 L 983 1229 L 980 1224 L 968 1212 L 951 1202 L 946 1202 L 942 1200 L 921 1200 Z M 922 901 L 911 904 L 894 913 L 880 930 L 874 946 L 873 962 L 875 976 L 883 990 L 900 1007 L 918 1015 L 945 1015 L 966 1004 L 984 982 L 988 968 L 988 951 L 981 930 L 968 914 L 949 903 L 938 901 Z M 673 566 L 680 558 L 749 503 L 795 461 L 802 457 L 823 438 L 835 430 L 838 426 L 855 413 L 879 391 L 894 380 L 913 362 L 921 357 L 927 351 L 933 349 L 949 362 L 953 367 L 959 370 L 969 381 L 976 385 L 1000 407 L 1018 421 L 1022 426 L 1027 428 L 1054 451 L 1058 456 L 1064 459 L 1087 481 L 1102 492 L 1106 497 L 1120 507 L 1128 515 L 1136 520 L 1164 545 L 1186 562 L 1188 570 L 1188 703 L 1184 708 L 1101 708 L 1052 706 L 676 706 L 673 704 L 672 701 Z";

function agentNativeMarkSvg(className: string): string {
  return `<svg class="${className}" width="66" height="66" viewBox="0 0 66 66" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <path fill="${BRAND_MARK_RED}" fill-rule="evenodd" clip-rule="evenodd" d="${BRAND_MARK_HOUSE_BODY_D}" transform="translate(6.75 3.87) scale(0.03094)"/>
  <path fill="${BRAND_MARK_RED_SECONDARY}" fill-rule="evenodd" clip-rule="evenodd" d="${BRAND_MARK_HOUSE_ACCENT_D}" transform="translate(6.75 3.87) scale(0.03094)"/>
</svg>`;
}

function tablerTerminalSvg(className: string): string {
  return `<svg class="${className}" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
  <path d="M5 7l5 5l-5 5"/>
  <path d="M12 19l7 0"/>
</svg>`;
}

function renderConnectGuide(
  guide: McpConnectGuide,
  activeGuideId: McpConnectGuideId,
  values: Parameters<typeof interpolateMcpConnectTemplate>[1],
  copyLabel: string,
): string {
  const guideId = escapeHtml(guide.id);
  const content = [
    guide.steps?.length
      ? `<ol>${guide.steps
          .map(
            (step) =>
              `<li>${escapeHtml(interpolateMcpConnectTemplate(step, values))}</li>`,
          )
          .join("")}</ol>`
      : "",
    guide.intro
      ? `<p>${escapeHtml(interpolateMcpConnectTemplate(guide.intro, values))}</p>`
      : "",
    guide.commandTemplate
      ? `<pre id="${guideId}Command">${escapeHtml(interpolateMcpConnectTemplate(guide.commandTemplate, values))}</pre>
        <button type="button" class="primary-link compact" data-copy="${guideId}Command">${escapeHtml(guide.action?.label ?? copyLabel)}</button>`
      : "",
    guide.configTemplate
      ? `<pre id="${guideId}Config">${escapeHtml(interpolateMcpConnectTemplate(guide.configTemplate, values))}</pre>
        <button type="button" class="primary-link compact" data-copy="${guideId}Config">${escapeHtml(guide.action?.label ?? copyLabel)}</button>`
      : "",
    guide.action?.kind === "link" && guide.action.href
      ? `<a class="primary-link" href="${escapeHtml(guide.action.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(guide.action.label)}</a>`
      : "",
    guide.note
      ? `<p class="hint">${escapeHtml(interpolateMcpConnectTemplate(guide.note, values))}</p>`
      : "",
  ].join("\n");

  return `<div class="tab-panel${guide.id === activeGuideId ? " is-active" : ""}" role="tabpanel" id="mcp-guide-panel-${guideId}" aria-labelledby="mcp-guide-tab-${guideId}" data-panel="${guideId}">${content}</div>`;
}

function renderConnectPage(params: {
  connectBasePath: string;
  email: string;
  appName: string;
  appUrl: string;
  serverId: string;
  userCode: string | null;
  locale: LocaleCode;
  requestedGuide: string | null;
}): string {
  const {
    connectBasePath,
    email,
    appName,
    appUrl,
    serverId,
    userCode,
    locale,
    requestedGuide,
  } = params;
  const direction = localeDirection(locale);
  const messages = mcpSettingsMessagesForLocale(locale);
  const connectMessages = messages.mcpConnect;
  const guides = getMcpConnectGuides(locale);
  const staticTokenFallback = getMcpStaticTokenFallback(locale);
  const safeEmail = escapeHtml(email);
  const mcpUrl = interpolateMcpConnectTemplate(MCP_CONNECT_MCP_URL_TEMPLATE, {
    appName,
    appUrl,
    mcpUrl: "",
    serverId,
  });
  const safeMcpUrl = escapeHtml(mcpUrl);
  const connectTemplateValues = { appName, appUrl, mcpUrl, serverId };
  const localize = (message: string) =>
    escapeHtml(interpolateMcpConnectTemplate(message, connectTemplateValues));
  const flowMarkSvg = agentNativeMarkSvg("flow-mark");
  const flowTerminalSvg = tablerTerminalSvg("flow-terminal");
  const safeUserCode =
    userCode && USER_CODE_RE.test(userCode) ? escapeHtml(userCode) : "";
  const resolvedGuideId = resolveMcpConnectGuideId(requestedGuide);
  const activeGuideId = guides.some((guide) => guide.id === resolvedGuideId)
    ? resolvedGuideId
    : (guides[0]?.id ?? "claude");
  const guideTabsHtml = guides
    .map(
      (guide) =>
        `<button type="button" class="tab${guide.id === activeGuideId ? " is-active" : ""}" role="tab" id="mcp-guide-tab-${escapeHtml(guide.id)}" data-tab="${escapeHtml(guide.id)}" aria-controls="mcp-guide-panel-${escapeHtml(guide.id)}" aria-selected="${guide.id === activeGuideId ? "true" : "false"}">${escapeHtml(guide.label)}</button>`,
    )
    .join("\n");
  const guidePanelsHtml = guides
    .map((guide) =>
      renderConnectGuide(
        guide,
        activeGuideId,
        connectTemplateValues,
        messages.mcpCopy,
      ),
    )
    .join("\n");
  const setupHtml = safeUserCode
    ? ""
    : `
  <div class="mcp-url-block">
    <div class="section-label">${localize(connectMessages.urlTitle)}</div>
    <div class="url-row">
      <code id="mcpUrlValue">${safeMcpUrl}</code>
      <button type="button" class="ghost" data-copy="mcpUrlValue" aria-label="${localize(`${messages.mcpCopy} ${connectMessages.urlTitle}`)}">${localize(messages.mcpCopy)}</button>
    </div>
  </div>

  <details id="assistantSetup" class="hosts">
    <summary>
      <span class="connections-title">${localize(messages.mcpClientSetup)}</span>
      <span class="connections-state">${localize(connectMessages.guidesLabel)}</span>
      <span class="chev" aria-hidden="true"></span>
    </summary>
    <div class="hosts-body">
      <div class="section-label">${localize(messages.mcpChooseAssistant)}</div>
      <div class="tabs" role="tablist" aria-label="${localize(messages.mcpChooseAssistant)}">
        ${guideTabsHtml}
      </div>
      ${guidePanelsHtml}
    </div>
  </details>`;
  const tokenAdvancedOptionsHtml = safeUserCode
    ? ""
    : `
      <details class="advanced">
          <summary>
            ${localize(connectMessages.advancedOptions)}
            <span class="chev" aria-hidden="true"></span>
          </summary>
          <div class="advanced-body">
            <div class="field">
              <label for="label">${localize(connectMessages.labelOptional)}</label>
              <input id="label" type="text" placeholder="${localize(connectMessages.labelPlaceholder)}" maxlength="120" />
            </div>
            <div class="field">
              <label for="ttl">${localize(connectMessages.expiresInDays)}</label>
              <input id="ttl" type="number" min="1" max="365" value="${DEFAULT_TOKEN_TTL_DAYS}" />
            </div>
          </div>
        </details>`;
  return `<!DOCTYPE html>
<html lang="${escapeHtml(locale)}" dir="${direction}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${localize(connectMessages.pageTitle)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    color-scheme: dark;
    --bg: #09090b; --panel: #121214; --panel-2: #0c0c0e;
    --panel-soft: rgba(255,255,255,0.025);
    --border: rgba(255,255,255,0.075); --border-strong: rgba(255,255,255,0.14);
    --text: #f7f7f8; --muted: #a1a1aa; --subtle: #74747d;
    --accent: #f4f4f5; --accent-fg: #09090b;
    --ring: rgba(250,250,250,0.55);
    --error: #fca5a5; --error-bg: rgba(127,29,29,0.18);
    --ok: #86efac; --ok-bg: rgba(20,83,45,0.12); --ok-border: rgba(134,239,172,0.18);
  }
  html, body { -webkit-font-smoothing: antialiased; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: linear-gradient(180deg, #101013 0%, var(--bg) 58%);
    color: var(--text); display: flex; align-items: center;
    justify-content: center; min-height: 100vh; padding: 1.5rem 1rem;
  }
  .card {
    width: 100%; max-width: 440px;
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset,
      0 30px 90px rgba(0,0,0,0.5);
    padding: 1.25rem;
  }
  .hero { padding: 0 0.75rem; text-align: center; }
  .flow {
    display: flex; align-items: center; justify-content: center;
    gap: 0; margin: 0 auto 1.1rem; width: fit-content;
  }
  .flow .tile {
    width: 42px; height: 42px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    background: var(--panel-2); border: 1px solid var(--border-strong);
    color: var(--text); flex-shrink: 0;
  }
  .flow-mark { width: 26px; height: auto; display: block; }
  .flow-terminal { width: 22px; height: 22px; display: block; }
  .flow .conn {
    width: 30px; height: 1px; flex-shrink: 0;
    background: linear-gradient(90deg, transparent, var(--border-strong), transparent);
    background-position: center;
  }
  h1 {
    text-align: center; font-size: 1.45rem; font-weight: 680;
    line-height: 1.25; margin-bottom: 0.7rem;
    letter-spacing: -0.01em;
  }
  .identity {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
    gap: 0.25rem 0.45rem; color: var(--subtle); font-size: 0.78rem;
    line-height: 1.35; margin: 0 auto 1.5rem; max-width: 34ch;
  }
  .identity strong { color: var(--muted); font-weight: 600; }
  .device-strip {
    display: flex; align-items: center; justify-content: space-between;
    gap: 0.75rem; border: 1px solid var(--border);
    border-radius: 8px; padding: 0.5rem 0.65rem; margin: 0 0 0.9rem;
    background: var(--panel-soft); color: var(--muted);
  }
  .device-strip .label {
    font-size: 0.76rem; font-weight: 560; color: var(--subtle);
  }
  .device-strip .value {
    font-size: 0.78rem; font-weight: 650;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.08em; color: var(--muted);
  }
  button {
    cursor: pointer; font: inherit; font-weight: 600; border: none;
    border-radius: 8px; padding: 0.78rem 1rem;
  }
  button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .primary {
    background: var(--accent); color: var(--accent-fg); width: 100%;
    font-size: 0.95rem;
  }
  .primary:hover:not(:disabled) { background: #e4e4e7; }
  .primary:disabled { opacity: 0.55; cursor: default; }
  .primary.is-loading {
    display: inline-flex; align-items: center; justify-content: center;
    gap: 0.55rem; opacity: 1;
  }
  .primary.is-loading::before {
    content: ""; width: 1rem; height: 1rem; flex: 0 0 auto;
    border-radius: 999px; border: 2px solid rgba(0,0,0,0.22);
    border-top-color: var(--accent-fg);
    animation: spin 0.75s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .primary.is-loading::before { animation: none; }
  }
  .ghost {
    background: transparent; color: var(--muted);
    border: 1px solid var(--border-strong); padding: 0.35rem 0.7rem;
    font-size: 0.78rem; font-weight: 500; border-radius: 8px;
  }
  .ghost:hover:not(:disabled) { color: var(--text); border-color: var(--subtle); }
  pre {
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 0.9rem; font-size: 0.78rem; line-height: 1.5; overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #d4d4d8; margin: 0.5rem 0 1rem;
  }
  /* Advanced disclosure */
  .advanced { margin: 0 0 1rem; }
  .advanced > summary {
    list-style: none; cursor: pointer; user-select: none;
    display: flex; align-items: center; justify-content: center; gap: 0.35rem;
    color: var(--subtle); font-size: 0.8rem; font-weight: 500;
    padding: 0.5rem 0; text-align: center;
  }
  .advanced > summary::-webkit-details-marker { display: none; }
  .advanced > summary:hover { color: var(--muted); }
  .advanced > summary:focus-visible { outline: 2px solid var(--ring);
    outline-offset: 2px; border-radius: 6px; }
  .advanced > summary .chev {
    width: 7px; height: 7px; border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor; transform: rotate(45deg);
    transition: transform 0.15s ease; margin-top: -3px;
  }
  .advanced[open] > summary .chev { transform: rotate(225deg); margin-top: 2px; }
  .advanced-body {
    padding: 0.85rem 0.1rem 0.25rem;
  }
  .field { margin-bottom: 0.9rem; }
  .field:last-child { margin-bottom: 0; }
  .field label { display: block; font-size: 0.78rem; color: var(--muted);
    margin-bottom: 0.35rem; }
  .field input {
    width: 100%; padding: 0.6rem 0.7rem; font: inherit; color: var(--text);
    background: var(--panel-2); border: 1px solid var(--border-strong);
    border-radius: 8px;
  }
  .field input:focus-visible {
    outline: none; border-color: var(--ring);
    box-shadow: 0 0 0 3px rgba(250,250,250,0.12);
  }
  .connections {
    margin-top: 1.1rem; border-top: 1px solid var(--border);
    padding-top: 0.35rem;
  }
  .connections > summary {
    list-style: none; cursor: pointer; user-select: none;
    display: flex; align-items: center; gap: 0.55rem;
    min-height: 2.2rem; color: var(--muted); font-size: 0.82rem;
  }
  .connections > summary::-webkit-details-marker { display: none; }
  .connections > summary:focus-visible {
    outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 6px;
  }
  .connections-title { font-weight: 600; color: var(--muted); }
  .connections-state {
    margin-left: auto; color: var(--subtle); font-size: 0.73rem;
    line-height: 1;
  }
  .connections .chev {
    width: 7px; height: 7px; border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor; transform: rotate(45deg);
    transition: transform 0.15s ease; margin: -3px 0 0 0.15rem;
  }
  .connections[open] .chev { transform: rotate(225deg); margin-top: 2px; }
  .token-list { padding-top: 0.4rem; }
  .tok { display: flex; align-items: center; justify-content: space-between;
    gap: 0.75rem; padding: 0.6rem 0; border-bottom: 1px solid var(--border);
    font-size: 0.83rem; }
  .tok:last-child { border-bottom: none; }
  .tok .meta { color: var(--subtle); font-size: 0.74rem; margin-top: 0.1rem; }
  .tok.revoked { opacity: 0.45; }
  .empty-state {
    color: var(--subtle); font-size: 0.78rem; line-height: 1.45;
    padding: 0.3rem 0 0.45rem;
  }
  .msg { font-size: 0.83rem; padding: 0.7rem 0.8rem; border-radius: 8px;
    margin-bottom: 0.9rem; display: none; line-height: 1.4; }
  .msg.err { display: block; color: var(--error); background: var(--error-bg);
    border: 1px solid rgba(252,165,165,0.16); }
  .msg.ok { display: block; background: var(--ok-bg);
    border: 1px solid var(--ok-border); }
  .msg-title {
    display: block; color: var(--ok); font-size: 0.95rem;
    font-weight: 700; line-height: 1.25;
  }
  .msg-copy {
    display: block; color: rgba(134,239,172,0.72); font-size: 0.78rem;
    line-height: 1.4; margin-top: 0.2rem;
  }
  .result-panel { padding-top: 0.15rem; }
  .result-title {
    color: var(--text); font-size: 0.95rem; font-weight: 650;
    text-align: center; margin-bottom: 0.35rem;
  }
  .result-copy {
    color: var(--muted); font-size: 0.83rem; line-height: 1.45;
    text-align: center; margin: 0 auto 0.85rem; max-width: 34ch;
  }
  .section-label {
    color: var(--subtle); font-size: 0.7rem; font-weight: 650;
    letter-spacing: 0.08em; text-transform: uppercase; margin-top: 0.85rem;
  }
  @media (max-width: 480px) {
    body { align-items: flex-start; padding: 0.75rem; }
    .card { padding: 1rem; }
    .hero { padding: 0; }
    h1 { font-size: 1.3rem; }
    pre { font-size: 0.72rem; }
  }
  /* MCP URL display + per-host tabs (the non-dev path). */
  .mcp-url-block { margin: 0 0 1rem; }
  .url-row {
    display: flex; align-items: center; gap: 0.5rem;
    background: var(--panel-2); border: 1px solid var(--border-strong);
    border-radius: 8px; padding: 0.45rem 0.5rem 0.45rem 0.75rem;
  }
  .url-row code {
    flex: 1 1 auto; min-width: 0; overflow-x: auto; white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem; color: var(--text);
  }
  .url-row .ghost { flex: 0 0 auto; }
  .hosts {
    margin: 0 0 1rem; border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border); padding: 0.35rem 0;
  }
  .hosts > summary {
    list-style: none; cursor: pointer; user-select: none;
    display: flex; align-items: center; gap: 0.55rem;
    min-height: 2.2rem; color: var(--muted); font-size: 0.82rem;
  }
  .hosts > summary::-webkit-details-marker { display: none; }
  .hosts > summary:focus-visible {
    outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 6px;
  }
  .hosts > summary .chev {
    width: 7px; height: 7px; border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor; transform: rotate(45deg);
    transition: transform 0.15s ease; margin: -3px 0 0 0.15rem;
  }
  .hosts[open] > summary .chev { transform: rotate(225deg); margin-top: 2px; }
  .hosts-body { padding: 0.15rem 0 0.25rem; }
  .tabs {
    display: flex; flex-wrap: wrap; gap: 0.25rem;
    border-bottom: 1px solid var(--border); margin-bottom: 0.75rem;
    padding-bottom: 0.4rem;
  }
  .tab {
    background: transparent; color: var(--subtle);
    border: 1px solid transparent;
    padding: 0.35rem 0.65rem; font-size: 0.8rem; font-weight: 600;
    border-radius: 6px;
  }
  .tab:hover { color: var(--muted); background: var(--panel-soft); }
  .tab.is-active {
    color: var(--text); background: var(--panel-2);
    border-color: var(--border-strong);
  }
  .tab-panel { display: none; }
  .tab-panel.is-active { display: block; }
  .tab-panel ol { margin: 0 0 0.6rem 1.1rem; padding: 0; }
  .tab-panel li {
    margin-bottom: 0.3rem; font-size: 0.86rem; line-height: 1.5;
    color: var(--muted);
  }
  .tab-panel li strong { color: var(--text); font-weight: 650; }
  .tab-panel a {
    color: var(--text); text-decoration: underline;
    text-underline-offset: 2px;
  }
  .tab-panel p {
    font-size: 0.84rem; color: var(--muted); margin: 0.4rem 0;
    line-height: 1.5;
  }
  .tab-panel .hint {
    font-size: 0.78rem; color: var(--subtle); margin-top: 0.5rem;
  }
  .tab-panel code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem; color: var(--text);
    background: var(--panel-2); padding: 0.05rem 0.3rem;
    border-radius: 4px;
  }
  .tab-panel pre { margin: 0.4rem 0 0.5rem; }
  /* Per-tab primary CTA — visually distinct from the static-token mint
   * button below. Either a link (Open Claude →) or a copy command button.
   */
  .primary-link {
    display: inline-flex; align-items: center; justify-content: center;
    gap: 0.35rem; min-height: 36px; padding: 0.45rem 0.85rem;
    background: var(--panel-2); color: var(--text);
    border: 1px solid var(--border-strong); border-radius: 8px;
    font-size: 0.86rem; font-weight: 650; text-decoration: none;
    cursor: pointer; width: auto; max-width: 100%; text-align: center;
    margin: 0.5rem 0 0.2rem;
  }
  .tab-panel a.primary-link {
    color: var(--text); text-decoration: none;
  }
  .primary-link:hover {
    background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.2);
  }
  .primary-link.compact { min-width: 0; }
  .copy-flash {
    color: var(--ok) !important;
    border-color: var(--ok-border) !important;
  }
  .static-token-mint .static-token-body { padding-top: 0.5rem; }
  @media (min-width: 560px) {
    .card { max-width: 580px; }
  }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="card">
  <div class="hero">
    <div class="flow" role="img" aria-label="${localize(connectMessages.authorizeLabel)}">
      <span class="tile" aria-hidden="true">
        ${flowMarkSvg}
      </span>
      <span class="conn" aria-hidden="true"></span>
      <span class="tile" aria-hidden="true">
        ${flowTerminalSvg}
      </span>
    </div>

    <h1>${safeUserCode ? localize(connectMessages.terminalTitle) : localize(connectMessages.assistantTitle)}</h1>
    <p class="identity">
      <span>${localize(connectMessages.signedInAs)} <strong>${safeEmail}</strong></span>
    </p>
  </div>

  <div id="codeCallout" class="device-strip ${safeUserCode ? "" : "hidden"}">
    <span class="label">${localize(connectMessages.deviceCode)}</span>
    <span class="value" id="userCodeValue">${safeUserCode}</span>
  </div>

  ${setupHtml}

  ${
    safeUserCode
      ? `<div id="staticTokenMint">
    <div id="msg" class="msg" role="status" aria-live="polite"></div>
    <div id="mintForm">
      <button id="authorizeBtn" class="primary">${localize(connectMessages.authorizeDevice)}</button>
    </div>
  </div>`
      : `<details id="staticTokenMint" class="connections static-token-mint">
    <summary>
      <span class="connections-title">${escapeHtml(staticTokenFallback.title)}</span>
      <span class="chev" aria-hidden="true"></span>
    </summary>
    <div class="static-token-body">
      <div id="msg" class="msg" role="status" aria-live="polite"></div>
      <div id="mintForm">
        <button id="authorizeBtn" class="primary">${localize(connectMessages.createToken)}</button>
        ${tokenAdvancedOptionsHtml}
      </div>
      <div id="result" class="result-panel hidden">
        <div class="result-title">${escapeHtml(staticTokenFallback.resultTitle)}</div>
        <p class="result-copy" id="resultMsg">${escapeHtml(staticTokenFallback.resultCopy)}</p>
        <div class="section-label">${localize(messages.mcpConfig)}</div>
        <pre id="mcpJson"></pre>
        <details class="advanced">
          <summary>
            ${localize(connectMessages.terminalAlternative)}
            <span class="chev" aria-hidden="true"></span>
          </summary>
          <div class="advanced-body">
            <pre id="cliLine"></pre>
          </div>
        </details>
      </div>
    </div>
  </details>`
  }

  <details id="connections" class="connections">
    <summary>
      <span class="connections-title">${localize(connectMessages.existingConnections)}</span>
      <span id="connectionsState" class="connections-state hidden" aria-live="polite"></span>
      <span class="chev" aria-hidden="true"></span>
    </summary>
    <div id="tokenList" class="token-list"><div class="empty-state">${localize(connectMessages.checkingConnections)}</div></div>
  </details>
</div>
<script>
(function () {
  var BASE = ${JSON.stringify(joinAppPath(connectBasePath, MCP_PUBLIC_ROUTE_PREFIX + "/connect"))};
  var USER_CODE = ${JSON.stringify(safeUserCode || null)};
  var COPY = ${JSON.stringify(connectMessages)};
  var msgEl = document.getElementById("msg");
  var connectionsEl = document.getElementById("connections");
  var connectionsStateEl = document.getElementById("connectionsState");

  // Tab switching for the per-host instructions block.
  var tabBtns = document.querySelectorAll(".tabs .tab");
  var tabPanels = document.querySelectorAll(".tab-panel");
  for (var i = 0; i < tabBtns.length; i++) {
    tabBtns[i].addEventListener("click", function (ev) {
      var btn = ev.currentTarget;
      var name = btn.getAttribute("data-tab");
      for (var j = 0; j < tabBtns.length; j++) {
        var active = tabBtns[j] === btn;
        tabBtns[j].classList.toggle("is-active", active);
        tabBtns[j].setAttribute("aria-selected", active ? "true" : "false");
      }
      for (var k = 0; k < tabPanels.length; k++) {
        tabPanels[k].classList.toggle(
          "is-active",
          tabPanels[k].getAttribute("data-panel") === name,
        );
      }
    });
  }

  // Copy buttons — any element with data-copy="<id>" copies that node's text.
  document.addEventListener("click", function (ev) {
    var btn = ev.target && ev.target.closest && ev.target.closest("[data-copy]");
    if (!btn) return;
    var node = document.getElementById(btn.getAttribute("data-copy"));
    if (!node || !navigator.clipboard) return;
    navigator.clipboard.writeText(node.textContent || "").then(function () {
      var prev = btn.textContent;
      btn.textContent = ${JSON.stringify(messages.mcpCopied)};
      btn.classList.add("copy-flash");
      setTimeout(function () {
        btn.textContent = prev;
        btn.classList.remove("copy-flash");
      }, 1400);
    });
  });
  function showMsg(text, kind, title) {
    msgEl.textContent = "";
    if (title) {
      var titleEl = document.createElement("strong");
      titleEl.className = "msg-title";
      titleEl.textContent = title;
      msgEl.appendChild(titleEl);
      var copyEl = document.createElement("span");
      copyEl.className = "msg-copy";
      copyEl.textContent = text;
      msgEl.appendChild(copyEl);
    } else {
      msgEl.textContent = text;
    }
    msgEl.className = "msg " + (kind || "err");
  }
  function clearMsg() { msgEl.className = "msg"; msgEl.textContent = ""; }

  function setButtonLoading(btn, text) {
    if (!btn.dataset.idleText) btn.dataset.idleText = btn.textContent || "";
    btn.textContent = text;
    btn.classList.add("is-loading");
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
  }

  function resetButtonLoading(btn) {
    btn.disabled = false;
    btn.classList.remove("is-loading");
    btn.removeAttribute("aria-busy");
    if (btn.dataset.idleText) btn.textContent = btn.dataset.idleText;
  }

  function renderResult(data) {
    document.getElementById("mintForm").classList.add("hidden");
    var entry = {};
    entry[data.serverName] = data.mcpServerEntry;
    document.getElementById("mcpJson").textContent =
      JSON.stringify({ mcpServers: entry }, null, 2);
    document.getElementById("cliLine").textContent = data.cli;
    document.getElementById("result").classList.remove("hidden");
  }

  async function postJson(path, body) {
    var res = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body || {})
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, data: data };
  }

  function deviceAuthorizationError(response) {
    if (response.status === 404) return COPY.unknownDeviceCode;
    if (response.status === 410) return COPY.expiredDeviceCode;
    if (response.status === 409) return COPY.alreadyUsedDeviceCode;
    return COPY.couldNotAuthorize;
  }

  async function loadTokens() {
    var listEl = document.getElementById("tokenList");
    try {
      var res = await fetch(BASE + "/tokens", { credentials: "same-origin" });
      if (!res.ok) {
        connectionsStateEl.textContent = COPY.unavailable;
        connectionsStateEl.classList.remove("hidden");
        listEl.innerHTML = '<div class="empty-state">' + COPY.couldNotLoadConnections + '</div>';
        return;
      }
      var data = await res.json();
      var tokens = (data && data.tokens) || [];
      if (!tokens.length) {
        connectionsStateEl.textContent = "";
        connectionsStateEl.classList.add("hidden");
        connectionsEl.open = false;
        listEl.innerHTML = '<div class="empty-state">' + COPY.emptyConnections + '</div>';
        return;
      }
      var activeCount = tokens.filter(function (t) { return !t.revokedAt; }).length;
      connectionsStateEl.textContent = activeCount ? String(activeCount) : "";
      connectionsStateEl.classList.toggle("hidden", activeCount === 0);
      listEl.innerHTML = "";
      tokens.forEach(function (t) {
        var div = document.createElement("div");
        div.className = "tok" + (t.revokedAt ? " revoked" : "");
        var when = t.createdAt ? new Date(t.createdAt).toLocaleString() : "";
        var used = t.lastUsedAt ? " · " + COPY.lastUsed + " " + new Date(t.lastUsedAt).toLocaleString() : "";
        var left = document.createElement("div");
        var label = document.createElement("div");
        label.textContent = t.label || COPY.unlabeled;
        var meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = (t.revokedAt ? COPY.revoked + " · " : COPY.created + " ") + when + used;
        left.appendChild(label); left.appendChild(meta);
        div.appendChild(left);
        if (!t.revokedAt) {
          var btn = document.createElement("button");
          btn.className = "ghost";
          btn.textContent = COPY.revoke;
          btn.onclick = async function () {
            btn.disabled = true;
            var r = await postJson("/tokens/revoke", { id: t.id });
            if (r.ok) { loadTokens(); }
            else { btn.disabled = false; showMsg(COPY.couldNotRevoke); }
          };
          div.appendChild(btn);
        }
        listEl.appendChild(div);
      });
    } catch (e) {
      connectionsStateEl.textContent = COPY.unavailable;
      connectionsStateEl.classList.remove("hidden");
      listEl.innerHTML = '<div class="empty-state">' + COPY.couldNotLoadConnections + '</div>';
    }
  }

  document.getElementById("authorizeBtn").onclick = async function () {
    var btn = this;
    setButtonLoading(btn, USER_CODE ? COPY.authorizingDevice : COPY.creatingToken);
    clearMsg();
    try {
      if (USER_CODE) {
        var a = await postJson("/device/authorize", { user_code: USER_CODE });
        if (!a.ok) {
          resetButtonLoading(btn);
          showMsg(deviceAuthorizationError(a));
          return;
        }
        showMsg(COPY.finishingConnection, "ok", COPY.deviceAuthorized);
        btn.classList.add("hidden");
        document.getElementById("mintForm").classList.add("hidden");
        var cc = document.getElementById("codeCallout");
        if (cc) cc.classList.add("hidden");
        // The token is minted a few seconds later, when the CLI next polls
        // /device/poll — so a single loadTokens() here runs BEFORE the row
        // exists and the list would wrongly read "No connections yet" until
        // a manual reload. Snapshot the EXISTING non-revoked token ids first
        // so we announce "Connected" only when THIS device's freshly-minted
        // token appears — a user who already has tokens must not get a false
        // success the instant they authorize.
        var priorIds = {};
        try {
          var pr = await fetch(BASE + "/tokens", { credentials: "same-origin" });
          if (pr.ok) {
            var pd = await pr.json();
            ((pd && pd.tokens) || []).forEach(function (t) {
              if (!t.revokedAt) priorIds[t.id] = true;
            });
          }
        } catch (e) {}
        loadTokens();
        var tries = 0;
        var iv = setInterval(async function () {
          tries++;
          try {
            var res = await fetch(BASE + "/tokens", { credentials: "same-origin" });
            if (res.ok) {
              var data = await res.json();
              var fresh = ((data && data.tokens) || []).filter(function (t) {
                return !t.revokedAt && !priorIds[t.id];
              });
              if (fresh.length > 0) {
                clearInterval(iv);
                showMsg(COPY.connectedDescription, "ok", COPY.connected);
                loadTokens();
                return;
              }
            }
          } catch (e) {}
          if (tries >= 30) {
            // No new token appeared in the window — e.g. the loopback
            // dev-open path writes a header-only config and never mints.
            // Don't claim "Connected" (we couldn't confirm a device token);
            // keep the "authorized" message and just refresh the list.
            clearInterval(iv);
            loadTokens();
          }
        }, 2000);
        return;
      } else {
        var labelEl = document.getElementById("label");
        var ttlEl = document.getElementById("ttl");
        var label = labelEl ? labelEl.value || undefined : undefined;
        var ttlDays = ttlEl ? parseInt(ttlEl.value, 10) || undefined : undefined;
        var m = await postJson("/token", { label: label, ttlDays: ttlDays });
        if (!m.ok) {
          resetButtonLoading(btn);
          showMsg(COPY.couldNotCreate);
          return;
        }
        renderResult(m.data);
      }
      loadTokens();
    } catch (e) {
      resetButtonLoading(btn);
      showMsg(COPY.networkError);
    }
  };

  loadTokens();
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Handler — single entry point; core-routes-plugin dispatches the subpath.
// ---------------------------------------------------------------------------

/**
 * Handle a `/mcp/connect[...]` request. The legacy
 * `/_agent-native/mcp/connect` alias is mounted too. `subpath` is the part
 * after `/connect` (empty string = the page itself, otherwise e.g. `/token`,
 * `/device/start`). The core-routes-plugin computes it from the stripped event
 * path so this module stays mount-agnostic.
 */
export async function handleMcpConnect(
  event: H3Event,
  subpath: string,
  options: McpConnectRouteOptions = {},
): Promise<Response> {
  const method = getMethod(event);
  const origin = deriveOrigin(event);
  const basePath = configuredBasePath();
  const appUrl = `${origin}${basePath}`;
  let requestUrl: URL | null = null;
  try {
    requestUrl = new URL(
      event.node?.req?.url ?? event.path ?? "/",
      "http://an.invalid",
    );
  } catch {
    requestUrl = null;
  }
  const requestedLocale = normalizeLocaleCode(
    requestUrl?.searchParams.get("locale"),
  );
  const locale = resolveLocaleFromRequest({
    acceptLanguage: getHeader(event, "accept-language"),
    preference: requestedLocale ?? undefined,
  }).locale;
  const sub = ("/" + subpath.replace(/^\/+/, "").replace(/\/+$/, "")).replace(
    /^\/$/,
    "",
  );

  // ---- The connect page (GET) ------------------------------------------
  if (sub === "") {
    if (method !== "GET" && method !== "HEAD") {
      return json({ error: "Method not allowed" }, 405);
    }
    const session = await getSession(event);
    if (!session?.email) {
      // Serve the SAME login form the guard would, at this same URL — the
      // login form reloads window.location so we re-enter here authed.
      const loginHtml = getConfiguredLoginHtml(event);
      if (loginHtml) return html(loginHtml, 200);
      // Fully-open app (no auth guard): nothing to scope a mint to.
      return html(
        renderConnectPage({
          connectBasePath: basePath,
          email: "(no auth configured)",
          appName: options.appName || appLabel(appUrl, options),
          appUrl,
          serverId: serverName(appUrl, options),
          userCode: null,
          locale,
          requestedGuide: requestUrl?.searchParams.get("guide") ?? null,
        }),
      );
    }
    let userCode: string | null = null;
    const raw = requestUrl?.searchParams.get("user_code");
    if (raw && USER_CODE_RE.test(raw)) userCode = raw;
    return html(
      renderConnectPage({
        connectBasePath: basePath,
        email: session.email,
        appName: options.appName || appLabel(appUrl, options),
        appUrl,
        serverId: serverName(appUrl, options),
        userCode,
        locale,
        requestedGuide: requestUrl?.searchParams.get("guide") ?? null,
      }),
    );
  }

  // ---- POST /token  (session-required) ---------------------------------
  if (sub === "/token") {
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    const session = await getSession(event);
    if (!session?.email) return json({ error: "Unauthorized" }, 401);
    if (!process.env.A2A_SECRET?.trim() && canUseDevOpenConnect(event)) {
      return json(
        mcpResultPayload(appUrl, options, { ownerEmail: session.email }),
      );
    }
    const body = ((await readBody(event).catch(() => ({}))) ?? {}) as {
      label?: unknown;
      ttlDays?: unknown;
      fullCatalog?: unknown;
    };
    const label =
      typeof body.label === "string" && body.label.trim()
        ? body.label.trim().slice(0, 120)
        : null;
    const ttlDays = clampTtlDays(body.ttlDays);
    const catalogScope: "full" | undefined =
      body.fullCatalog === true || body.fullCatalog === "true"
        ? "full"
        : undefined;
    try {
      const { token } = await mintConnectToken({
        email: session.email,
        orgId: session.orgId,
        label,
        ttlDays,
        appUrl,
        ...(catalogScope ? { catalogScope } : {}),
      });
      return json(mcpResultPayload(appUrl, options, { token }));
    } catch {
      return json({ error: "Failed to mint token." }, 500);
    }
  }

  // ---- POST /device/start  (UNAUTH) ------------------------------------
  if (sub === "/device/start") {
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    try {
      const row = await createDeviceCode();
      const verificationUri = `${appUrl}${MCP_PUBLIC_ROUTE_PREFIX}/connect`;
      return json({
        device_code: row.deviceCode,
        user_code: row.userCode,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?user_code=${row.userCode}`,
        interval: DEVICE_POLL_INTERVAL_S,
        expires_in: Math.floor(DEVICE_CODE_TTL_MS / 1000),
      });
    } catch (err: any) {
      if (err?.message === "RATE_LIMITED") {
        return json({ error: "Rate limited. Try again shortly." }, 429);
      }
      return json({ error: "Could not start device flow." }, 500);
    }
  }

  // ---- POST /device/authorize  (session-required) ----------------------
  if (sub === "/device/authorize") {
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    const session = await getSession(event);
    if (!session?.email) return json({ error: "Unauthorized" }, 401);
    const body = ((await readBody(event).catch(() => ({}))) ?? {}) as {
      user_code?: unknown;
    };
    const userCode =
      typeof body.user_code === "string" ? body.user_code.trim() : "";
    if (!USER_CODE_RE.test(userCode)) {
      return json({ error: "Invalid user code." }, 400);
    }
    const orgId =
      typeof session.orgId === "string" && session.orgId.trim()
        ? session.orgId.trim()
        : null;
    const result = await approveDeviceCode(userCode, session.email, orgId);
    if (result === "not_found") {
      return json({ error: "Unknown device code." }, 404);
    }
    if (result === "expired") {
      return json({ error: "This device code has expired." }, 410);
    }
    if (result === "already") {
      return json({ error: "This device code was already used." }, 409);
    }
    return json({ status: "approved" });
  }

  // ---- POST /device/poll  (UNAUTH) -------------------------------------
  if (sub === "/device/poll") {
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    const body = ((await readBody(event).catch(() => ({}))) ?? {}) as {
      device_code?: unknown;
    };
    const deviceCode =
      typeof body.device_code === "string" ? body.device_code : "";
    if (!deviceCode) return json({ error: "device_code required" }, 400);
    const row = await getDeviceCode(deviceCode);
    if (!row) return json({ status: "not_found" }, 404);
    if (row.status === "consumed") return json({ status: "consumed" });
    if (
      row.status === "expired" ||
      (row.expiresAt != null && row.expiresAt < Date.now())
    ) {
      if (row.status !== "expired") void expireDeviceCode(deviceCode);
      return json({ status: "expired" });
    }
    if (
      row.status === "pending" ||
      row.status === "minting" ||
      !row.ownerEmail
    ) {
      return json({ status: "pending" });
    }
    // status === "approved" && ownerEmail bound → mint exactly once.
    if (!process.env.A2A_SECRET?.trim() && canUseDevOpenConnect(event)) {
      const consumed = await consumeDeviceCode(
        deviceCode,
        `dev-open-${randomUUID()}`,
      );
      if (!consumed) {
        const fresh = await getDeviceCode(deviceCode);
        if (fresh?.status === "consumed") return json({ status: "consumed" });
        return json({ status: "pending" });
      }
      return json({
        status: "approved",
        ...mcpResultPayload(appUrl, options, {
          ownerEmail: row.ownerEmail,
        }),
      });
    }
    try {
      const jti = randomUUID();
      // Claim a retryable minting state first. If signing or recording fails,
      // release the row back to approved so the CLI can poll again.
      const claimed = await claimDeviceCodeForMint(deviceCode, jti);
      if (!claimed) {
        const fresh = await getDeviceCode(deviceCode);
        if (fresh?.status === "consumed") return json({ status: "consumed" });
        return json({ status: "pending" });
      }
      let token: string;
      try {
        const orgDomain = await resolveOrgDomain(claimed.orgId ?? undefined);
        token = await signConnectToken({
          ownerEmail: claimed.ownerEmail!,
          orgId: claimed.orgId,
          orgDomain,
          appUrl,
          expiresIn: `${DEFAULT_TOKEN_TTL_DAYS}d`,
          jti,
        });
        await recordMintedToken({
          jti,
          ownerEmail: claimed.ownerEmail!,
          orgId: claimed.orgId,
          label: "Device connection",
        });
        if (!(await finishDeviceCodeMint(deviceCode, jti))) {
          return json({ status: "pending" });
        }
      } catch (err) {
        await releaseDeviceCodeMint(deviceCode, jti);
        throw err;
      }
      return json({
        status: "approved",
        ...mcpResultPayload(appUrl, options, { token }),
      });
    } catch {
      return json({ status: "error", error: "Failed to mint token." }, 500);
    }
  }

  // ---- GET /tokens  (session-required) ---------------------------------
  if (sub === "/tokens") {
    if (method !== "GET") return json({ error: "Method not allowed" }, 405);
    const session = await getSession(event);
    if (!session?.email) return json({ error: "Unauthorized" }, 401);
    const rows = await listTokens(session.email);
    return json({
      tokens: rows.map((r) => ({
        id: r.id,
        label: r.label,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        revokedAt: r.revokedAt,
      })),
    });
  }

  // ---- POST /tokens/revoke  (session-required) -------------------------
  if (sub === "/tokens/revoke") {
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    const session = await getSession(event);
    if (!session?.email) return json({ error: "Unauthorized" }, 401);
    const body = ((await readBody(event).catch(() => ({}))) ?? {}) as {
      id?: unknown;
    };
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return json({ error: "id required" }, 400);
    const revoked = await revokeToken(session.email, id);
    return json({ ok: revoked });
  }

  return json({ error: "Not found" }, 404);
}
