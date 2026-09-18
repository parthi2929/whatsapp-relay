import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const serviceDir = path.dirname(fileURLToPath(import.meta.url));
const codexHome = (await fs.readFile(path.join(serviceDir, "codex-home.txt"), "utf8")).trim();
const cacheRoot = path.join(codexHome, "plugins", "cache", "personal", "whatsapp-relay");
const logDir = path.join(serviceDir, "logs");
const logFile = path.join(logDir, "autostart.log");

process.env.CODEX_HOME = codexHome;

async function appendLog(event) {
  await fs.mkdir(logDir, { recursive: true });
  await fs.appendFile(
    logFile,
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    "utf8"
  );
}

async function findCurrentPluginRoot() {
  const entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = path.join(cacheRoot, entry.name);
    const watchdog = path.join(root, "scripts", "controller-watchdog.mjs");
    const daemon = path.join(root, "scripts", "controller-daemon.mjs");
    try {
      const stat = await fs.stat(watchdog);
      await fs.access(daemon);
      candidates.push({ root, watchdog, mtimeMs: stat.mtimeMs });
    } catch {
      // Skip incomplete plugin versions.
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.root.localeCompare(a.root));
  if (!candidates.length) {
    throw new Error(`No complete WhatsApp relay plugin exists under ${cacheRoot}`);
  }
  return candidates[0];
}

try {
  const selected = await findCurrentPluginRoot();
  process.chdir(selected.root);
  const { ensureControllerRunningOnce } = await import(pathToFileURL(selected.watchdog).href);
  const result = await ensureControllerRunningOnce();
  await appendLog({
    event: "health_check",
    pluginRoot: selected.root,
    status: result.status,
    managerPid: result.processStatus?.pid ?? null
  });
} catch (error) {
  await appendLog({
    event: "health_check_failed",
    error: error?.stack ?? error?.message ?? String(error)
  }).catch(() => {});
  process.exitCode = 1;
}
