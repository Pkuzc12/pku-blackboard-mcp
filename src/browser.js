// Browser launch strategy: prefer a system-installed Chrome, then Edge, and
// only if neither exists fall back to a project-local bundled Chromium
// (downloaded into DATA_DIR/browsers, never the global ~/.cache).

import { spawn } from "node:child_process";
import path from "node:path";
import { applyBrowsersPath, BROWSERS_DIR, PROJECT_ROOT } from "./config.js";

applyBrowsersPath();

// Imported after applyBrowsersPath so PLAYWRIGHT_BROWSERS_PATH is in effect.
const { chromium } = await import("playwright");

async function tryLaunch(opts) {
  const browser = await chromium.launch(opts);
  return browser;
}

// Download the bundled Chromium into our project-local browsers dir.
function installBundledChromium() {
  return new Promise((resolve, reject) => {
    const cli = path.join(
      PROJECT_ROOT,
      "node_modules",
      "playwright",
      "cli.js"
    );
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DIR },
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`playwright install chromium exited ${code}`))
    );
  });
}

// Launch a browser, returning { browser, engine }.
// `engine` is one of "chrome" | "msedge" | "chromium" for reporting.
export async function launchBrowser({ headless = false } = {}) {
  const common = {
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
  };

  // 1. System Chrome
  try {
    const browser = await tryLaunch({ ...common, channel: "chrome" });
    return { browser, engine: "chrome" };
  } catch {
    /* fall through */
  }

  // 2. System Edge
  try {
    const browser = await tryLaunch({ ...common, channel: "msedge" });
    return { browser, engine: "msedge" };
  } catch {
    /* fall through */
  }

  // 3. Project-local bundled Chromium (download on first use).
  try {
    const browser = await tryLaunch(common);
    return { browser, engine: "chromium" };
  } catch {
    await installBundledChromium();
    const browser = await tryLaunch(common);
    return { browser, engine: "chromium" };
  }
}
