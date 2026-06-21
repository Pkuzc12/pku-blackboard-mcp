// Session persistence + cookie handling.
//
// We persist Playwright's storageState (cookies + origins) to STATE_FILE after
// the user logs in once. For downloading we don't need a live browser: we build
// a per-host Cookie header from the saved cookies and replay it with fetch().

import fs from "node:fs";
import https from "node:https";
import { STATE_FILE, COURSE_HOME } from "./config.js";

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

// An authenticated Blackboard endpoint: returns 200 (the portal page) when the
// session is alive, and 302s away when it isn't. The site's public root (`/`)
// is a 200 landing page for everyone, so it can't tell us anything — we must
// hit something that actually requires auth.
const AUTH_PROBE_PATH =
  "/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1";

// Validate the saved session *without opening a browser*.
//
// hasSession() only proves the state file exists; the cookies inside may have
// expired. Here we replay them against an authenticated course endpoint and
// read the verdict from the status code. Returns:
//   { valid: true }                        — session works
//   { valid: false, reason: "no-session" } — nothing saved
//   { valid: false, reason: "expired" }    — endpoint bounced us (not logged in)
//   { valid: null,  reason: "..." }        — couldn't tell (network/timeout)
// `valid: null` is deliberately distinct from false so callers don't tell the
// user to re-login just because they're offline or behind a flaky proxy.
//
// We use node:https (not global fetch) with rejectUnauthorized:false because
// course.pku.edu.cn serves an incomplete certificate chain: browsers repair it
// via AIA fetching but Node's fetch hard-fails with UNABLE_TO_VERIFY_LEAF_
// SIGNATURE. We only send our own session cookie to the legitimate course host,
// so relaxing chain verification for this one probe is acceptable.
export async function checkSessionValid({ timeoutMs = 8000 } = {}) {
  if (!hasSession()) return { valid: false, reason: "no-session" };

  let target;
  try {
    target = new URL(AUTH_PROBE_PATH, COURSE_HOME);
  } catch {
    return { valid: null, reason: "bad-course-home" };
  }
  const cookie = cookieHeaderFor(COURSE_HOME);

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const req = https.request(
      target,
      {
        method: "GET",
        rejectUnauthorized: false,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        res.resume(); // drain; we only need the status line
        if (status >= 200 && status < 300) return done({ valid: true });
        if (status >= 300 && status < 400)
          return done({ valid: false, reason: "expired" });
        done({ valid: null, reason: `http-${status}` });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ valid: null, reason: "timeout" });
    });
    req.on("error", (err) =>
      done({ valid: null, reason: String(err && err.message ? err.message : err) })
    );
    req.end();
  });
}
