#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execGuardCommand } from "./lib/changed-lines.mjs";

const SELF_PATHS = new Set([
  "scripts/guard-agent-native-brand.ts",
  "scripts/guard-agent-native-brand.test.ts",
]);
const LEGACY_ASSET_RE = /\bagent[ \t-]+native(?:[ \t]+nightly)?-/gi;
// The product name is "FB Factory". Any capitalized spelling of the upstream
// name in prose is a violation; lowercase forms stay legal because they are
// the technical namespace (package scope, CLI binary, routes, env vars,
// asset filenames, agentnative scheme). No trailing word boundary on purpose:
// CJK locale copy attaches particles directly to the name.
const OLD_NAME_RE = /Agent-[Nn]ative|Agent[ \t]+[Nn]ative|AGENT-NATIVE/;
const BRAND_PRAGMA_RE = /\/\/\s*agent-native-brand-ok:/i;
const CORRECT_FACTORY_RE = /FB Factory/g;
// Wrong-casing forms of the product name. Spaced forms are matched on the
// whole line so word splitting cannot hide them; single-token forms are
// matched per token. The lowercase hyphenated and underscored forms
// (fb-factory, fb_factory) are repository and directory identifiers and
// stay legal.
const WRONG_FACTORY_SPACED_RE = /\b(?:FB|Fb|fb)[ \t]+[Ff]actory\b/;
const WRONG_FACTORY_TOKEN_RE =
  /^(?:FB|Fb|fb)[_-]?[Ff]actory$|^(?:FBFactory|fbfactory|FBfactory)$/;

// Paths that keep upstream wording on purpose: release history, CI workflow
// metadata, repo skills, the upstream docs corpus and its examples, the
// skills shipped inside template apps, and template apps this deployment
// retires (kept for upstream fidelity). The i18n term lists and baselines
// cite the old name as data.
const EXEMPT_PATH_RES: RegExp[] = [
  /(^|\/)CHANGELOG\.md$/,
  /(^|\/)changelog\//,
  /^\.github\//,
  /(^|\/)\.agents\//,
  /^packages\/core\/docs\/content\//,
  /^packages\/docs\/public\/examples\//,
  /^scripts\/i18n-no-translate-terms\.txt$/,
  /^scripts\/i18n-localized-docs-baseline\.txt$/,
];
// Template apps this deployment ships or builds get checked; the rest keep
// upstream wording.
const CHECKED_TEMPLATE_RE =
  /^templates\/(?:dispatch|assets|tasks|fb-[a-z0-9-]+)\//;
const TEMPLATE_SKILLS_RE = /^templates\/[a-z0-9-]+\/\.agents\//;

export interface BrandFile {
  path: string;
  text: string;
}

export function isExemptBrandPath(filePath: string): boolean {
  if (SELF_PATHS.has(filePath)) return true;
  // Release history keeps upstream wording even inside checked template apps.
  if (
    /(^|\/)CHANGELOG\.md$/.test(filePath) ||
    /(^|\/)changelog\//.test(filePath)
  ) {
    return true;
  }
  // Template skill directories keep upstream wording; every other template
  // file is exempt only when the template is retired.
  if (filePath.startsWith("templates/")) {
    if (TEMPLATE_SKILLS_RE.test(filePath)) return true;
    return !CHECKED_TEMPLATE_RE.test(filePath);
  }
  return EXEMPT_PATH_RES.some((re) => re.test(filePath));
}

function hasBrandPragma(lines: readonly string[], lineNumber: number): boolean {
  return (
    BRAND_PRAGMA_RE.test(lines[lineNumber - 1] ?? "") ||
    BRAND_PRAGMA_RE.test(lines[lineNumber - 2] ?? "")
  );
}

function hasFactoryCasingViolation(line: string): boolean {
  const lineWithoutCorrectFactory = line.replace(CORRECT_FACTORY_RE, "\u0000");
  if (WRONG_FACTORY_SPACED_RE.test(lineWithoutCorrectFactory)) return true;
  return lineWithoutCorrectFactory
    .split(/[ \t]+/)
    .some(
      (token) =>
        token !== "fb-factory" &&
        token !== "fb_factory" &&
        WRONG_FACTORY_TOKEN_RE.test(token),
    );
}

export function findBrandViolations(files: readonly BrandFile[]): string[] {
  const violations: string[] = [];

  for (const file of files) {
    if (isExemptBrandPath(file.path)) continue;

    const lines = file.text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (hasBrandPragma(lines, index + 1)) continue;

      const lineWithoutLegacyAssets = line.replace(LEGACY_ASSET_RE, "legacy-");
      if (
        OLD_NAME_RE.test(lineWithoutLegacyAssets) ||
        hasFactoryCasingViolation(line)
      ) {
        violations.push(`${file.path}:${index + 1}`);
      }
    }
  }

  return violations;
}

function readCandidateFiles(): BrandFile[] {
  const files = execGuardCommand(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z"],
    { encoding: "utf8", maxBuffer: 1 << 28 },
  )
    .split("\0")
    .filter(Boolean);

  return files.flatMap((file) => {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return [];
    const buffer = readFileSync(file);
    if (buffer.includes(0)) return [];
    return [{ path: file, text: buffer.toString("utf8") }];
  });
}

export function main(): void {
  const files = readCandidateFiles();
  const violations = findBrandViolations(files);
  if (violations.length > 0) {
    console.error(
      [
        "FB Factory branding violations found:",
        "",
        ...violations.map((violation) => `  - ${violation}`),
        "",
        'Use "FB Factory" for the product name. Any capitalized spelling of',
        "the upstream product name in prose is a violation; keep technical",
        "identifiers (package scopes, CLI binary, routes, env vars, asset",
        "filenames) unchanged. Add an agent-native-brand-ok comment only with",
        "a visible reason.",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  console.log(`guard:agent-native-brand: clean (${files.length} files)`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
