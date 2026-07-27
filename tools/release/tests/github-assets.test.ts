import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const testDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(testDir, "..", "..", "..");
const tsxCliPath = require.resolve("tsx/cli");

async function writeAsset(root: string, group: string, name: string): Promise<void> {
  const dir = join(root, group);
  await mkdir(dir, { recursive: true });
  if (name.endsWith(".sha256")) {
    const assetName = name.slice(0, -".sha256".length);
    const digest = createHash("sha256").update(await readFile(join(dir, assetName))).digest("hex");
    await writeFile(join(dir, name), `${digest}  ${assetName}\n`, "utf8");
    return;
  }
  await writeFile(join(dir, name), `${name}\n`, "utf8");
}

function stableAssetNames(version: string): string[] {
  return [
    `open-design-${version}-mac-arm64.dmg`,
    `open-design-${version}-mac-arm64.dmg.sha256`,
    `open-design-${version}-mac-x64.dmg`,
    `open-design-${version}-mac-x64.dmg.sha256`,
    `open-design-${version}-win-x64-setup.exe`,
    `open-design-${version}-win-x64-setup.exe.sha256`,
    `open-design-${version}-linux-x64.AppImage`,
    `open-design-${version}-linux-x64.AppImage.sha256`,
  ];
}

async function writeStableAssets(root: string, names: string[]): Promise<void> {
  for (const name of names) {
    let group = "mac";
    if (name.includes("linux")) group = "linux";
    else if (name.includes("win")) group = "win";
    else if (name.includes("x64")) group = "mac-intel";
    await writeAsset(root, group, name);
  }
}

function prepareGithubAssets(source: string, output: string, version: string, outputsPath?: string) {
  return execFileAsync(process.execPath, [tsxCliPath, "tools/release/src/index.ts", "prepare-github-assets"], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      RELEASE_CHANNEL: "stable",
      RELEASE_GITHUB_ASSETS_DIR: output,
      RELEASE_GITHUB_ASSETS_SOURCE_DIR: source,
      ...(outputsPath == null ? {} : { RELEASE_OUTPUTS_PATH: outputsPath }),
      RELEASE_VERSION: version,
    },
  });
}

describe("stable GitHub Release asset plan", () => {
  it("selects only installers/packages and sha files from the full release bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-release-github-assets-"));
    const source = join(root, "source");
    const output = join(root, "github-assets");
    const outputsPath = join(root, "outputs.json");
    const version = "0.10.2";

    try {
      const allowed = stableAssetNames(version);
      await writeStableAssets(source, allowed);
      for (const name of [
        `open-design-${version}-mac-arm64-payload.zip`,
        `open-design-${version}-mac-x64.zip`,
        `open-design-${version}-win-x64-payload.7z`,
        `open-design-${version}-win-x64-portable.zip`,
        "latest.yml",
        "latest-mac.yml",
      ]) {
        await writeAsset(source, "extra", name);
      }

      await prepareGithubAssets(source, output, version, outputsPath);

      const outputs = JSON.parse(await readFile(outputsPath, "utf8")) as {
        assetCount: number;
        assets: string[];
      };
      expect(outputs.assetCount).toBe(8);
      expect(outputs.assets).toEqual(allowed);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails when the Linux AppImage checksum is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-release-github-assets-missing-linux-"));
    const source = join(root, "source");
    const output = join(root, "github-assets");
    const version = "0.10.2";

    try {
      await writeStableAssets(
        source,
        stableAssetNames(version).filter((name) => name !== `open-design-${version}-linux-x64.AppImage.sha256`),
      );

      await expect(prepareGithubAssets(source, output, version)).rejects.toMatchObject({
        stderr: expect.stringContaining(`missing GitHub release asset: open-design-${version}-linux-x64.AppImage.sha256`),
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails when the Linux AppImage checksum does not match", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-release-github-assets-bad-linux-"));
    const source = join(root, "source");
    const output = join(root, "github-assets");
    const version = "0.10.2";

    try {
      await writeStableAssets(source, stableAssetNames(version));
      await writeFile(
        join(source, "linux", `open-design-${version}-linux-x64.AppImage.sha256`),
        `${"0".repeat(64)}  open-design-${version}-linux-x64.AppImage\n`,
        "utf8",
      );

      await expect(prepareGithubAssets(source, output, version)).rejects.toMatchObject({
        stderr: expect.stringContaining(`GitHub release asset checksum mismatch: open-design-${version}-linux-x64.AppImage`),
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
