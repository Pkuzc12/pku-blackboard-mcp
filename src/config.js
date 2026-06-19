// Central path/config resolution. Everything is project-local by default so we
// never write to the user's global caches or touch system environment variables.
// All overrides come from env vars passed *into the MCP process* by the client
// config (process-scoped), never set on the system.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Project root = parent of src/
export const PROJECT_ROOT = path.resolve(__dirname, "..");

// Where session state, captured manifests and logs live.
export const DATA_DIR = path.resolve(
  process.env.PKU_DATA_DIR || path.join(PROJECT_ROOT, ".cache")
);

// Where downloaded videos are written.
export const DOWNLOAD_DIR = path.resolve(
  process.env.PKU_DOWNLOAD_DIR || path.join(PROJECT_ROOT, "downloads")
);

// Persisted Playwright storage state (cookies + localStorage) for the IAAA session.
export const STATE_FILE = path.join(DATA_DIR, "session-state.json");

// Project-local Playwright browser cache. Setting this means the fallback
// bundled Chromium (if ever downloaded) lands here, not in ~/.cache.
export const BROWSERS_DIR = path.join(DATA_DIR, "browsers");

// PKU teaching network entry point.
export const COURSE_HOME =
  process.env.PKU_COURSE_HOME || "https://course.pku.edu.cn";

// Optional course name to auto-click from the course list (e.g. "实验原子物理进展").
// Lets pku_capture_replay drive the full chain (home -> course -> recordings ->
// watch) unattended. Matched fuzzily, so minor typos still resolve.
export const COURSE_NAME = (process.env.PKU_COURSE_NAME || "").trim();

// Concurrency for HLS segment downloads.
export const DOWNLOAD_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.PKU_CONCURRENCY || "6", 10) || 6
);

export function ensureDirs() {
  for (const d of [DATA_DIR, DOWNLOAD_DIR, BROWSERS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// Point Playwright at our project-local browser dir for *this process only*.
// This mutates process.env (the spawned MCP process), not the OS environment.
export function applyBrowsersPath() {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_DIR;
  }
}
