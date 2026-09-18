# Fork delta on main

This repository is a fork of BuilderIO/agent-native, not a pinned mirror.
It tracks upstream main and takes upstream merges over time. This file is
the fork delta ledger: everything this fork carries that upstream does not.

Base: upstream main e9065001b4c5c57da8762c1e5265c068db00acf8, 17 commits
past the @agent-native/core@0.181.0 release batch. Move the base line in
the same merge commit that brings upstream in, and keep the sha and the
nearest tag note together.

Rules for entries:

- One line per delta, added in the same commit as the change.
- Format: title | reason | ADR or issue | upstream PR or why not
- Prefer upstreaming. If a delta can be a pull request upstream, open it
  there and record it here.
- Drop an entry only when upstream has merged the change, and say so in
  the commit that removes it.
- New apps live under templates/fb-* and stay additive so upstream merges
  do not conflict with them.
- Write without em or en dashes, without dates, and without durations.

## Ledger

FutureBuild rebrand to FB Factory | Operator-facing rename: display names,
copy catalogs with locale siblings, branding assets under
packages/core/src/assets/branding and every public/ surface, favicon and
icon regeneration, inverted brand guard | internal branding decision |
not for upstream
Purple accent theme for enabled apps | dispatch, assets, and tasks carry
the platform accent (hsl 259 97% 65%) in their theme tokens and catalog
colors | internal branding decision | not for upstream
Workspace app Dockerfile and dockerignore | root Dockerfile builds one
image per template app from the fork; needed for the factory deployment |
internal deployment decision | not for upstream
templates/fb-* apps | Additive micro apps under templates/fb-* designed
to never conflict with upstream merges | product decision | not for
upstream (additive only)
