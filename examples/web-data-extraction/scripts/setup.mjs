#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(__dirname, "..");

const browserToolsDir = join(projectDir, ".pi", "skills", "browser-tools");
const browserToolsEntry = join(browserToolsDir, "browser-content.js");
const tempCloneDir = join(projectDir, ".pi", "tmp", "pi-skills");

function run(command, args, cwd = projectDir) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureBrowserToolsFiles() {
  if (await exists(browserToolsEntry)) {
    console.log(`\n==> Reusing browser-tools at\n    ${browserToolsDir}`);
    return;
  }

  console.log("\n==> Downloading browser-tools skill sources into this example's .pi folder");

  await rm(tempCloneDir, { recursive: true, force: true });
  await mkdir(join(projectDir, ".pi", "tmp"), { recursive: true });

  run("git", ["clone", "--depth", "1", "https://github.com/badlogic/pi-skills", tempCloneDir]);

  await mkdir(join(projectDir, ".pi", "skills"), { recursive: true });
  await rm(browserToolsDir, { recursive: true, force: true });
  await cp(join(tempCloneDir, "browser-tools"), browserToolsDir, { recursive: true });

  await rm(tempCloneDir, { recursive: true, force: true });
}

async function main() {
  console.log("\n==> Validating project-local pi setup (.pi/settings.json)");
  run("pi", ["list"]);

  console.log("\n==> Ensuring project-local pi-rlm package (npm:pi-rlm)");
  run("pi", ["install", "npm:pi-rlm", "-l"]);

  await ensureBrowserToolsFiles();

  console.log(`\n==> Installing browser-tools npm dependencies\n    ${browserToolsDir}`);
  run("npm", ["install"], browserToolsDir);

  console.log("\n✅ Setup complete.");
  console.log("Next steps:");
  console.log("  1) ./scripts/browser-start.sh");
  console.log("  2) Start pi in this directory and use the web-data-extraction skill\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
