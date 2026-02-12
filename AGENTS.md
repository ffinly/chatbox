# AGENTS.md — Chatbox Open Source Repo

## Repository Relationship

| Repo | URL | Purpose |
|------|-----|---------|
| **chatbox** (this repo) | `chatboxai/chatbox` | Open-source Community Edition (CE) |
| **chatbox-pro** | `chatboxai/chatbox-pro` | Closed-source Pro edition |

Git remotes configured locally:
- `origin` → chatbox (open-source)
- `pro` → chatbox-pro (closed-source)
- `pre-open` → chatbox-pre-open (staging/pre-release)

## Pro → Open Source Sync Workflow (Cherry-Pick)

### Overview

After each Pro release, new commits are cherry-picked from `pro/main` to `origin/main` to publish the open-source version. The process is **manual** — no automation scripts exist.

### Sync Cadence

Sync happens at major/minor release milestones (e.g., after Pro releases 1.19.0, cherry-pick to open-source to publish 1.19.0-ce).

### Step-by-Step Procedure

#### 1. Preparation

```bash
# Fetch latest from both remotes
git fetch origin
git fetch pro

# Identify the sync range
# Find the last synced release on open-source main
git log origin/main --oneline -5
# Find the corresponding commit on pro/main
git log pro/main --oneline -5

# Example: open-source is at 1.18.1, pro is at 1.19.0
# Find the pro commit for the last synced release
git log --oneline pro/main | grep "release 1.18.1"
# → 5cf7ef6e release 1.18.1

# List all commits in the range (chronological order)
git log --oneline --ancestry-path <last-synced-hash>..<new-release-hash> --reverse
```

#### 2. Generate Pick List

Categorize every commit as PICK, SKIP, or CAUTION:

```bash
# Full commit list in chronological order
git log --oneline --ancestry-path <from>..<to> --reverse > /tmp/pick-list.txt

# Identify commits ONLY touching mobile files (auto-skip)
for hash in $(git log --format=%H --ancestry-path <from>..<to>); do
  files=$(git diff-tree --no-commit-id --name-only -r $hash)
  if echo "$files" | grep -qE '^(ios/|android/)' && \
     ! echo "$files" | grep -vqE '^(ios/|android/)' | grep -q .; then
    echo "SKIP (mobile-only): $(git log --oneline -1 $hash)"
  fi
done

# Identify commits touching mobile + shared code (need partial pick)
for hash in $(git log --format=%H --ancestry-path <from>..<to>); do
  files=$(git diff-tree --no-commit-id --name-only -r $hash)
  if echo "$files" | grep -qE '^(ios/|android/)' && \
     echo "$files" | grep -vqE '^(ios/|android/)' | grep -q .; then
    echo "CAUTION (mixed): $(git log --oneline -1 $hash)"
  fi
done
```

#### 3. Create Working Branch & Cherry-Pick

```bash
# Create working branch from open-source main
git checkout -b picking-<version> origin/main

# Cherry-pick each PICK commit (chronological order!)
# Use --no-commit for CAUTION commits to review before committing
git cherry-pick <hash>

# For CAUTION commits (mixed mobile + shared code):
git cherry-pick <hash> --no-commit
# Remove mobile-only file changes
git checkout HEAD -- ios/ android/ capacitor.config.ts 2>/dev/null
# Review remaining changes, then commit
git commit

# For SKIP commits:
# Simply don't cherry-pick them

# If a cherry-pick has conflicts:
# 1. Resolve conflicts in shared code normally
# 2. For files in the skip list, always keep the open-source version:
git checkout HEAD -- <file-from-skip-list>
# 3. Continue:
git cherry-pick --continue
```

#### 4. Post-Pick Adjustments

After all cherry-picks are done:

```bash
# Verify package.json identity is correct (CE, not Pro)
grep '"name"' package.json
# Should be: "xyz.chatboxapp.ce"
# If changed, restore:
# - name: xyz.chatboxapp.ce
# - productName: xyz.chatboxapp.ce

# Verify README hasn't been overwritten
git diff HEAD -- README.md

# Build and test
pnpm install
pnpm run build
pnpm test

# Create release commit
git add -A
git commit -m "release <version>"
```

#### 5. Merge to Main

```bash
git checkout main
git merge picking-<version>
git push origin main
```

### File Skip List

These files/directories must NEVER be synced from pro to open-source:

| Path | Reason |
|------|--------|
| `ios/` | Mobile platform — not in open-source repo |
| `android/` | Mobile platform — not in open-source repo |
| `capacitor.config.ts` | Mobile build config — not in open-source repo |
| `.github/workflows/` | CI/CD pipelines differ between repos |
| `README.md` | CE has its own README with different branding/links |
| `README-CN.md` | CE has its own Chinese README (at `doc/README-CN.md`) |
| `LICENSE` | CE uses GPLv3; Pro uses proprietary license |
| `AGENTS.md` | Pro has its own AGENTS.md; CE maintains its own version independently |
| `CLAUDE.md` | Pro-specific AI assistant config |
| `.claude/` | Pro-specific Claude command configs |
| `.cursorrules` | Pro-specific cursor config |
| `.husky/` | Pro-specific git hooks |
| `.vscode/` | Pro-specific editor config |
| `openspec/` | Pro-specific spec docs |
| `tasks/` | Pro-specific PRD/task docs |
| `Caddyfile`, `Dockerfile` | Pro-specific deployment configs |

### Commit Skip Patterns

Always SKIP these commit types:

| Pattern | Example |
|---------|---------|
| Version bump commits | `chore: bump version to 1.19.0-beta.X (build NNN)` |
| Beta/Alpha release commits | `release 1.19.0-beta.1`, `chore: bump version to 1.19.0-alpha.23` |
| Intermediate release commits | `release 1.18.2`, `release 1.18.3` (only pick the final target release) |
| Merge commits | `Merge branch 'next' of github.com:chatboxai/chatbox-pro into next` |
| Pure mobile commits | `fix: android version name`, `chore: android ci` |
| Pro CI/CD changes | `refactor: consolidate release workflows with Slack notifications` |
| Claude/AI tool configs | `chore: add claude commands`, `feat: add playwright-cli skill` |
| Pro-specific docs | `docs: add AGENTS.md`, `chore: open-spec docs`, `chore: add prd doc` |

### CAUTION Commits (Pick with Partial Revert)

These contain useful shared code but also touch mobile/CI files. Cherry-pick with `--no-commit`, remove mobile parts, then commit:

- Commits touching `package.json` with mobile scripts or `capacitor` deps → keep shared deps, revert mobile-specific changes
- Commits touching both `src/` and `ios/`/`android/` → keep `src/` changes only
- Build tool migration commits (e.g., npm→pnpm, webpack→electron-vite) → review carefully, may need adaptation for CE build setup

### Identity Differences

| Field | Open-Source (CE) | Pro |
|-------|-----------------|-----|
| `package.json` name | `xyz.chatboxapp.ce` | `xyz.chatboxapp.app` |
| `package.json` productName | `xyz.chatboxapp.ce` | `xyz.chatboxapp.app` |
| `electron-builder.yml` appId | `xyz.chatboxapp.app` | `xyz.chatboxapp.app` |
| `productName` in builder | `Chatbox` | `Chatbox` |
| License | GPLv3 | Proprietary |

### Structural Differences

| Aspect | Open-Source (CE) | Pro |
|--------|-----------------|-----|
| Build tool | electron-vite (migrated from webpack in 1.19.0 sync) | electron-vite |
| Package manager | pnpm (migrated from npm in 1.19.0 sync) | pnpm |
| Mobile (iOS/Android) | Not included | Included |
| CI/CD workflows | None in repo | `.github/workflows/` |
| Guide/Onboarding system | Not included (Pro feature) | Full onboarding flow |
| JK Analytics tracking | Not included (Pro feature) | Included |

### Pro-Only Features (Never sync)

These features exist only in Pro and should always be SKIPPED during cherry-pick:

| Feature | Commits pattern | Reason |
|---------|----------------|--------|
| Guide/Onboarding system | `Feat/optimize guide`, `Feat/new user onboarding`, `routes/guide/` | Pro trial/onboarding flow |
| JK Analytics | `Feat/add jk tracking`, `jk-events.ts`, `jk.ts` | Pro-only analytics |
| Free trial entries | `feat: add free trial entry` | Pro trial system |

### Sync History

| Open-Source Release | Pro Release | Sync Method | Sync Date | Notes |
|---------------------|-------------|-------------|-----------|-------|
| 1.11.8 | 1.11.8 | Bulk file copy | ~2024 | `97d32f92` "copy files from pro repo" |
| 1.12.0 → 1.18.1 | 1.12.0 → 1.18.1 | Cherry-pick per commit | ~2025 | Via local `pro-main` branch |
| 1.19.0 | 1.19.0 | Cherry-pick | TBD | 152 commits in range; adopted electron-vite + pnpm; skipped guide/JK |

## Development Notes

### Tech Stack
- Electron + React + TypeScript
- Capacitor for mobile (Pro only)
- Build: electron-vite
- State: Jotai + React Query
- AI: Vercel AI SDK
- UI: MUI + Tailwind CSS

### Key Directories
```
src/
├── main/           # Electron main process
├── renderer/       # React frontend
│   ├── components/ # Shared UI components
│   ├── hooks/      # Custom React hooks
│   ├── i18n/       # Internationalization
│   ├── modals/     # Modal dialogs
│   ├── packages/   # Feature packages (models, tools, etc.)
│   ├── platform/   # Platform-specific code (desktop/web/mobile)
│   ├── routes/     # TanStack Router pages
│   ├── stores/     # Jotai atoms and stores
│   └── utils/      # Shared utilities
└── shared/         # Code shared between main and renderer
```
