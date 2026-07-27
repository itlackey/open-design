# Linux AppImage Build, Runtime, and Release Investigation

## Status

This report records a local investigation performed on Ubuntu 26.04 x86_64.
The runtime failure was reproduced and first fixed against the
`open-design-v0.16.1` source tag. The final code and report were then moved to
and reviewed against upstream `main`. It covers:

- every tracked repository change made during the investigation;
- the local AppImage build and desktop installation;
- the startup failure found in the packaged desktop;
- the desktop and release-smoke fixes and their regression tests;
- repeated runtime verification of the rebuilt AppImage; and
- the gap between the existing Linux packaging implementation and public
  release delivery.

The initial source baseline was tag `open-design-v0.16.1`, commit
`276b4d8e970bc143d7ad060181a89a834e3d9caf`. The final baseline was upstream
`main` commit `340cbb9b94a2bc972c0bc3f74efa2c326c820764`, audited on
2026-07-27. The tag and `main` histories diverged, so relevant files were
compared as trees rather than treating the tag as an ancestor of `main`.

## Executive summary

Open Design can already build, install, launch, inspect, and stop a native
Linux x64 AppImage. The local AppImage built from `v0.16.1` runs successfully on
Ubuntu 26.04 after one desktop lifecycle bug is fixed. The repository also has
conditional Linux publication plumbing: a release job, an end-to-end AppImage
smoke test, release asset naming, checksum generation, R2 publication, and
GitHub Release asset planning.

That does not make the current containerized path release-ready. Issue #5983
tracks a populated-worktree failure in the intended release build, and PR #6009
remained open and review-blocked at the audit cutoff. The stable workflow itself
states that Linux is waiting for the containerized pnpm bootstrap fix. Native
host success and existing publication code are therefore necessary evidence,
not proof that the hosted release lane is ready to turn on unchanged.

The missing public AppImage is therefore not explained by an absence of
packaging code alone. The containerized defect still matters, but Linux is also
an optional release target:

- stable, prerelease, and preview gate the Linux job on
  `vars.ENABLE_STABLE_LINUX == 'true'`;
- beta exposes `enable_linux_x64` but defaults it to `false`;
- the self-hosted beta workflow explicitly rejects Linux;
- publication treats a disabled target as outside the required release set;
- stable promotion validates macOS arm64, macOS x64, and Windows x64
  prerelease artifacts, but not Linux; and
- ordinary pull request CI does not build or launch a real AppImage.

No GitHub Release through `v0.16.1` contains an AppImage. The `v0.16.1` release
contains six uploaded assets: macOS arm64 and x64 DMGs, a Windows x64 NSIS
installer, and one SHA-256 file for each binary. Stable R2 metadata likewise
contains no Linux platform entry.

The desktop code change in this investigation fixes a separate but real
runtime problem. A deferred splash update could call Electron after
the splash window or its `webContents` had been destroyed, producing a fatal
`TypeError: Object has been destroyed` during failed or overlapping startup.
The execution boundary now checks both Electron objects and absorbs the
synchronous teardown race that a Promise rejection handler cannot catch.

Final verification also found that the stable workflow's portable AppImage
smoke path could launch a healthy app yet time out waiting in the wrong runtime
root. The tools-pack launcher now overrides the portable app's namespace base
root for isolated smoke runs. The unchanged repository-owned AppImage E2E then
passed its final install-to-uninstall scenario in 55.3 seconds, with the graceful
stop limitation documented below.

## Scope and inventory

### Intended commit changes

Only these files are intended to differ from the audited `main` baseline:

| File | Change | Reason |
| --- | --- | --- |
| `apps/desktop/src/main/runtime.ts` | Guard splash JavaScript execution when the `BrowserWindow` or `webContents` is destroyed, and handle a synchronous teardown race. | Prevent a late `did-finish-load` replay from becoming a fatal uncaught Electron exception. |
| `apps/desktop/tests/main/splash-stage-replay.test.ts` | Extend the structural mock and add already-destroyed, check-to-call race, and unexpected-error regression cases. | Reproduce the observed lifecycle failure without requiring a live Electron renderer while proving unrelated synchronous failures remain visible. |
| `tools/pack/src/linux.ts` | Force tools-pack AppImage launches to use the tool's isolated packaged namespace base root. | Portable release artifacts intentionally omit a baked local root; without a launch override, the app wrote identity/log state under the user profile while tools-pack waited under `.tmp`. |
| `tools/pack/tests/linux.test.ts` | Assert that the tools-pack namespace root overrides an inherited packaged root. | Pin the portable smoke isolation contract and prevent marker-path drift. |
| `docs/testing/linux-appimage-release-investigation.md` | Add this investigation and handoff report. | Preserve the exact local changes, validation, release findings, limitations, and proposed upstream work. |

No package manifest, lockfile, workflow, release script, product data, or user
project file was changed. Generated build output remained ignored under
`.tmp/`.

### Local changes outside the repository

The tools-pack installer created or replaced these per-user files:

```text
$HOME/.local/bin/Open-Design.default.AppImage
$HOME/.local/share/applications/open-design-default.desktop
$HOME/.local/share/icons/hicolor/512x512/apps/open-design-default.png
```

The installed desktop entry launches:

```text
env -u ELECTRON_RUN_AS_NODE OD_PACKAGED_NAMESPACE=default \
  $HOME/.local/bin/Open-Design.default.AppImage \
  --appimage-extract-and-run %U
```

Runtime state and logs were written to the existing namespace-scoped Open
Design user directories. Screenshots used for validation were written under
`/tmp/opencode/`. None of these local files is part of the proposed repository
diff.

## Why Docker was not treated as an equivalent desktop build

The Docker deployment provides daemon and web access, but it does not exercise
the native Electron host, desktop IPC, protocol registration, local menu
integration, screenshot support, or the complete packaged resource tree.
Because the reported problem was that the desktop app did not open, validating
only Docker would not test the failing surface.

## Local build and installation

### Environment

```text
OS: Ubuntu 26.04 LTS
Architecture: x86_64
Desktop: KDE Plasma on Wayland
Node: v24.18.0
pnpm: 10.33.2 through Corepack
Source baseline: open-design-v0.16.1
```

Dependencies were installed from the committed lockfile:

```bash
corepack pnpm install --frozen-lockfile
```

The verified local artifact was built with:

```bash
corepack pnpm tools-pack linux build \
  --to appimage \
  --portable \
  --app-version 0.16.1 \
  --json
```

The result was:

```text
.tmp/tools-pack/out/linux/namespaces/default/builder/Open Design-default.AppImage
```

Three source checkpoints were built as the work moved from the release tag to
the refreshed final `main`:

| Source checkpoint | AppImage SHA-256 | AppImage bytes | Unpacked bytes |
| --- | --- | ---: | ---: |
| `open-design-v0.16.1` plus splash fix | `67a1c154146867af052fa398a302d5351a2eaf7a072d0890925a41ba35e573ed` | 447,913,515 | 1,587,052,255 |
| Initial `main` review at `b99a9fdc3` | `cc60bcee19f16e4fc89e5384d90edf7f92c04441f758e6856e0e37614e706539` | 447,901,464 | 1,586,643,037 |
| Final `main` at `340cbb9b9` | `67bfdccf8a396c74a2540c5c0c617954a9b855efea9ce3f04e9db36e2a43294b` | 448,081,529 | 1,587,097,182 |

The final AppImage is approximately 427 MiB and expands to approximately 1.48
GiB.

After `corepack pnpm tools-pack linux install --json`, the installed AppImage
had the same final-main checksum. Each checkpoint therefore validated the
artifact produced from its described source state rather than the previously
installed binary.

This was a native local build, not the release workflow's containerized build.
It proves behavior on the test host, but it does not independently prove the
release artifact's older-glibc compatibility. The release lane intends to use
`--containerized` for that purpose, but issue #5983 and PR #6009 must be
resolved before that path is treated as reproducible release evidence.

## Failure diagnosis

### Observed packaged failure

The initial failed launch recorded a fatal desktop exception:

```text
TypeError: Object has been destroyed
    at applySplashStage (.../@open-design/desktop/dist/main/runtime.js:943:17)
    at WebContents.<anonymous> (.../@open-design/desktop/dist/main/runtime.js:964:13)
```

The same launch had a sidecar startup failure. Two desktop starts overlapped;
one exited while a deferred splash `did-finish-load` callback was still
eligible to run. The callback replayed its pending stage by calling
`applySplashStage` directly.

`setSplashStage` already ignored a destroyed `BrowserWindow`, but that guard
did not protect the deferred callback. `applySplashStage` also attached
`.catch()` only after calling `executeJavaScript()`. Electron throws
`TypeError: Object has been destroyed` synchronously when the target is already
gone, so no Promise existed for that rejection handler to catch.

### Root cause

The invariant was implemented at the wrong boundary. Callers could be guarded,
but the final Electron operation itself was not safe during teardown. A
`BrowserWindow` can also outlive its renderer-facing `webContents`, so checking
only the outer window is incomplete.

### Fix

`SplashStageSurface.webContents` now exposes `isDestroyed()`. The shared
`applySplashStage` execution boundary:

1. returns if either the splash window or its `webContents` is destroyed;
2. keeps the existing asynchronous rejection handling; and
3. catches Electron's exact synchronous `Object has been destroyed` error if
   teardown occurs between the lifecycle check and invocation; and
4. rethrows every unrelated synchronous exception.

This is intentionally local to splash stage execution. It does not alter boot
ordering, sidecar timeout policy, splash timing, or renderer behavior.

### Regression coverage

The existing structural splash mock now models `webContents` destruction and
can inject a synchronous execution error. Four tests pin the relevant
boundaries:

- a pending stage is not replayed after the splash window is destroyed; and
- a pending stage is not replayed after `webContents` is destroyed;
- Electron's exact destroyed-object error is ignored when it occurs after both
  lifecycle probes report live objects; and
- an unrelated synchronous execution error is rethrown.

The first test was run against the original implementation before the source
fix and failed because one JavaScript call was recorded. It passed after the
execution-boundary guard was added.

## Runtime verification

### Source-level checks

The following checks passed on the patched tag before the move to `main`:

```text
Focused splash suite: 1 file, 7 tests passed
Desktop suite: 27 files, 250 tests passed
Desktop typecheck: passed
Desktop build: passed
Repository guard: passed
Workspace typecheck: passed
git diff --check: passed
```

The final `main`-based patch expands the focused suite to 9 tests. Its completed
source checks were:

```text
Focused splash suite: 1 file, 9 tests passed
Desktop suite: 27 files, 272 tests passed
Desktop typecheck: passed
Desktop build: passed
Tools-pack Linux suite: 1 file, 61 tests passed
Tools-pack full suite: 36 files, 248 tests passed, 8 platform tests skipped
Tools-pack typecheck: passed
Linux AppImage E2E: 1 AppImage test passed, 1 headless test skipped
Repository guard: passed
Workspace typecheck: passed with zero errors
git diff --check: passed
```

One final-base full desktop run, launched in parallel with other repository
checks, saw an unrelated updater resume assertion miss its expected Range
header. That test passed immediately in isolation, and the full 27-file desktop
suite then passed on a standalone rerun. No updater source was changed.

The first workspace typecheck attempt exceeded a 120-second command timeout
while checking the daemon. Re-running with a six-minute allowance completed
successfully; it produced no type error.

### Installed AppImage acceptance

Each valid cycle used the installed executable with the same environment and
arguments as the desktop entry. A detached user service was used only to keep
the command alive independently of the test terminal. Readiness was checked
through the product's desktop IPC with `tools-pack linux inspect`. The table is
an investigator observation backed by local namespace logs and screenshots;
those transient artifacts are not committed to this repository.

| Cycle | Result | Renderer evidence | Shutdown evidence |
| --- | --- | --- | --- |
| 1 | Passed | PID `3398083`, `state: running`, visible window, `od://app/`, `document.readyState: complete`, screenshot captured | IPC shutdown accepted; process inactive; socket removed; `reachedRunning: true`; `clean: true` |
| 2 | Passed | PID `3401755`, same running/visible/complete checks and screenshot | IPC shutdown accepted; process inactive; socket removed; `reachedRunning: true`; `clean: true` |
| 3 | Passed | PID `3407381`, same running/visible/complete checks and screenshot | IPC shutdown accepted; process inactive; socket removed; `reachedRunning: true`; `clean: true` |

While cycle 2 was running, a second invocation of the exact installed command
was started. It exited after the launcher recorded:

```text
inspect-found-existing namespace=default focus=accepted
```

The original PID remained running, visible, and inspectable. This validates a
repeated launcher invocation and the existing-instance focus path. It does not
prove desktop-menu discovery or a human click through KDE.

No new log entry during the valid cycles contained:

```text
Object has been destroyed
fatal desktop exception
packaged runtime failed
Failed to clean up cache directory
```

One earlier `gtk-launch` diagnostic reached the running state but retained the
test terminal. The terminal tool killed it at its timeout, producing an unclean
session and subsequent Chromium process errors. That run is deliberately
excluded from acceptance evidence; it was a harness shutdown, not an
application failure.

### Final main-based installed acceptance

The AppImage rebuilt from audited `main` was installed over the tag artifact
and run through the same desktop-entry command. It reached PID `3483833` with a
visible window, `state: running`, `od://app/`, and
`document.readyState: complete`; renderer evaluation and screenshot capture
both succeeded.

A concurrent second invocation exited after
`inspect-found-existing namespace=default focus=accepted`, while PID `3483833`
remained healthy. IPC shutdown was accepted, the service became inactive, the
desktop socket was removed, and session state recorded `reachedRunning: true`
and `clean: true`. No new destroyed-object, fatal desktop, packaged runtime, or
extraction cleanup error appeared.

After upstream advanced to final baseline `340cbb9b9`, the AppImage was rebuilt
again and reinstalled with the final checksum above. The exact desktop-entry
command reached PID `3597242`, a visible complete renderer at `od://app/`, and a
successful screenshot/eval. Explicit IPC shutdown was accepted; the service
and socket disappeared; session state recorded `reachedRunning: true` and
`clean: true`; and no relevant fatal or cleanup error was logged.

### Portable release-smoke failure and fix

The repository-owned AppImage E2E was then run unchanged with:

```bash
OD_PACKAGED_E2E_LINUX_APPIMAGE=1 \
OD_PACKAGED_E2E_NAMESPACE=default \
corepack pnpm --dir e2e test specs/linux.spec.ts
```

Its first run failed because `tools-pack linux start` did not observe
`desktop-root.json` within 60 seconds. Increasing that deadline experimentally
to 120 seconds produced the same result and was reverted.

Process inspection showed that the AppImage, daemon, web sidecar, visible
desktop, and desktop IPC were already healthy. The identity marker and logs
were under the normal per-user packaged namespace, while tools-pack was polling
its isolated `.tmp/tools-pack/runtime/...` namespace.

This mismatch is specific to portable artifacts:

- `--portable` correctly omits a machine-local `namespaceBaseRoot` from the
  packaged config;
- the packaged app therefore defaults to its Electron user-data root;
- tools-pack set sidecar stamp/runtime variables but did not set the packaged
  namespace-base override; and
- stable CI builds `--portable` before invoking this same E2E path.

`createLinuxDesktopLaunchEnv` now sets
`OD_PACKAGED_NAMESPACE_BASE_ROOT` to
`config.roots.runtime.namespaceBaseRoot`. This is a launch-only override: it
keeps the distributable artifact portable and does not change normal menu
launches, which continue using per-user packaged storage.

The existing tools-pack Linux test was first changed to supply an incorrect
inherited root and expect the isolated tools-pack root. It failed with
`Received: "/wrong-root"`, then all 61 tests passed after the environment fix.
The unchanged AppImage E2E subsequently passed install, start, identity,
daemon health evaluation, screenshot, log-path validation, shutdown request,
process termination, and uninstall in 50.63 seconds. It did not prove graceful
teardown: the retained E2E session marker recorded `clean: false` because the
current tools-pack stop path signals the process tree immediately after making
its best-effort IPC request.

The complete E2E was rerun after the final `main` refresh and final AppImage
rebuild. It passed the same unchanged scenario in 55.32 seconds.

### AppImage extraction behavior

Direct FUSE execution of the tag artifact failed to report the daemon sidecar
before its startup budget expired. Current `main` changes that outcome: it
prewarms FUSE-backed packaged resources and gives Linux a 90-second sidecar
status budget.

The initial-main AppImage from `b99a9fdc3` was launched directly through FUSE
under an isolated namespace. The mount and inner Electron entry took about 36 seconds.
Prewarming then reported 2,507 files and 203,028,468 bytes in 29,093 ms, followed
by 1,061 files and 31,076,574 bytes in 1,635 ms. The app reached desktop IPC and
a visible, complete renderer after approximately 110 seconds total, accepted
graceful IPC shutdown, and recorded a clean session with no fatal, timeout, or
destroyed-object log.

The subsequent `340cbb9b9` refresh did not change AppImage mount, prewarm, or
sidecar code. Direct FUSE was therefore not repeated for the superseding
artifact; its normal desktop-entry launch and formal AppImage E2E were repeated.

`tools-pack linux start` and the installed desktop entry still force
`--appimage-extract-and-run`, so the repository-owned smoke does not exercise
this successful but slow FUSE path. Extract-and-run can also spend tens of
seconds unpacking the approximately 1.48 GiB tree before desktop IPC appears.
The tools-pack launcher allows 60 seconds for its identity marker, while
packaged Linux sidecar readiness on current `main` allows 90 seconds. A short
probe can therefore report no socket while the process is healthy and still
extracting or prewarming.

## Existing Linux implementation

The repository already implements these layers:

### Build and packaging

- `tools/pack/src/linux.ts` assembles packaged resources and invokes
  electron-builder for AppImage output.
- `tools-pack linux build --to appimage --portable --containerized` is the
  intended hosted-release command, but the open containerized-build defect
  means it is not yet cleared as release-grade.
- The containerized path uses the mutable, unpinned
  `electronuserland/builder:base` image with the intent of targeting an older
  glibc baseline. A pinned image digest and oldest-supported-distribution test
  are needed for reproducible compatibility evidence.
- A custom `AppRun` clears `ELECTRON_RUN_AS_NODE` and forwards arguments to the
  packaged executable. Sandbox fallback is not implemented there;
  tools-pack configures the AppImage's embedded desktop metadata with
  `--no-sandbox`, while direct launches and the separate tools-pack-installed
  desktop entry do not inject that argument.
- Stable publication marks Linux artifacts unsigned. Enabling the lane needs
  an explicit sandbox and signing policy, even if the decision remains an
  unsigned AppImage plus SHA-256.

### Desktop integration and lifecycle

- `tools-pack linux install` installs the AppImage, desktop entry, and icon.
- `start`, `inspect`, `logs`, `stop`, `uninstall`, and `cleanup` implement the
  local lifecycle.
- Namespace-scoped paths allow multiple local packaged instances.
- The desktop entry registers the `od://` scheme and selects the packaged
  namespace.

### Smoke coverage

- `e2e/specs/linux.spec.ts` covers install, start, process identity, desktop
  status, daemon health, screenshot capture, log checks, stop, and uninstall.
- The full AppImage suite is opt-in through
  `OD_PACKAGED_E2E_LINUX_APPIMAGE=1`.
- Stable release CI runs this suite under Xvfb when the Linux job is enabled.
- This branch fixes the portable namespace-root mismatch that prevented the
  release-built artifact from satisfying that smoke harness.

### Publication

- `tools/release/scripts/prepare-platform-assets.sh` creates the canonical
  `open-design-<version>-linux-x64.AppImage` name and SHA-256 file.
- `tools-release publish-platform` supports `linux_x64` and R2 publication.
- Stable GitHub asset planning includes the AppImage and checksum when the
  Linux release bundle exists.
- Release metadata has a Linux platform definition and download URL field.

## Why public releases still omit the AppImage

### Stable

`.github/workflows/release-stable.yml` retains a complete Linux job but marks
the lane temporarily excluded. The job runs only when:

```yaml
vars.ENABLE_STABLE_LINUX == 'true'
```

The publish job accepts `build_linux` as either `success` or `skipped`, so a
stable release can complete without Linux.

### Prerelease and preview

Both workflows use the same repository-variable gate. Their publish jobs also
accept a skipped Linux build. Neither lane runs the stable workflow's complete
Xvfb lifecycle smoke before publishing Linux.

### Beta

The hosted beta workflow has a boolean `enable_linux_x64` input whose default
is `false`. The scheduled daily caller enables macOS arm64 and Windows x64 but
does not opt into Linux. The self-hosted beta workflow currently rejects an
enabled Linux target because it has no Linux runner lane.

### Release completeness

`tools/release/src/storage/publish-metadata.ts` knows about `linux_x64`, but the
expected target set is derived from enabled targets. When Linux is disabled,
its absence does not make publication incomplete.

Stable's prerelease validation in
`tools/release/src/metadata/prepare-stable.ts` requires signed macOS arm64 and
x64 artifacts and the Windows x64 installer. It does not require a Linux
platform or AppImage. It validates metadata fields and version-scoped HTTPS
URLs; it does not download artifact bytes or recompute their checksums. Stable
then rebuilds platform artifacts, so adding Linux URL validation alone would
not prove that the final stable AppImage is the same artifact tested in
prerelease.

### Portable release-smoke isolation

Audited upstream `main` builds stable Linux with `--portable` and then uses
tools-pack for lifecycle smoke. Before the local fix, the artifact wrote its
marker and logs to the user-profile namespace while the harness polled its
workspace namespace. Because the entire Linux job is normally skipped, this
failure could remain hidden until the lane was enabled. The local launch-root
override closes this prerequisite but does not resolve the separate
containerized build defect or optional release policy.

### Public evidence

As of the `v0.16.1` audit:

- 21 GitHub Release objects were present;
- no uploaded asset name contained `linux` or `AppImage`;
- `v0.16.1` published on 2026-07-23 without Linux;
- stable R2 metadata marked the release complete without `linux_x64`; and
- stable Actions run `30021668470` skipped `Build release linux x64`.

The landing-page download row is correctly conditional on a Linux URL, but
other public copy still describes AppImage availability even when no asset
exists. The mismatch includes localized information-page text, pricing copy,
and long-form tutorials. Release acceptance must cover those surfaces as well
as GitHub release notes.

Relevant upstream records include:

- issue #4368, `NO Linux app image`;
- issue #5531, `Linux version advertised but no download available`;
- issue #3759, the broader Linux desktop request;
- issue #5983, containerized Linux build failures;
- PR #6009, open and review-blocked containerized Linux packaging fixes;
- draft PR #6010, conflicting `.deb` build work; and
- draft PR #6017, conflicting Linux release publication work stacked with
  `.deb` support. Its current form preserves optional Linux gates.

The release-delivery work should coordinate with these records rather than
open a competing implementation without checking their current status.

## Review against upstream main

The draft report and splash patch were first reviewed after fetching upstream
`main` at `b99a9fdc3d69001ec0c2296e4b606f8b34bea663`. A final refresh advanced
`main` to `340cbb9b94a2bc972c0bc3f74efa2c326c820764` through PR #5899. That commit
changed web, daemon, design content, and related tests; it did not change any
desktop splash, tools-pack Linux, AppImage smoke, release workflow, or release
metadata file relevant to this report. The patch again applied without
conflict. Local `main`, `upstream/main`, and the `itlackey/open-design` fork's
`origin/main` were then synchronized to the final SHA.

The splash execution boundary and test surface on `main` were materially the
same as the tag. No upstream guard handled a destroyed `webContents` or the
synchronous `executeJavaScript()` throw. The patch applied without conflict and
remains necessary.

Upstream `main` also lacked a portable Linux launch-root override in
`createLinuxDesktopLaunchEnv`. The release smoke therefore could not observe
the identity and logs of the portable AppImage it launched. That second fix
also remains applicable to the audited baseline.

The Linux release posture also remains optional on `main`:

- stable Linux is gated by `ENABLE_STABLE_LINUX` and may be skipped;
- prerelease and preview use the same gate and do not run the full Xvfb smoke;
- beta defaults Linux off, and self-hosted beta rejects it;
- release completeness requires Linux only when Linux is enabled;
- stable prerelease validation requires only macOS arm64/x64 and Windows x64;
- all 21 GitHub Releases still contain zero AppImage assets; and
- stable `v0.16.1` metadata still omits `linux_x64` while reporting a complete
  release.

Relevant `main` improvements since the tag do not close that release gap:

- Linux FUSE prewarming and a 90-second status budget improve direct AppImage
  cold-start behavior;
- updater cache recovery and launcher-version-floor metadata were added; and
- documentation now states that real packaged Linux smoke is outside ordinary
  pull request CI.

The AppImage builder, stable Linux smoke, Linux release asset preparation, and
conditional platform publication are otherwise unchanged in the compared
trees. Linux in-app updating also remains unsupported: Linux release manifests
publish no updater feed, and desktop artifact selection supports macOS and
Windows only.

No recommendation below was made obsolete by `main`. One recommendation was
refined: existing R2/GitHub consistency should be preserved rather than
reimplemented. The missing invariant is that Linux must be required and its
final bytes must be tested, not merely that conditional metadata agrees when
the target is omitted.

## Recommended upstream change shape

The runtime lifecycle fix and release policy should be reviewed separately.
They solve different problems and have different validation requirements.

### PR 1: splash teardown safety

Include only:

- the `applySplashStage` lifecycle guard;
- the four focused teardown and error-boundary regression cases; and
- the red/green test evidence.

This is a small desktop bug fix and can land independently of Linux release
policy.

### PR 2: repair portable Linux smoke isolation

Include only:

- the `OD_PACKAGED_NAMESPACE_BASE_ROOT` tools-pack launch override;
- the focused Linux environment regression assertion; and
- the unchanged AppImage E2E red/green evidence.

This should land before enabling Linux release jobs. It fixes the harness's
observation root without changing portable artifact defaults or user launches.

### PR 3: make Linux a required release target

Coordinate with PRs #6009, #6010, and #6017. For the AppImage requirement, the
minimum coherent change should:

1. remove the hidden stable opt-in, or replace it with an explicit workflow
   input whose normal release caller always enables Linux;
2. require `build_linux.result == 'success'` for a publishable stable release;
3. require `linux_x64` in release completeness and stable prerelease metadata
   validation;
4. run the full Xvfb AppImage lifecycle smoke in prerelease for early signal,
   then either promote the exact tested bytes or rerun the same smoke against
   the final stable rebuild and record its digest;
5. attach both the AppImage and its SHA-256 file to every GitHub stable
   release;
6. preserve the existing R2 and GitHub asset consistency while making Linux
   mandatory rather than conditionally absent;
7. add a topology test that fails when Linux can silently become skipped; and
8. document any intentionally unsupported architecture instead of implying a
   generic Linux binary.

If "every release" includes preview and beta rather than only public stable
GitHub Releases, each channel needs an explicit product decision. At minimum,
stable and its required prerelease gate should be non-optional. Beta can remain
an R&D channel, but a regular Linux beta provides earlier detection than the
stable release day.

## Proposed release acceptance criteria

A release should not be considered Linux-complete unless all of the following
are true:

- a containerized x64 AppImage build completes on a clean hosted runner;
- the artifact name includes the release version and `linux-x64`;
- a SHA-256 sidecar is generated and verified;
- install, launch, desktop IPC status, daemon health, renderer evaluation,
  screenshot, graceful stop, and uninstall pass under Xvfb;
- the platform manifest and version metadata contain `linux_x64` URLs beneath
  the same immutable version prefix;
- stable prerelease validation requires Linux metadata, downloads the AppImage
  and checksum, and recomputes the digest;
- either the exact prerelease bytes are promoted or the final stable rebuild is
  independently smoked and identified by digest;
- the GitHub Release contains the AppImage and checksum;
- release notes, download pages, localized marketing/SEO copy, pricing, and
  tutorials do not claim Linux availability when the assets are absent;
  and
- a post-publication check downloads the GitHub asset and verifies its hash.

## Known limitations and follow-up questions

- The local artifact was built natively on Ubuntu 26.04, not in the release
  container. Runtime verification is strong host evidence, not a distribution
  compatibility matrix.
- The container image is not pinned by digest, and the containerized
  populated-worktree build remains unresolved upstream.
- Only x86_64 was tested. No arm64 Linux artifact is currently represented by
  the audited release target.
- Linux in-app update is currently unsupported. Publishing an AppImage gives
  users a manual upgrade path but does not add AppImage update integration.
- Extract-and-run startup is functional but can be slow and verbose. Improving
  extraction caching is separate from guaranteeing release availability.
- The current AppImage E2E confirms shutdown request and process termination,
  not graceful teardown; its retained session state was `clean: false`.
  Manual IPC shutdowns were clean, so the remaining gap is in tools-pack stop
  waiting and the E2E assertion.
- A portable app launched later from the installed desktop entry correctly
  uses the user-profile namespace. `tools-pack linux stop` and `uninstall`
  currently inspect only the tools-pack runtime marker, so they can misclassify
  that menu-launched process as not running. Safe dual-root discovery and a
  desktop-entry launch regression belong in a follow-up.
- The value of the private `ENABLE_STABLE_LINUX` repository variable could not
  be read. The skipped `v0.16.1` job and absent public artifacts are sufficient
  to establish the release outcome.
- Local runtime logs and screenshots were inspected but are not committed as
  durable verification artifacts.

## Reproduction commands

```bash
corepack pnpm install --frozen-lockfile

corepack pnpm --filter @open-design/desktop exec vitest run \
  -c vitest.config.ts tests/main/splash-stage-replay.test.ts
corepack pnpm --filter @open-design/desktop test
corepack pnpm --filter @open-design/desktop typecheck
corepack pnpm --filter @open-design/desktop build
corepack pnpm --filter @open-design/tools-pack exec vitest run tests/linux.test.ts
corepack pnpm --filter @open-design/tools-pack test
corepack pnpm --filter @open-design/tools-pack build
corepack pnpm guard
corepack pnpm typecheck
git diff --check

corepack pnpm tools-pack linux build \
  --to appimage \
  --portable \
  --app-version 0.16.1 \
  --json
corepack pnpm tools-pack linux install --json
corepack pnpm tools-pack linux start --json
corepack pnpm tools-pack linux inspect --json \
  --expr "JSON.stringify({title: document.title, href: location.href, readyState: document.readyState})"
corepack pnpm tools-pack linux stop --json
corepack pnpm tools-pack linux uninstall --json

OD_PACKAGED_E2E_LINUX_APPIMAGE=1 \
OD_PACKAGED_E2E_NAMESPACE=default \
corepack pnpm --dir e2e test specs/linux.spec.ts
```

For the intended hosted-release path, first resolve and merge the
containerized-build fix, pin its image provenance, then add `--containerized`
and run the repository-owned Linux AppImage E2E suite under Xvfb as the stable
workflow does.
