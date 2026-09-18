import { describe, expect, it } from "vitest";

import {
  findBrandViolations,
  isExemptBrandPath,
} from "./guard-agent-native-brand.js";

// Build old-brand fixture strings from fragments so this file never carries a
// literal violation itself.
const oldDashed = ["Agent", "Native"].join("-");
const oldSpaced = ["Agent", "Native"].join(" ");
const oldTitleCase = ["Agent", "native"].join("-");

describe("agent-native brand guard", () => {
  it("rejects capitalized spellings of the upstream product name", () => {
    expect(
      findBrandViolations([
        {
          path: "fixture.ts",
          text: [
            `Powered by ${oldDashed}`,
            `Welcome to ${oldSpaced}`,
            `Built with ${oldTitleCase}`,
          ].join("\n"),
        },
      ]),
    ).toEqual(["fixture.ts:1", "fixture.ts:2", "fixture.ts:3"]);
  });

  it("rejects the upstream name even when CJK particles attach directly", () => {
    expect(
      findBrandViolations([
        {
          path: "fixture.ts",
          text: `${oldDashed}\uB294 \uC5B4\uB5BB\uAC8C \uC2DC\uC791\uD558\uB098\uC694?`,
        },
      ]),
    ).toEqual(["fixture.ts:1"]);
  });

  it("allows technical identifiers and lowercase CLI or route spellings", () => {
    expect(
      findBrandViolations([
        {
          path: "fixture.ts",
          text: [
            'import { defineAction } from "@agent-native/core"',
            "https://agent-native.com",
            "https://beta.plan.agent-native.com/pricing",
            "https://github.com/BuilderIO/agent-native#readme",
            "agentnative://oauth-complete",
            "AGENT_NATIVE_GUARD_CONCURRENCY",
            "agent-native dev",
            "agent-native-icon-dark.svg",
            "agent-native.json",
            "GET /_agent-native/ping",
            "AgentNativeIcon",
          ].join("\n"),
        },
      ]),
    ).toEqual([]);
  });

  it("allows the legacy desktop asset aliases", () => {
    const nightlyAsset = oldSpaced + " Nightly-arm64.dmg";
    const legacyAsset = ["agent", "native"].join(" ") + "-x64.dmg";

    expect(
      findBrandViolations([
        { path: "fixture.ts", text: nightlyAsset },
        { path: "fixture.ts", text: legacyAsset },
      ]),
    ).toEqual([]);
  });

  it("rejects incorrect FB Factory casing but allows canonical and identifier forms", () => {
    expect(
      findBrandViolations([
        {
          path: "fixture.ts",
          text: ["Fb Factory", "FBFactory", "FB-Factory", "FB factory"].join(
            "\n",
          ),
        },
      ]),
    ).toEqual(["fixture.ts:1", "fixture.ts:2", "fixture.ts:3", "fixture.ts:4"]);

    expect(
      findBrandViolations([
        {
          path: "fixture.ts",
          text: [
            "FB Factory",
            "fb-factory",
            "templates/fb-ops",
            "Ask me anything about FB Factory",
          ].join("\n"),
        },
      ]),
    ).toEqual([]);
  });

  it("allows reviewed non-brand fixture exceptions via the pragma", () => {
    const malformedOcr = ["agent", "native"].join(" ") + " conlent";
    const keptProfileDir = oldSpaced + " Dev";

    expect(
      findBrandViolations([
        {
          path: "fixture.rs",
          text: `// agent-native-brand-ok: intentional OCR near miss\n${malformedOcr}`,
        },
        {
          path: "fixture.ts",
          text: `// agent-native-brand-ok: upstream profile directory name\n${keptProfileDir}`,
        },
      ]),
    ).toEqual([]);
  });

  it("exempts release history, repo skills, the docs corpus, and retired templates", () => {
    expect(isExemptBrandPath("packages/core/CHANGELOG.md")).toBe(true);
    expect(isExemptBrandPath("packages/core/changelog/archive/x.md")).toBe(
      true,
    );
    expect(isExemptBrandPath(".github/workflows/ci.yml")).toBe(true);
    expect(isExemptBrandPath(".agents/skills/actions/SKILL.md")).toBe(true);
    expect(isExemptBrandPath("templates/clips/.agents/skills/x/SKILL.md")).toBe(
      true,
    );
    expect(isExemptBrandPath("packages/core/docs/content/index.mdx")).toBe(
      true,
    );
    expect(
      isExemptBrandPath("packages/core/docs/content/locales/ja/index.mdx"),
    ).toBe(true);
    expect(
      isExemptBrandPath("packages/docs/public/examples/chat/README.md"),
    ).toBe(true);
    expect(isExemptBrandPath("templates/clips/app/lib/x.ts")).toBe(true);
    expect(isExemptBrandPath("templates/plan/actions/ask.ts")).toBe(true);
    expect(isExemptBrandPath("scripts/guard-agent-native-brand.test.ts")).toBe(
      true,
    );

    expect(isExemptBrandPath("templates/dispatch/app/i18n-data.ts")).toBe(
      false,
    );
    expect(isExemptBrandPath("templates/assets/server/db/schema.ts")).toBe(
      false,
    );
    expect(isExemptBrandPath("templates/fb-ops/actions/deploy-status.ts")).toBe(
      false,
    );
    expect(
      isExemptBrandPath("packages/core/src/client/auth/AuthPage.tsx"),
    ).toBe(false);
  });
});
