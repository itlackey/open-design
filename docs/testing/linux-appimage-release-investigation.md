# Linux AppImage Release Investigation

## Decision

Future automated stable releases must build, smoke, and publish a Linux x64
AppImage and its SHA-256 sidecar. If the Linux lane fails or either file is
missing, `release-stable` must not publish the GitHub Release.

This investigation was completed on Ubuntu 26.04 x86_64 against final upstream
`main` commit `fac10139c0138a5700c128079e23c3e7a622516c` on 2026-07-27. Its final
upstream update changed only CI scope policy, not AppImage or release files. The
branch fixes four independent failures:

| Failure | Root cause | Fix |
| --- | --- | --- |
| Packaged desktop could exit with `Object has been destroyed`. | A deferred splash update could synchronously call destroyed Electron objects. | Guard both `BrowserWindow` and `webContents` at the execution boundary; suppress only Electron's exact teardown error. |
| Portable AppImage smoke timed out while the app was healthy. | The app wrote its marker under the user profile while tools-pack polled its isolated runtime root. | Set `OD_PACKAGED_NAMESPACE_BASE_ROOT` for tools-pack launches. |
| The release-shaped container build failed before producing an AppImage. | The builder image lacked a usable noninteractive Node/npm/pnpm execution path. | Expose managed Node and npm, route nested workspace commands to standalone pnpm, and retain npm for production tarball installation. |
| Stable GitHub Releases omitted Linux. | Linux was hidden behind `ENABLE_STABLE_LINUX`; publication accepted a skipped job; asset planning and metadata inherited that optional result. | Always run stable Linux prepublish work and require success, which activates the existing Linux publication path. |

The change intentionally applies only to the stable release path. Beta,
preview, and prerelease Linux policy remains unchanged.

## Public Release Audit

At the audit cutoff:

- all 21 public GitHub Releases lacked Linux or AppImage assets;
- `open-design-v0.16.1` contained six assets: macOS arm64/x64 DMGs, a Windows
  x64 installer, and one checksum for each binary;
- stable `v0.16.1` metadata omitted `linux_x64` while reporting a complete
  release; and
- stable Actions run `30021668470` skipped `Build release linux x64`.

The repository already contained AppImage assembly, canonical naming,
checksum generation, R2 publication, metadata support, and an Xvfb lifecycle
smoke. The missing assets resulted from broken container execution plus
fail-open stable policy, not from absent packaging code.

Relevant upstream work was reviewed before changing the lane:

- issue #5983 records the populated-worktree container failure;
- PR #6009 proposes the same container execution-path repair but had no
  completed workspace CI at the audit cutoff;
- draft PRs #6010 and #6017 add broader Linux packaging/release work and retain
  optional Linux gates in their audited form.

## Runtime Fixes

### Splash teardown

`applySplashStage` is the final Electron call boundary. It now:

1. returns when the splash window or its `webContents` is destroyed;
2. preserves asynchronous rejection handling;
3. catches the exact synchronous `Object has been destroyed` race; and
4. rethrows unrelated synchronous failures.

Nine focused tests cover replay, destroyed window/web contents, the
check-to-call race, and unrelated errors. Boot order, splash timing, and
sidecar policy are unchanged.

### Portable smoke identity

Portable artifacts correctly omit machine-local runtime roots. During a
tools-pack smoke, however, the harness and app must share the same temporary
root. `createLinuxDesktopLaunchEnv` now supplies the tools-pack namespace base
root as a launch-only override. Installed menu launches continue to use normal
per-user packaged storage.

The environment regression was red with an inherited incorrect root and green
after the override. The unchanged Linux AppImage E2E then completed install,
start, identity checks, daemon health evaluation, screenshot, log checks,
stop, and uninstall.

## Container Build Repair

The release command bind-mounts a populated workspace into
`electronuserland/builder:base`. The previous path failed in stages:

1. pnpm refused to recreate `node_modules` without a TTY;
2. nested workspace commands fell back to absent `corepack`;
3. pnpm production installation could not resolve complete internal tarball
   dependency trees;
4. electron-builder's collector could not find bare `pnpm`; and
5. the resulting package could omit transitive dependencies such as
   `setimmediate`.

`buildDockerArgs` now establishes one coherent environment:

- `CI=true` permits noninteractive workspace installation;
- managed Node's `bin` directory exposes npm;
- `npm_execpath=/tmp/pnpm` routes `runPnpm` through the verified standalone
  pnpm binary;
- a `PNPM_HOME/pnpm` symlink supports electron-builder's direct collector
  invocation; and
- the assembled app keeps the existing npm production install, which resolves
  complete `file:` tarball dependency trees.

No package manifest, lockfile, or container image was added.

The populated-worktree release-shaped command completed successfully:

```bash
pnpm exec tools-pack linux build \
  --dir /tmp/opencode/open-design-container-release \
  --namespace release-container-smoke \
  --portable \
  --app-version 0.16.1 \
  --to appimage \
  --containerized \
  --json
```

Produced artifact:

```text
size:   447,765,621 bytes
sha256: 40fac91e33866d6bb2655ef764b48eb67617e48901ea8f26b01ec3ab8910b9d7
```

The repository-owned AppImage E2E passed against this exact container-built
artifact in 47.53 seconds: one AppImage test passed and the unrelated headless
case was skipped by its platform flag.

## Stable Release Invariant

The stable path is now fail-closed:

1. `build_linux` runs whenever stable prepublish jobs run; no repository
   variable can skip it.
2. The job builds a portable, containerized AppImage and runs the Linux E2E
   lifecycle smoke.
3. `prepare-platform-assets.sh` creates:
   - `open-design-<version>-linux-x64.AppImage`
   - `open-design-<version>-linux-x64.AppImage.sha256`
4. The final publish job requires `build_linux.result == 'success'`.
5. The required successful result enables the existing Linux asset plan, which
   requires all eight public assets and rejects missing, duplicate, empty, or
   unexpected planned output.
6. The same successful result enables `linux_x64` in stable metadata.
7. GitHub publication remains draft-first: asset upload and metadata
   verification must succeed before `gh release edit --draft=false --latest`.
8. Failure after draft creation attempts to delete the draft and tag.

Topology coverage pins the unconditional stable Linux job and rejects a skipped
Linux result. Asset-plan coverage proves the existing Linux-enabled path selects
all eight public files.

## Changed Surfaces

| Surface | Purpose |
| --- | --- |
| `apps/desktop/src/main/runtime.ts` and splash tests | Teardown-safe splash execution. |
| `tools/pack/src/linux.ts` and Linux tests | Portable smoke identity and container build repair. |
| `.github/workflows/release-stable.yml` | Mandatory Linux build, smoke, metadata, and publication gate. |
| `tools/release/tests/github-assets.test.ts` | Exercise the existing Linux-enabled eight-asset plan. |
| `e2e/tests/packaged-smoke-workflow.test.ts` | Pin the stable Linux job and publication gate. |
| Stable release notes and release policy docs | Describe Linux as a required stable asset. |

## Verification

Completed checks:

```text
Desktop focused splash:       9 passed
Desktop full suite:           272 passed
Desktop typecheck/build:      passed
Tools-pack focused Linux:     56 passed
Tools-pack full suite:        243 passed, 8 platform skips
Tools-pack typecheck/build:   passed
Tools-release full suite:     26 passed
Stable GitHub asset plan:     1 passed
Release topology suite:       52 passed
Containerized AppImage build: passed from a populated worktree
Container artifact E2E:       1 passed, 1 headless skip
Workflow actionlint:          passed
Repository guard/typecheck:   passed
```

The earlier native AppImage and the final container-built AppImage both
reached a visible complete renderer, accepted inspection and screenshots, and
contained no new splash, packaged-runtime, or missing-module fatal errors.

## Remaining Limits

- This guarantees future releases created by `release-stable.yml`; it does not
  backfill historical assets or govern manually created GitHub Releases.
- A GitHub-hosted `release-stable` prepublish run has not yet exercised the
  workflow's Xvfb setup and cross-job artifact handoffs. The same container
  build and lifecycle spec passed locally, while actionlint and topology tests
  validate the workflow statically.
- Linux output is x86_64 only and remains unsigned with a SHA-256 sidecar.
- Linux in-app updating is unsupported; users receive a manual AppImage
  upgrade path.
- `electronuserland/builder:base` remains a mutable tag. Pinning a reviewed
  digest and testing the oldest supported distribution are separate hardening
  work.
- The final stable AppImage is independently rebuilt and smoked. Prerelease
  Linux remains optional and is not a byte-for-byte promotion source.
- Platform preparation generates SHA-256 sidecars. The GitHub asset planner
  requires the sidecars and nonempty files but does not recompute their digests
  or download the final public assets after publication.
- The current E2E stop path requests IPC shutdown and then signals the process
  tree immediately; retained E2E session state can report `clean: false` even
  though explicit manual IPC shutdowns are clean.
- A portable app later launched from its installed desktop entry uses the
  correct user-profile root, but tools-pack stop/uninstall ownership remains
  scoped to the tools-pack launch marker.
- Direct FUSE launch works on current main but is slow. The installed desktop
  entry and release smoke continue to use `--appimage-extract-and-run`.
