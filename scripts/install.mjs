import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const options = { cwd: root, stdio: "inherit" };

async function install() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error("Ycode requires Node.js 22.19 or newer. Use Node.js 24 LTS.");
  }
  console.log("Installing locked dependencies in the Ycode checkout...");
  execSync("npm ci --ignore-scripts --include=dev --include=optional", options);
  execSync("npm rebuild --ignore-scripts=false better-sqlite3 @ast-grep/cli", options);

  console.log("Checking SQLite, ripgrep, and ast-grep...");
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(":memory:");
  try {
    db.prepare("SELECT 1").get();
  } finally {
    db.close();
  }
  const { repositoryExecutable } = await import("../src/repository/commands.ts");
  for (const name of ["rg", "ast-grep"]) {
    execFileSync(await repositoryExecutable(name), ["--version"], options);
  }
  const host = resolve(root, "node_modules/@earendil-works/pi-coding-agent");
  const { bin } = JSON.parse(readFileSync(resolve(host, "package.json"), "utf8"));
  execFileSync(process.execPath, [resolve(host, bin.pi), "install", root, "--no-approve"], options);
  console.log(`Ycode installed. Keep this folder: ${root}. Restart Pi or run /reload.`);
}

install().catch((error) => {
  console.error(`Ycode installation failed: ${error.message}`);
  process.exitCode = 1;
});
