// Session persistence + cookie handling.
//
// We persist Playwright's storageState (cookies + origins) to STATE_FILE after
// the user logs in once. For downloading we don't need a live browser: we build
// a per-host Cookie header from the saved cookies and replay it with fetch().

import fs from "node:fs";
import { STATE_FILE } from "./config.js";

export function hasSession() {
  try {
    return fs.existsSync(STATE_FILE) && fs.statSync(STATE_FILE).size > 0;
  } catch {
    return false;
  }
}

export function loadState() {
  if (!hasSession()) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function readCookies() {
  const state = loadState();
  return state && Array.isArray(state.cookies) ? state.cookies : [];
}

// Does a stored cookie's domain apply to `host`?
// Cookie domains may be ".pku.edu.cn" (suffix match) or "course.pku.edu.cn".
function domainMatches(cookieDomain, host) {
  if (!cookieDomain) return false;
  const d = cookieDomain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === d || h.endsWith("." + d);
}

// Build a "name=value; name2=value2" Cookie header for a given URL.
export function cookieHeaderFor(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return "";
  }
  const cookies = readCookies();
  const seen = new Set();
  const parts = [];
  for (const c of cookies) {
    if (!domainMatches(c.domain, host)) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join("; ");
}

// How many cookies do we hold for PKU domains? Used as a cheap "logged in"
// signal. Note the direction: we ask whether each cookie's domain falls under
// pku.edu.cn (e.g. "course.pku.edu.cn" or ".pku.edu.cn"), not the reverse.
export function pkuCookieCount() {
  return readCookies().filter((c) => {
    const d = (c.domain || "").replace(/^\./, "").toLowerCase();
    return d === "pku.edu.cn" || d.endsWith(".pku.edu.cn");
  }).length;
}
