// Interactive browser flows: one-time IAAA login, and m3u8 capture.
//
// Both open a *headed* window (so the user can complete SSO / navigate to the
// replay and press play) and persist the refreshed session to STATE_FILE.

import fs from "node:fs";
import { launchBrowser } from "./browser.js";
import {
  STATE_FILE,
  COURSE_HOME,
  COURSE_NAME,
  ensureDirs,
  applyBrowsersPath,
} from "./config.js";
import { hasSession, checkSessionValid } from "./session.js";
import { httpGet, listLessonsHttp, listCoursesHttp } from "./portal.js";
import { startDirectDownload, startDownload } from "./jobs.js";

applyBrowsersPath();

const IAAA_HOSTS = ["iaaa.pku.edu.cn", "wproxy.pku.edu.cn"];

function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isCourseHost(u) {
  return hostOf(u).endsWith("course.pku.edu.cn");
}

function isLoginHost(u) {
  return IAAA_HOSTS.some((h) => hostOf(u).endsWith(h));
}

async function newContext(browser, { fresh = false } = {}) {
  return browser.newContext({
    storageState: !fresh && hasSession() ? STATE_FILE : undefined,
    ignoreHTTPSErrors: true,
    viewport: null,
    userAgent: undefined,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Selectors/texts that identify a lesson "watch" link in the recordings list.
// Shared by enumeration, click-by-index, and the autoplay pump so listing and
// playing always agree on what counts as a lesson and in what order.
const LESSON_SELS = [
  'a[href*="playVideo"]',
  'a[onclick*="playVideo"]',
  'a[href*="play_video"]',
  'a[href*="vodVideo"]',
  ".lesson-item a",
];
const LESSON_TEXTS = ["观看回放", "观看", "播放回放", "回看", "播放"];

// Texts of the recordings-section menu/tab leading to the lesson list.
const RECORDINGS_TEXTS = [
  "课堂实录",
  "课程回放",
  "课堂录像",
  "录播",
  "视频回放",
  "教学视频",
];

// Click the first element in any frame that matches a CSS selector, or whose
// trimmed visible text contains one of `texts`. Returns a short label of what
// was clicked, or null. Every step is wrapped so a bad frame never throws.
// `fuzzy`: when no exact-substring text match is found, fall back to subsequence
// matching (query chars appear in order in the title) and click the *tightest*
// match — the shortest title containing the subsequence. This lets a course name
// like "实验原子物理进展" match the real title "实验原子物理学进展(25-26学年第2学期)"
// even though it's not a literal substring. Only enable for course-name clicks;
// short keywords (观看/课堂实录) stay on exact substring to avoid false hits.
async function clickFirst(page, { sels = [], texts = [], fuzzy = false }) {
  for (const frame of page.frames()) {
    const label = await frame
      .evaluate(
        ({ sels, texts, fuzzy }) => {
          const go = (el) => {
            try {
              el.scrollIntoView({ block: "center" });
            } catch {}
            try {
              el.click();
            } catch {}
          };
          for (const s of sels) {
            const el = document.querySelector(s);
            if (el) {
              go(el);
              return "sel:" + s;
            }
          }
          if (texts.length) {
            const norm = (s) => (s || "").replace(/\s+/g, "");
            const qs = texts.map(norm).filter(Boolean);
            // isSubseq: are all chars of q present in t in order?
            const isSubseq = (q, t) => {
              let i = 0;
              for (let j = 0; j < t.length && i < q.length; j++) {
                if (t[j] === q[i]) i++;
              }
              return i === q.length;
            };
            // NB: page scripts here break Array.from on Sets, but Array.from on a
            // NodeList works; we iterate the NodeList directly to be safe.
            const cands = document.querySelectorAll(
              'a, button, [onclick], [role="link"], [role="button"]'
            );
            // Pass 1: exact substring (original behaviour, first in DOM order).
            for (const el of cands) {
              const t = norm(el.textContent);
              if (t && qs.some((x) => t.includes(x))) {
                go(el);
                return "text:" + t.slice(0, 24);
              }
            }
            // Pass 2 (fuzzy only): subsequence, pick the shortest matching title.
            if (fuzzy) {
              let best = null;
              let bestLen = Infinity;
              for (const el of cands) {
                const t = norm(el.textContent);
                if (!t || t.length >= bestLen) continue;
                if (qs.some((x) => isSubseq(x, t))) {
                  best = el;
                  bestLen = t.length;
                }
              }
              if (best) {
                go(best);
                return "fuzzy:" + norm(best.textContent).slice(0, 24);
              }
            }
          }
          return null;
        },
        { sels, texts, fuzzy }
      )
      .catch(() => null);
    if (label) return label;
  }
  return null;
}

// Browser-context source for collecting lesson "watch" elements in document
// order (deduped) and deriving a readable title per element. Injected verbatim
// into every frame.evaluate below so enumeration and click-by-index share the
// exact same matching + ordering rules.
const LESSON_DOM_HELPERS = `
  function __collectLessons(sels, texts) {
    const set = new Set();
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) set.add(el);
    }
    // NB: iterate the NodeList directly and build arrays via push/forEach.
    // Legacy page scripts (Blackboard ships an old prototype.js-style lib)
    // override Array.from to an array-like-only impl, so Array.from(set) on a
    // pure iterable silently yields []. for-of + forEach are unaffected.
    for (const el of document.querySelectorAll(
      'a, button, [onclick], [role="link"], [role="button"]'
    )) {
      const t = (el.textContent || "").replace(/\\s+/g, "");
      if (t && texts.some((x) => t.includes(x))) set.add(el);
    }
    const els = [];
    set.forEach((el) => els.push(el));
    els.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return els;
  }
  function __titleFor(el) {
    // The lesson's own row/cell. Prefer the nearest table row or list item;
    // fall back to climbing for a lesson/item/row-classed ancestor. Do NOT
    // match "list" — that catches the whole list container and would return
    // every lesson's text concatenated into one title.
    let container = null;
    try { container = el.closest('tr, li, .lesson-item'); } catch (e) {}
    if (!container) {
      let node = el;
      for (let i = 0; i < 4 && node; i++) {
        const cls = (node.className && node.className.toString) ? node.className.toString() : "";
        if (node.classList && (node.classList.contains("lesson-item") || /lesson|item|row/i.test(cls))) { container = node; break; }
        node = node.parentElement;
      }
    }
    container = container || el;
    let t = (container.textContent || "").replace(/\\s+/g, " ").trim();
    if (!t) t = (el.textContent || "").replace(/\\s+/g, " ").trim();
    return t.slice(0, 120);
  }
`;

// Enumerate lesson "watch" entries across all frames, in document order, as
// { index (1-based), title }. Same selectors/texts as the autoplay pump, so the
// list the user sees matches what clickLessonByIndex will play.
async function enumerateLessons(page) {
  const out = [];
  for (const frame of page.frames()) {
    const titles = await frame
      .evaluate(
        new Function(
          "args",
          LESSON_DOM_HELPERS +
            "const { sels, texts } = args;" +
            "return __collectLessons(sels, texts).map(__titleFor);"
        ),
        { sels: LESSON_SELS, texts: LESSON_TEXTS }
      )
      .catch(() => []);
    for (const title of titles) out.push({ index: out.length + 1, title });
  }
  return out;
}

// Click the idx-th (1-based) lesson across all frames, using the same global
// ordering as enumerateLessons. Walks frames accumulating counts so a global
// index maps to the right frame + local position. Returns the clicked lesson's
// title, or null if idx is out of range.
async function clickLessonByIndex(page, idx) {
  let remaining = idx - 1; // 0-based offset into the global list
  for (const frame of page.frames()) {
    const res = await frame
      .evaluate(
        new Function(
          "args",
          LESSON_DOM_HELPERS +
            "const { sels, texts, k } = args;" +
            "const els = __collectLessons(sels, texts);" +
            "if (k >= 0 && k < els.length) {" +
            "  const el = els[k];" +
            "  try { el.scrollIntoView({ block: 'center' }); } catch (e) {}" +
            "  try { el.click(); } catch (e) {}" +
            "  return { clicked: true, count: els.length, title: __titleFor(el) };" +
            "}" +
            "return { clicked: false, count: els.length };"
        ),
        { sels: LESSON_SELS, texts: LESSON_TEXTS, k: remaining }
      )
      .catch(() => ({ clicked: false, count: 0 }));
    if (res.clicked) return res.title || true;
    remaining -= res.count;
  }
  return null;
}

// Drive course-list -> course -> recordings section, stopping as soon as the
// lesson list is visible (does NOT click any "watch" link). One click per tick
// (mirrors pumpAutoplay):
// recordings-section menu first, else click into the named course. Returns
// { ok, listUrl, count } where ok means the lesson list was reached.
async function gotoRecordingsList(page, courseName, deadline) {
  while (Date.now() < deadline) {
    const lessons = await enumerateLessons(page).catch(() => []);
    if (lessons.length > 0) {
      return { ok: true, listUrl: page.url(), count: lessons.length };
    }
    const menu = await clickFirst(page, { texts: RECORDINGS_TEXTS });
    if (!menu && courseName) {
      await clickFirst(page, { texts: [courseName], fuzzy: true });
    }
    await sleep(1200);
  }
  const lessons = await enumerateLessons(page).catch(() => []);
  return {
    ok: lessons.length > 0,
    listUrl: page.url(),
    count: lessons.length,
  };
}

// Play any <video> and click big-play overlays across all frames. Pure playback
// nudge — NO navigation — so it's safe to call repeatedly while waiting for a
// specific lesson's m3u8 to fire. Returns true if any <video> was present.
async function pumpPlayVideos(page) {
  let anyVideo = false;
  for (const frame of page.frames()) {
    const n = await frame
      .evaluate(() => {
        const vids = Array.from(document.querySelectorAll("video"));
        for (const v of vids) {
          try {
            v.muted = true;
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
          } catch {}
        }
        const playSels = [
          ".vjs-big-play-button",
          ".prism-big-play-btn",
          '[class*="big-play"]',
          '[class*="playBtn"]',
          '[class*="play-btn"]',
          '[aria-label*="播放"]',
          '[title*="播放"]',
        ];
        for (const s of playSels) {
          for (const el of document.querySelectorAll(s)) {
            try {
              el.click();
            } catch {}
          }
        }
        return vids.length;
      })
      .catch(() => 0);
    anyVideo = anyVideo || n > 0;
  }
  return anyVideo;
}

// Best-effort auto-play, ONE navigation step per tick (the caller loops). Takes
// the first applicable action, most-specific first — mirroring the manual flow
// from the reference skill: course list -> open course -> recordings -> "watch"
// -> play.
//   1) a <video> exists  -> mute + play() and click any big-play overlay;
//   2) a lesson "watch" link (a[href*="playVideo"], .lesson-item a) -> click it;
//   3) a recordings-section menu item (RECORDINGS_TEXTS) -> click it;
//   4) on the course list, a course whose title matches `courseName` -> click it.
// Returns a tag describing the action (for logging), or null if nothing matched.
async function pumpAutoplay(page, courseName) {
  // 1) Real <video>? Play it and click overlays across all frames.
  if (await pumpPlayVideos(page)) return "play-video";

  // 2) A lesson/session "watch" link to open the player.
  const lesson = await clickFirst(page, {
    sels: LESSON_SELS,
    texts: LESSON_TEXTS,
  });
  if (lesson) return "lesson(" + lesson + ")";

  // 3) A recordings-section menu/tab item leading to the lesson list.
  const menu = await clickFirst(page, { texts: RECORDINGS_TEXTS });
  if (menu) return "menu(" + menu + ")";

  // 4) On the course list, click into the named course (if configured).
  if (courseName) {
    const course = await clickFirst(page, { texts: [courseName], fuzzy: true });
    if (course) return "course(" + course + ")";
  }

  return null;
}

// Diagnostic snapshot of the live page, returned when capture fails so we can
// pin exact selectors instead of guessing. Per frame: URL, <iframe src>s,
// <video src>s, and up to 40 anchors/buttons with visible text + href/onclick.
// Truncated to stay small and readable.
async function dumpPage(page) {
  const frames = [];
  for (const frame of page.frames()) {
    const info = await frame
      .evaluate(() => {
        const clip = (s, n = 140) =>
          s && s.length > n ? s.slice(0, n) + "…" : s || "";
        const anchors = Array.from(
          document.querySelectorAll('a, button, [onclick], [role="button"]')
        )
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            text: clip((el.textContent || "").replace(/\s+/g, " ").trim(), 40),
            href: clip(el.getAttribute("href") || ""),
            onclick: clip(el.getAttribute("onclick") || ""),
            cls: clip(el.getAttribute("class") || "", 60),
          }))
          .filter((a) => a.text || a.href || a.onclick)
          .slice(0, 40);
        const videos = Array.from(document.querySelectorAll("video")).map((v) => ({
          src: clip(v.currentSrc || v.src || ""),
          cls: clip(v.className, 60),
        }));
        const iframes = Array.from(document.querySelectorAll("iframe"))
          .map((f) => clip(f.getAttribute("src") || ""))
          .filter(Boolean)
          .slice(0, 10);
        return { title: clip(document.title, 80), anchors, videos, iframes };
      })
      .catch(() => null);
    if (info) frames.push({ url: frame.url(), ...info });
  }
  return frames;
}

// Open a headed window at the course home, wait for the user to finish IAAA
// login (detected when the active page lands back on course.pku.edu.cn), then
// persist the session. Returns a summary object.
export async function runLogin({ timeoutMs = 300000 } = {}) {
  ensureDirs();
  // Decide up front whether we're "topping up" a working session or doing a
  // fresh login — and crucially, verify the saved session actually WORKS, not
  // just that a state file exists. course.pku.edu.cn's root is a public 200
  // landing page, so a stale state file would otherwise make us land on the
  // course host, declare success instantly, and close the window before the
  // user can log in. Only an actually-valid session lets us accept "on course
  // host" immediately; for an expired/absent one we require seeing the IAAA
  // bounce first, exactly like a brand-new login.
  const check = await checkSessionValid().catch(() => ({ valid: null }));
  const startedWithSession = check.valid === true;
  const { browser, engine } = await launchBrowser({ headless: false });
  try {
    // Start from a clean context unless the saved session is actually valid:
    // loading stale cookies can leave the site half-logged-in and get in the
    // way of a fresh IAAA login.
    const context = await newContext(browser, { fresh: !startedWithSession });
    const page = await context.newPage();
    // For a fresh/expired login, open an *authenticated* endpoint rather than
    // the public root: course.pku.edu.cn/ is a 200 landing page that won't
    // bounce an unauthenticated visitor, so the user would have to find the
    // login link themselves. The portal tab endpoint 302s straight to IAAA when
    // there's no valid session, landing the window right on the login form. A
    // valid session just renders the portal, which is fine too.
    const entry = startedWithSession
      ? COURSE_HOME
      : new URL(
          "/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1",
          COURSE_HOME
        ).href;
    await page.goto(entry, { waitUntil: "domcontentloaded" }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    let loggedIn = false;
    let sawLogin = startedWithSession;
    while (Date.now() < deadline) {
      // Look across all open pages: note any visit to the IAAA portal, and
      // detect a page sitting on the course host (post-login).
      const pages = context.pages();
      let onCourse = false;
      for (const p of pages) {
        const u = p.url();
        if (isLoginHost(u)) sawLogin = true;
        if (isCourseHost(u) && !isLoginHost(u)) onCourse = true;
      }
      if (onCourse && sawLogin) loggedIn = true;
      if (loggedIn) {
        // Give the app a moment to set all cookies, then confirm.
        await sleep(2500);
        break;
      }
      await sleep(1500);
    }

    if (!loggedIn) {
      return {
        ok: false,
        engine,
        message:
          "Login timed out: never returned to course.pku.edu.cn. Retry pku_login and finish IAAA login in the window. / 登录超时：未检测到回到 course.pku.edu.cn。请重试 pku_login 并在窗口里完成 IAAA 登录。",
      };
    }

    await context.storageState({ path: STATE_FILE });
    return {
      ok: true,
      engine,
      stateFile: STATE_FILE,
      message: "Login succeeded, session saved. / 登录成功，会话已保存。",
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Open a headed window (optionally navigated to `url`), listen for every
// *.m3u8 request, and let the user reach the replay and press play. Returns the
// captured playlist URLs (deduped, master playlists first heuristically).
export async function captureReplay({
  url,
  timeoutMs = 240000,
  autoplay = true,
  course,
} = {}) {
  ensureDirs();
  if (!hasSession()) {
    return {
      ok: false,
      message: "Not logged in. Run pku_login first. / 尚未登录。请先运行 pku_login。",
    };
  }
  const courseName = (course || COURSE_NAME || "").trim();
  const { browser, engine } = await launchBrowser({ headless: false });
  const captured = new Map(); // url -> { url, referer }
  try {
    const context = await newContext(browser);

    context.on("request", (req) => {
      const u = req.url();
      if (/\.m3u8(\?|$)/i.test(u) && !captured.has(u)) {
        captured.set(u, {
          url: u,
          referer: req.headers()["referer"] || null,
        });
      }
    });

    const page = await context.newPage();
    const target = url || COURSE_HOME;
    await page.goto(target, { waitUntil: "domcontentloaded" }).catch(() => {});

    // If we got bounced to IAAA, the saved session expired.
    await sleep(2000);
    if (isLoginHost(page.url())) {
      await browser.close().catch(() => {});
      return {
        ok: false,
        message:
          "Session expired, redirected to IAAA login. Run pku_login again. / 会话已过期，被重定向到 IAAA 登录。请重新运行 pku_login。",
      };
    }

    // Poll until we capture at least one playlist, then a short grace period to
    // collect variant playlists, or until timeout. Each tick we also nudge the
    // player to auto-play (until the first playlist shows up).
    const deadline = Date.now() + timeoutMs;
    let graceUntil = null;
    const actions = []; // trail of what autoplay clicked, for diagnostics
    while (Date.now() < deadline) {
      if (autoplay && captured.size === 0) {
        const did = await pumpAutoplay(page, courseName).catch(() => null);
        if (did && actions[actions.length - 1] !== did) actions.push(did);
      }
      if (captured.size > 0) {
        if (graceUntil === null) graceUntil = Date.now() + 4000;
        if (Date.now() >= graceUntil) break;
      }
      await sleep(1200);
    }

    // Refresh the session (cookies may have rotated).
    await context.storageState({ path: STATE_FILE }).catch(() => {});

    const playlists = [...captured.values()];
    if (playlists.length > 0) {
      return {
        ok: true,
        engine,
        count: playlists.length,
        playlists,
        autoplayActions: actions,
        message: `Captured ${playlists.length} m3u8 playlist(s) / 捕获到 ${
          playlists.length
        } 个 m3u8 播放列表 (autoplay: ${actions.join(" -> ") || "none"}).`,
      };
    }

    // Nothing captured: dump the live page so we can pin exact selectors.
    const diagnostics = await dumpPage(page).catch(() => []);
    return {
      ok: false,
      engine,
      count: 0,
      playlists: [],
      autoplayActions: actions,
      diagnostics,
      message:
        "No m3u8 captured. / 未捕获到 m3u8。" +
        (courseName
          ? ""
          : " No course name set, cannot auto-open the course. / （未设置课程名，无法自动从课程列表点进目标课）") +
        " See autoplayActions for the click trail; diagnostics lists the page's real links/buttons/iframes. " +
        "Paste it back to pin exact selectors, or play the replay manually in the window, or pass a direct `url`. / " +
        "自动操作轨迹见 autoplayActions；diagnostics 列出了当前页面真实的链接/按钮/iframe，" +
        "把这段贴回来即可定位精确选择器。也可在窗口里手动点开回放播放，或传 url 直达回放页。",
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// List the user's courses, browser-free. Answers "what courses do I have" so
// the model never has to open a window just to enumerate courses.
export async function listCourses() {
  ensureDirs();
  if (!hasSession()) {
    return { ok: false, message: "Not logged in. Run pku_login first. / 尚未登录。请先运行 pku_login。" };
  }
  const r = await listCoursesHttp().catch((e) => ({
    ok: false,
    reason: "http-error",
    detail: String(e && e.message ? e.message : e),
  }));
  if (r.ok) {
    return {
      ok: true,
      via: "http",
      count: r.count,
      courses: r.courses.map((c) => c.title),
      message: `Found ${r.count} courses (no browser) / 找到 ${r.count} 门课（未开浏览器）. Pass a course name to pku_list_lessons. / 用课程名调用 pku_list_lessons 查看课次。`,
    };
  }
  if (r.reason === "expired") {
    return {
      ok: false,
      message:
        "Session expired, redirected to IAAA login. Run pku_login again. / 会话已过期，被重定向到 IAAA 登录。请重新运行 pku_login。",
    };
  }
  return {
    ok: false,
    reason: r.reason,
    message: `Could not list courses (${r.reason}). / 无法列出课程（${r.reason}）。`,
  };
}

// List a course's lessons. Tries the browser-free path first (replay saved
// cookies, parse the server-rendered recordings list — no window), and only
// falls back to opening a browser if HTTP parsing finds nothing (e.g. a course
// on a non-standard player whose list page we can't parse). The user picks
// indices from the result, then passes them to downloadLessons.
export async function listLessons({ url, timeoutMs = 120000, course } = {}) {
  ensureDirs();
  if (!hasSession()) {
    return { ok: false, message: "Not logged in. Run pku_login first. / 尚未登录。请先运行 pku_login。" };
  }
  const courseName = (course || COURSE_NAME || "").trim();

  // Browser-free path.
  const http = await listLessonsHttp({ course: courseName, url }).catch((e) => ({
    ok: false,
    reason: "http-error",
    detail: String(e && e.message ? e.message : e),
  }));

  if (http.ok) {
    return {
      ok: true,
      via: "http",
      course: http.course,
      listUrl: http.listUrl,
      count: http.count,
      lessons: http.lessons,
      message: `Found ${http.count} lessons (no browser) / 找到 ${http.count} 节课（未开浏览器）. Pick indices and pass them to pku_download_lessons. / 确认序号后用 pku_download_lessons 传 indices 下载。`,
    };
  }

  if (http.reason === "expired") {
    return {
      ok: false,
      message:
        "Session expired, redirected to IAAA login. Run pku_login again. / 会话已过期，被重定向到 IAAA 登录。请重新运行 pku_login。",
    };
  }

  // We fetched the course list fine but no course matched the given name. The
  // browser would see the exact same list and miss the same way, so don't open
  // a window — return the real course list so the user can fix the name.
  if (http.reason === "no-course") {
    return {
      ok: false,
      reason: "no-course",
      courses: http.courses || [],
      message:
        `No course matched "${courseName}". Your courses are listed in \`courses\` — pass an exact/closer name (fuzzy-matched) or a direct \`url\`. / 没有匹配到课程“${courseName}”。你的课程见 courses 字段，请改用更准确的课程名（支持模糊匹配）或直接传 url。`,
    };
  }

  // No course name and no url to disambiguate. Don't open a browser to a generic
  // home page and wait — list the courses so the user can pick one.
  if (http.reason === "no-course-name" && !url) {
    const courses = await listCourses();
    if (courses.ok) {
      return {
        ok: false,
        reason: "need-course",
        courses: courses.courses,
        message:
          "Which course? Pick one from `courses` and pass it as `course`. / 想看哪门课？从 courses 里选一个，用 course 参数传入。",
      };
    }
    return courses; // not-logged-in / expired / error — already a clean message
  }

  // Other failures (couldn't parse recordings/lessons, network, no course name)
  // — fall back to the browser flow, which can handle courses whose recordings
  // list we can't parse over plain HTTP, or let you navigate manually.
  return listLessonsBrowser({ url, timeoutMs, course: courseName, httpReason: http.reason });
}

// Browser fallback: open a headed window (reusing the session), navigate to the
// course's recordings list WITHOUT playing anything, and return every lesson as
// { index (1-based), title }.
async function listLessonsBrowser({ url, timeoutMs = 120000, course, httpReason } = {}) {
  ensureDirs();
  if (!hasSession()) {
    return { ok: false, message: "Not logged in. Run pku_login first. / 尚未登录。请先运行 pku_login。" };
  }
  const courseName = (course || COURSE_NAME || "").trim();
  const { browser, engine } = await launchBrowser({ headless: false });
  try {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page
      .goto(url || COURSE_HOME, { waitUntil: "domcontentloaded" })
      .catch(() => {});

    await sleep(2000);
    if (isLoginHost(page.url())) {
      await browser.close().catch(() => {});
      return {
        ok: false,
        message:
          "Session expired, redirected to IAAA login. Run pku_login again. / 会话已过期，被重定向到 IAAA 登录。请重新运行 pku_login。",
      };
    }

    const nav = await gotoRecordingsList(
      page,
      courseName,
      Date.now() + timeoutMs
    );
    await context.storageState({ path: STATE_FILE }).catch(() => {});
    const lessons = await enumerateLessons(page).catch(() => []);

    if (lessons.length > 0) {
      return {
        ok: true,
        engine,
        listUrl: nav.listUrl,
        count: lessons.length,
        lessons,
        message: `Found ${lessons.length} lessons / 找到 ${lessons.length} 节课. Pick indices and pass them to pku_download_lessons. / 确认序号后用 pku_download_lessons 传 indices 下载。`,
      };
    }

    const diagnostics = await dumpPage(page).catch(() => []);
    return {
      ok: false,
      engine,
      count: 0,
      lessons: [],
      diagnostics,
      message:
        "Lesson list not found. / 未找到课次列表。" +
        (courseName
          ? ""
          : " No course name set, cannot auto-open the course. / （未设置课程名，无法自动从课程列表点进目标课）") +
        " diagnostics is a snapshot of the page's real links/buttons; pass a direct recordings-list `url`, or navigate manually in the window and retry. / " +
        "diagnostics 是当前页面真实的链接/按钮快照；可传 url 直达「课堂实录」列表页，或在窗口里手动导航后重试。",
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// From the captured m3u8 map, return the first NEW playlist (not in `seen`),
// preferring a master/index-looking URL. resolveMediaPlaylist (hls.js) handles
// either a master or a media playlist, so any new one is downloadable.
function pickNewPlaylist(captured, seen) {
  const fresh = [...captured.values()].filter((v) => !seen.has(v.url));
  if (fresh.length === 0) return null;
  return fresh.find((v) => /playlist|index|master/i.test(v.url)) || fresh[0];
}

function pickNewMedia(captured, seen) {
  const fresh = [...captured.values()].filter((v) => !seen.has(v.url));
  if (fresh.length === 0) return null;
  return fresh.find((v) => v.kind === "hls" && /playlist|index|master/i.test(v.url)) || fresh[0];
}

async function resolvePlayerUrl(playUrl) {
  const page = await httpGet(playUrl).catch(() => null);
  if (!page || page.status < 200 || page.status >= 300) return playUrl;
  for (const m of page.body.matchAll(/<iframe[^>]+src="([^"]+)"/gi)) {
    const u = new URL(m[1], page.url).href;
    if (/yjapise\.pku\.edu\.cn|onlineroomse\.pku\.edu\.cn/i.test(u)) return u;
  }
  return playUrl;
}

async function collectVideoSources(page) {
  const out = [];
  for (const frame of page.frames()) {
    const urls = await frame
      .evaluate(() =>
        Array.from(document.querySelectorAll("video"))
          .map((v) => v.currentSrc || v.src || "")
          .filter(Boolean)
      )
      .catch(() => []);
    for (const url of urls) out.push({ url, referer: frame.url(), kind: /\.m3u8(\?|$)/i.test(url) ? "hls" : "direct" });
  }
  return out;
}

// Download chosen lessons. Like listLessons, we first resolve the lesson list
// browser-free (replay saved cookies, parse the recordings page). That gives us
// each lesson's direct player URL (playVideo.action?token=…), so the browser can
// navigate STRAIGHT to a lesson instead of counting DOM links and clicking the
// Nth "watch" anchor — no list-page restoration between lessons, no index drift.
// We still need a headed browser for the player itself: resolving token -> m3u8
// happens in client JS (SSO + stream lookup) that can't be replayed over HTTP.
// If the HTTP list can't be parsed (non-standard player), we fall back to the
// click-by-index browser flow, which can drive those pages by enumeration.
export async function downloadLessons({
  indices,
  url,
  timeoutMs = 180000,
  course,
  format = "mp4",
  outDir,
  namePrefix,
} = {}) {
  ensureDirs();
  if (!hasSession()) {
    return { ok: false, message: "Not logged in. Run pku_login first. / 尚未登录。请先运行 pku_login。" };
  }
  const wanted = [
    ...new Set((indices || []).filter((n) => Number.isInteger(n) && n >= 1)),
  ].sort((a, b) => a - b);
  if (wanted.length === 0) {
    return {
      ok: false,
      message:
        "Pass `indices` (array of 1-based integers) for the lessons to download; use pku_list_lessons first to see them. / 请用 indices 传入要下载的课次序号（1 起的整数数组）。可先用 pku_list_lessons 查看序号。",
    };
  }
  const courseName = (course || COURSE_NAME || "").trim();
  const prefix = (namePrefix || courseName || "lesson").trim();

  // Browser-free list -> per-lesson playUrl. On success, navigate straight to it.
  const http = await listLessonsHttp({ course: courseName, url }).catch((e) => ({
    ok: false,
    reason: "http-error",
    detail: String(e && e.message ? e.message : e),
  }));
  if (http.reason === "expired") {
    return {
      ok: false,
      message:
        "Session expired, redirected to IAAA login. Run pku_login again. / 会话已过期，被重定向到 IAAA 登录。请重新运行 pku_login。",
    };
  }
  if (http.ok && http.lessons.some((l) => l.playUrl)) {
    return downloadLessonsDirect({
      lessons: http.lessons,
      wanted,
      prefix,
      timeoutMs,
      format,
      outDir,
    });
  }

  // Course list fetched but no match — the browser would miss the same way, so
  // don't open a window; return the real list so the user can fix the name.
  if (http.reason === "no-course") {
    return {
      ok: false,
      reason: "no-course",
      courses: http.courses || [],
      message:
        `No course matched "${courseName}". Your courses are listed in \`courses\` — pass an exact/closer name (fuzzy-matched) or a direct \`url\`. / 没有匹配到课程“${courseName}”。你的课程见 courses 字段，请改用更准确的课程名（支持模糊匹配）或直接传 url。`,
    };
  }

  // Couldn't parse a direct list — fall back to the click-by-index browser flow.
  return downloadLessonsBrowser({ indices: wanted, url, timeoutMs, course: courseName, format, outDir, namePrefix: prefix });
}

// Direct path: we already hold each lesson's player URL, so open ONE headed
// window and page.goto() the chosen lesson's playUrl in turn, capturing its
// m3u8. No DOM enumeration, no list restoration — each navigation is self-
// contained, so lesson order can't drift and a player popup can't desync us.
async function downloadLessonsDirect({ lessons, wanted, prefix, timeoutMs = 180000, format = "mp4", outDir } = {}) {
  const { browser, engine } = await launchBrowser({ headless: false });
  const captured = new Map(); // url -> { url, referer, kind }
  try {
    const context = await newContext(browser);
    context.on("request", (req) => {
      const u = req.url();
      if ((/\.m3u8(\?|$)/i.test(u) || /\.mp4(\?|$)/i.test(u)) && !captured.has(u)) {
        captured.set(u, {
          url: u,
          referer: req.headers()["referer"] || null,
          kind: /\.m3u8(\?|$)/i.test(u) ? "hls" : "direct",
        });
      }
    });
    const page = await context.newPage();

    const results = [];
    const skipped = [];
    for (const idx of wanted) {
      const lesson = lessons[idx - 1];
      if (!lesson || !lesson.playUrl) {
        skipped.push({
          index: idx,
          reason: `out of range, ${lessons.length} total / 超出范围（共 ${lessons.length} 节）`,
        });
        continue;
      }

      const seen = new Set(captured.keys());
      // Go straight to this lesson's real player page. Blackboard embeds the
      // onlineroomse SSO/player inside an iframe; opening that SSO URL as the
      // top-level page avoids intermittent iframe network failures and exposes
      // direct mp4 sources for some older recordings.
      const playerUrl = await resolvePlayerUrl(lesson.playUrl);
      await page
        .goto(playerUrl, { waitUntil: "domcontentloaded" })
        .catch(() => {});
      await sleep(2000);
      if (isLoginHost(page.url())) {
        await browser.close().catch(() => {});
        return {
          ok: false,
          message:
            "Session expired, redirected to IAAA login. Run pku_login again. / 会话已过期，被重定向到 IAAA 登录。请重新运行 pku_login。",
        };
      }

      // Wait for THIS lesson's media URL, nudging playback each tick.
      const perDeadline = Date.now() + timeoutMs;
      let pick = null;
      while (Date.now() < perDeadline) {
        await pumpPlayVideos(page).catch(() => {});
        for (const src of await collectVideoSources(page)) {
          if (!captured.has(src.url)) captured.set(src.url, src);
        }
        pick = pickNewMedia(captured, seen);
        if (pick) {
          await sleep(1500); // brief grace for variant playlists to also appear
          for (const src of await collectVideoSources(page)) {
            if (!captured.has(src.url)) captured.set(src.url, src);
          }
          pick = pickNewMedia(captured, seen);
          break;
        }
        await sleep(1200);
      }

      if (!pick) {
        skipped.push({
          index: idx,
          reason: "timed out waiting for media URL / 超时未捕获到媒体地址",
        });
        continue;
      }

      const name = `${prefix}-${String(idx).padStart(2, "0")}`;
      const job =
        pick.kind === "hls"
          ? startDownload({
              m3u8: pick.url,
              name,
              referer: pick.referer || undefined,
              outDir,
              format,
            })
          : startDirectDownload({
              url: pick.url,
              name,
              referer: pick.referer || page.url(),
              outDir,
            });
      results.push({
        index: idx,
        title: lesson.title || null,
        mediaUrl: pick.url,
        mediaType: pick.kind,
        jobId: job.id,
        name: job.name,
      });
    }

    await context.storageState({ path: STATE_FILE }).catch(() => {});
    return {
      ok: results.length > 0,
      engine,
      via: "http-direct",
      results,
      skipped,
      message:
        `Started background downloads for ${results.length} lesson(s) / 已对 ${results.length} 节课起后台下载任务` +
        (skipped.length
          ? `, skipped ${skipped.length} (see skipped) / ，跳过 ${skipped.length} 节（见 skipped）`
          : "") +
        ". Track progress with pku_download_status. / 。用 pku_download_status 查询进度。",
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Browser fallback: open ONE headed window (reusing the session), navigate to the
// recordings list, then for each chosen index: count to the Nth lesson link,
// click it, capture its m3u8, and kick off a background download job. Used when
// the browser-free list can't be parsed. Returns the started jobs.
async function downloadLessonsBrowser({
  indices,
  url,
  timeoutMs = 180000,
  course,
  format = "mp4",
  outDir,
  namePrefix,
} = {}) {
  ensureDirs();
  if (!hasSession()) {
    return { ok: false, message: "Not logged in. Run pku_login first. / 尚未登录。请先运行 pku_login。" };
  }
  const wanted = [
    ...new Set((indices || []).filter((n) => Number.isInteger(n) && n >= 1)),
  ].sort((a, b) => a - b);
  if (wanted.length === 0) {
    return {
      ok: false,
      message:
        "Pass `indices` (array of 1-based integers) for the lessons to download; use pku_list_lessons first to see them. / 请用 indices 传入要下载的课次序号（1 起的整数数组）。可先用 pku_list_lessons 查看序号。",
    };
  }
  const courseName = (course || COURSE_NAME || "").trim();
  const prefix = (namePrefix || courseName || "lesson").trim();
  const { browser, engine } = await launchBrowser({ headless: false });
  const captured = new Map(); // url -> { url, referer }
  try {
    const context = await newContext(browser);
    context.on("request", (req) => {
      const u = req.url();
      if (/\.m3u8(\?|$)/i.test(u) && !captured.has(u)) {
        captured.set(u, { url: u, referer: req.headers()["referer"] || null });
      }
    });

    const page = await context.newPage();
    await page
      .goto(url || COURSE_HOME, { waitUntil: "domcontentloaded" })
      .catch(() => {});

    await sleep(2000);
    if (isLoginHost(page.url())) {
      await browser.close().catch(() => {});
      return {
        ok: false,
        message:
          "Session expired, redirected to IAAA login. Run pku_login again. / 会话已过期，被重定向到 IAAA 登录。请重新运行 pku_login。",
      };
    }

    const nav = await gotoRecordingsList(page, courseName, Date.now() + 120000);
    if (!nav.ok) {
      const diagnostics = await dumpPage(page).catch(() => []);
      await browser.close().catch(() => {});
      return {
        ok: false,
        engine,
        results: [],
        skipped: wanted.map((i) => ({
          index: i,
          reason: "lesson list not found / 未找到课次列表",
        })),
        diagnostics,
        message:
          "Lesson list not found, cannot locate lessons. / 未找到课次列表，无法定位课次。" +
          (courseName ? "" : " No course name set. / （未设置课程名）") +
          " Pass a direct recordings-list `url` and retry. / 可传 url 直达「课堂实录」列表页后重试。",
      };
    }
    const listUrl = nav.listUrl;
    const total = (await enumerateLessons(page).catch(() => [])).length;

    // Return the list page to a fresh, enumerable state for the next lesson:
    // close any player tab the click opened, re-open the list URL, and if that
    // didn't restore an SPA list, re-drive the menu navigation from home.
    const restoreList = async () => {
      for (const p of context.pages()) {
        if (p !== page) await p.close().catch(() => {});
      }
      await page.goto(listUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(1200);
      let n = (await enumerateLessons(page).catch(() => [])).length;
      if (n === 0) {
        await page
          .goto(url || COURSE_HOME, { waitUntil: "domcontentloaded" })
          .catch(() => {});
        await sleep(1000);
        await gotoRecordingsList(page, courseName, Date.now() + 60000).catch(
          () => {}
        );
      }
    };

    const results = [];
    const skipped = [];
    for (const idx of wanted) {
      if (total > 0 && idx > total) {
        skipped.push({
          index: idx,
          reason: `out of range, ${total} total / 超出范围（共 ${total} 节）`,
        });
        continue;
      }
      const seen = new Set(captured.keys());
      const title = await clickLessonByIndex(page, idx).catch(() => null);
      if (title === null) {
        skipped.push({
          index: idx,
          reason: "could not locate lesson link / 未能定位该课次链接",
        });
        await restoreList();
        continue;
      }

      // Wait for THIS lesson's new m3u8, nudging playback each tick.
      const perDeadline = Date.now() + timeoutMs;
      let pick = null;
      while (Date.now() < perDeadline) {
        await pumpPlayVideos(page).catch(() => {});
        pick = pickNewPlaylist(captured, seen);
        if (pick) {
          await sleep(1500); // brief grace for variant playlists to also appear
          pick = pickNewPlaylist(captured, seen);
          break;
        }
        await sleep(1200);
      }

      if (!pick) {
        skipped.push({
          index: idx,
          reason: "timed out waiting for m3u8 / 超时未捕获到 m3u8",
        });
        await restoreList();
        continue;
      }

      const job = startDownload({
        m3u8: pick.url,
        name: `${prefix}-${String(idx).padStart(2, "0")}`,
        referer: pick.referer || undefined,
        outDir,
        format,
      });
      results.push({
        index: idx,
        title: typeof title === "string" ? title : null,
        m3u8: pick.url,
        jobId: job.id,
        name: job.name,
      });

      await restoreList();
    }

    await context.storageState({ path: STATE_FILE }).catch(() => {});
    return {
      ok: results.length > 0,
      engine,
      results,
      skipped,
      message:
        `Started background downloads for ${results.length} lesson(s) / 已对 ${results.length} 节课起后台下载任务` +
        (skipped.length
          ? `, skipped ${skipped.length} (see skipped) / ，跳过 ${skipped.length} 节（见 skipped）`
          : "") +
        ". Track progress with pku_download_status. / 。用 pku_download_status 查询进度。",
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
