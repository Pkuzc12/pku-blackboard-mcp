// Browser-free Blackboard portal fetching.
//
// Once the user has logged in once (pku_login saves cookies), we don't need a
// browser to *list* things: we replay the saved cookies with node:https and
// parse the server-rendered HTML. This covers the whole "find the lessons"
// chain — course list -> course menu -> recordings list — without opening a
// window. (Resolving a lesson's actual video stream still needs a browser,
// because the onlineroomse player performs its SSO + stream lookup in client
// JS that can't be replayed over plain HTTP.)
//
// Like checkSessionValid() in session.js we use node:https with
// rejectUnauthorized:false: course.pku.edu.cn serves an incomplete certificate
// chain that browsers repair via AIA fetching but Node's fetch hard-fails on.
// We only ever send our own session cookies to the legitimate PKU hosts.

import https from "node:https";
import { COURSE_HOME } from "./config.js";
import { cookieHeaderFor } from "./session.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Hosts that mean "your session expired, you got bounced to login".
const LOGIN_HOSTS = ["iaaa.pku.edu.cn", "wproxy.pku.edu.cn"];

function isLoginUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return LOGIN_HOSTS.some((x) => h === x || h.endsWith("." + x));
  } catch {
    return false;
  }
}

// GET `url`, replaying saved cookies, following up to `followRedirects` hops.
// Resolves { status, headers, body, url (final), loginRedirect }. Never rejects
// for HTTP status; only for network/timeout errors.
export function httpGet(url, { followRedirects = 5, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const cookie = cookieHeaderFor(url);
    const req = https.request(
      url,
      {
        method: "GET",
        rejectUnauthorized: false,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && followRedirects > 0) {
          const next = new URL(location, url).href;
          res.resume();
          if (isLoginUrl(next)) {
            return resolve({ status, headers: res.headers, body: "", url: next, loginRedirect: true });
          }
          return resolve(httpGet(next, { followRedirects: followRedirects - 1, timeoutMs }));
        }
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () =>
          resolve({
            status,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            url,
            loginRedirect: isLoginUrl(url),
          })
        );
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

// GET `url` and return the raw response body as a Buffer (for binary downloads
// like bbcswebdav attachments), replaying cookies and following redirects. Like
// httpGet we use node:https with rejectUnauthorized:false (course.pku.edu.cn's
// incomplete cert chain makes global fetch hard-fail). Resolves
// { status, headers, buffer, url, loginRedirect }; rejects only on network error.
export function httpGetBuffer(url, { followRedirects = 5, timeoutMs = 60000, referer } = {}) {
  return new Promise((resolve, reject) => {
    const cookie = cookieHeaderFor(url);
    const req = https.request(
      url,
      {
        method: "GET",
        rejectUnauthorized: false,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(referer ? { Referer: referer } : {}),
          "User-Agent": UA,
          Accept: "*/*",
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && followRedirects > 0) {
          const next = new URL(location, url).href;
          res.resume();
          if (isLoginUrl(next)) {
            return resolve({ status, headers: res.headers, buffer: Buffer.alloc(0), url: next, loginRedirect: true });
          }
          return resolve(httpGetBuffer(next, { followRedirects: followRedirects - 1, timeoutMs, referer }));
        }
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () =>
          resolve({
            status,
            headers: res.headers,
            buffer: Buffer.concat(chunks),
            url,
            loginRedirect: isLoginUrl(url),
          })
        );
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

// Decode a JWT payload without verifying the signature (we only read claims).
export function decodeJwt(token) {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

const stripTags = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// Recordings-section menu labels (mirrors RECORDINGS_TEXTS in capture.js).
const RECORDINGS_TEXTS = ["课堂实录", "课程回放", "课堂录像", "录播", "视频回放", "教学视频"];

// "are all chars of q present in t in order?" — subsequence match, same rule as
// the browser-side fuzzy course matcher so HTTP and browser paths agree.
function isSubseq(q, t) {
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++;
  return i === q.length;
}

// Parse the course list tab (tab_tab_group_id=_1_1) into { key, title }[].
// Course anchors look like:
//   href="/webapps/blackboard/execute/launcher?type=Course&id=PkId{key=_98597_1, ...}"
//   text="25262-...-00-2: 实验原子物理学进展(25-26学年第2学期)"
export function parseCourseList(html) {
  const courses = [];
  const seen = new Set();
  const re =
    /<a[^>]*href="([^"]*PkId\{key=(_\d+_\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const key = m[2];
    if (seen.has(key)) continue;
    seen.add(key);
    const raw = stripTags(m[3]);
    // Titles are often "<course code>: <name>"; keep the readable name for
    // display but match against the whole string so codes still resolve.
    const name = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1).trim() : raw;
    courses.push({ key, title: name || raw, full: raw });
  }
  return courses;
}

// Fuzzy-pick a course by name: exact substring first, else subsequence, choosing
// the shortest matching title (tightest match), mirroring capture.js clickFirst.
export function findCourse(courses, name) {
  const norm = (s) => (s || "").replace(/\s+/g, "");
  const q = norm(name);
  if (!q) return null;
  // Pass 1: substring on the readable name or the full code:name string.
  let hit = courses.find((c) => norm(c.title).includes(q) || norm(c.full).includes(q));
  if (hit) return hit;
  // Pass 2: subsequence, shortest title wins.
  let best = null;
  let bestLen = Infinity;
  for (const c of courses) {
    const t = norm(c.full);
    if (t.length >= bestLen) continue;
    if (isSubseq(q, t)) {
      best = c;
      bestLen = t.length;
    }
  }
  return best;
}

// From a course menu page, return the href of the recordings ("课堂实录") link.
export function parseRecordingsLink(html) {
  const anchors = [
    ...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g),
  ].map((m) => ({ href: m[1], text: stripTags(m[2]) }));
  const hit = anchors.find((a) => RECORDINGS_TEXTS.some((t) => a.text.includes(t)));
  return hit ? hit.href : null;
}

// Parse a videoList.action (课堂实录) page into lessons. Each lesson row is:
//   <th>2026-06-10第7-9节</th> ... <a href="playVideo.action?token=<JWT>">观看</a>
// We read the <th> as the title and decode the JWT for the record time + ids.
export function parseLessons(html, pageUrl) {
  const lessons = [];
  const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/g)].filter((r) =>
    r[0].includes("playVideo.action")
  );
  for (const r of rows) {
    const row = r[0];
    const tok = /playVideo\.action\?token=([A-Za-z0-9_\-.]+)/.exec(row);
    if (!tok) continue;
    const token = tok[1];
    const th = /<th[^>]*>([\s\S]*?)<\/th>/.exec(row);
    const payload = decodeJwt(token) || {};
    // Teacher sits in the value <span> after the "教师:" label <span>:
    //   <span ...>教师: </span> <span ...>姚和朋</span>
    const teacher =
      (/教师[:：][\s\S]*?<span[^>]*>([^<]+)<\/span>/.exec(row) || [])[1] || "";
    const title =
      (th && stripTags(th[1])) ||
      (payload.recordTime ? `录制 ${payload.recordTime}` : `第${lessons.length + 1}讲`);
    lessons.push({
      index: lessons.length + 1,
      title,
      teacher: teacher.trim() || undefined,
      recordTime: payload.recordTime || undefined,
      playUrl: new URL(`playVideo.action?token=${token}`, pageUrl).href,
    });
  }
  return lessons;
}

// List the user's courses, browser-free (replay cookies, parse the course tab).
// Returns { ok:true, count, courses:[{ key, title, full }] } or
//          { ok:false, reason: "no-session"|"expired"|"no-courses"|"http-error" }.
export async function listCoursesHttp() {
  const listPage = await httpGet(
    new URL("/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1", COURSE_HOME).href
  ).catch((e) => ({ error: e }));
  if (listPage.error)
    return { ok: false, reason: "http-error", detail: String(listPage.error.message || listPage.error) };
  if (listPage.loginRedirect) return { ok: false, reason: "expired" };
  const courses = parseCourseList(listPage.body);
  if (!courses.length) return { ok: false, reason: "no-courses" };
  return { ok: true, count: courses.length, courses };
}

// Resolve the recordings-list page for a course, then parse its lessons.
// Accepts either a direct `url` (a videoList/streammedia page, or a course
// launchLink) or a fuzzy `course` name to look up from the course list.
// Returns one of:
//   { ok: true, listUrl, count, lessons }
//   { ok: false, reason: "no-session" | "expired" | "no-course" | "no-recordings" | "no-lessons" | "http-error", ... }
export async function listLessonsHttp({ course, url } = {}) {
  // Direct URL: fetch and parse straight away.
  if (url) {
    const page = await httpGet(url).catch((e) => ({ error: e }));
    if (page.error) return { ok: false, reason: "http-error", detail: String(page.error.message || page.error) };
    if (page.loginRedirect) return { ok: false, reason: "expired" };
    const lessons = parseLessons(page.body, page.url);
    if (lessons.length) return { ok: true, listUrl: page.url, count: lessons.length, lessons };
    return { ok: false, reason: "no-lessons", listUrl: page.url };
  }

  const courseName = (course || "").trim();
  if (!courseName) return { ok: false, reason: "no-course-name" };

  // 1) course list
  const listPage = await httpGet(
    new URL("/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1", COURSE_HOME).href
  ).catch((e) => ({ error: e }));
  if (listPage.error) return { ok: false, reason: "http-error", detail: String(listPage.error.message || listPage.error) };
  if (listPage.loginRedirect) return { ok: false, reason: "expired" };
  const courses = parseCourseList(listPage.body);
  if (!courses.length) return { ok: false, reason: "no-courses" };
  const hit = findCourse(courses, courseName);
  if (!hit)
    return {
      ok: false,
      reason: "no-course",
      courses: courses.map((c) => c.title).slice(0, 40),
    };

  // 2) course menu -> recordings link
  const menu = await httpGet(
    new URL(`/webapps/blackboard/execute/courseMain?course_id=${hit.key}`, COURSE_HOME).href
  ).catch((e) => ({ error: e }));
  if (menu.error) return { ok: false, reason: "http-error", detail: String(menu.error.message || menu.error) };
  if (menu.loginRedirect) return { ok: false, reason: "expired" };
  const recHref = parseRecordingsLink(menu.body);
  if (!recHref)
    return { ok: false, reason: "no-recordings", course: hit.title, courseKey: hit.key };

  // 3) recordings page -> lessons
  const recUrl = new URL(recHref, COURSE_HOME).href;
  const page = await httpGet(recUrl).catch((e) => ({ error: e }));
  if (page.error) return { ok: false, reason: "http-error", detail: String(page.error.message || page.error) };
  if (page.loginRedirect) return { ok: false, reason: "expired" };
  const lessons = parseLessons(page.body, page.url);
  if (!lessons.length)
    return { ok: false, reason: "no-lessons", course: hit.title, listUrl: page.url };

  return { ok: true, course: hit.title, courseKey: hit.key, listUrl: page.url, count: lessons.length, lessons };
}

// ---------------------------------------------------------------------------
// Course materials: menu tabs -> per-tab { files, texts }
//
// The course left menu (ul#courseMenuPalette_contents) lists every section as
// an <a>. We classify each by its href into a `type` that decides HOW to parse
// the section, but every type produces the same uniform shape: a section yields
// downloadable `files` (bbcswebdav attachments) and/or `texts` (announcement
// bodies, assignment descriptions, grade rows, …) surfaced as metadata.
// ---------------------------------------------------------------------------

// Classify a menu tab by its href (relative menu href OR a resolved absolute
// URL). `content` tabs hold file attachments; announcement/grades/discussion/
// staff/mail are text-bearing tool pages. A genuinely external host is a
// `link` (we don't fetch it); an unrecognized same-site tool is `tool`, which
// gets a lenient best-effort parse. bbcswebdav is a direct file link.
export function classifyTab(href) {
  const raw = href || "";
  const h = raw.toLowerCase();

  // External host (e.g. help.blackboard.com) — just a link, don't fetch.
  if (/^https?:\/\//.test(h)) {
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (host !== "course.pku.edu.cn" && !host.endsWith(".pku.edu.cn")) return "link";
    } catch {
      return "link";
    }
  }

  if (/\/bbcswebdav\//.test(h)) return "link"; // a direct file leaf, not a section
  if (/listcontent(editable)?\.jsp/.test(h)) return "content";
  if (/announcement/.test(h)) return "announcements";
  if (/mygrades|gradebook|viewgrades/.test(h)) return "grades";
  if (/discussionboard/.test(h)) return "discussion";
  if (/staffinfo|contacts|teachingbook|getteachingstaf/.test(h)) return "staff";
  if (/viewmessages|messages/.test(h)) return "mail";
  // launchLink.jsp before redirect resolution, or any other same-site tool.
  return "tool";
}

// Is a tab type one we know how to extract something useful from? (Drives the
// `downloadable` flag in pku_list_materials.) Only true external links are out.
export function isExtractableType(type) {
  return type !== "link";
}

// Parse the course menu (ul#courseMenuPalette_contents) into typed tabs:
//   { name, href (absolute), type }[]
// Mirrors PKU-Get's _parse_tabs_from_soup, plus per-tab classification.
export function parseCourseMenu(html, baseUrl) {
  const m = /<ul[^>]*id="courseMenuPalette_contents"[\s\S]*?<\/ul>/i.exec(html);
  if (!m) return [];
  const tabs = [];
  const seen = new Set();
  for (const a of m[0].matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const rawHref = a[1];
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) continue;
    const name = stripTags(a[2]);
    if (!name) continue;
    const href = new URL(rawHref, baseUrl).href;
    if (seen.has(href)) continue;
    seen.add(href);
    tabs.push({ name, href, type: classifyTab(rawHref) });
  }
  return tabs;
}

// Resolve a course (by fuzzy `course` name or direct `courseKey`) to its menu
// page, returning { ok, course, courseKey, menuUrl, tabs } or { ok:false, reason }.
export async function listCourseTabsHttp({ course, courseKey } = {}) {
  let key = courseKey;
  let title = course;

  if (!key) {
    const name = (course || "").trim();
    if (!name) return { ok: false, reason: "no-course-name" };
    const listPage = await httpGet(
      new URL("/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1", COURSE_HOME).href
    ).catch((e) => ({ error: e }));
    if (listPage.error) return { ok: false, reason: "http-error", detail: String(listPage.error.message || listPage.error) };
    if (listPage.loginRedirect) return { ok: false, reason: "expired" };
    const courses = parseCourseList(listPage.body);
    if (!courses.length) return { ok: false, reason: "no-courses" };
    const hit = findCourse(courses, name);
    if (!hit) return { ok: false, reason: "no-course", courses: courses.map((c) => c.title).slice(0, 40) };
    key = hit.key;
    title = hit.title;
  }

  const menuUrl = new URL(`/webapps/blackboard/execute/courseMain?course_id=${key}`, COURSE_HOME).href;
  const menu = await httpGet(menuUrl).catch((e) => ({ error: e }));
  if (menu.error) return { ok: false, reason: "http-error", detail: String(menu.error.message || menu.error) };
  if (menu.loginRedirect) return { ok: false, reason: "expired" };
  const tabs = parseCourseMenu(menu.body, menu.url);
  if (!tabs.length) return { ok: false, reason: "no-menu", course: title, courseKey: key };

  // launchLink.jsp tabs hide their real target behind a 302 — the menu href
  // alone can't tell announcements from grades from a generic tool. Resolve
  // each tool tab's redirect (cheap: followRedirects:0, empty body) and
  // reclassify by the landing URL, recording it as `resolvedHref` so the
  // per-type extractors fetch the real page, not the launcher.
  for (const t of tabs) {
    if (t.type !== "tool") continue;
    const probe = await httpGet(t.href, { followRedirects: 0 }).catch(() => null);
    const loc = probe && probe.headers && probe.headers.location;
    if (loc) {
      t.resolvedHref = new URL(loc, t.href).href;
      // The landing URL is authoritative — reclassify from it.
      t.type = classifyTab(t.resolvedHref);
    }
  }

  return { ok: true, course: title, courseKey: key, menuUrl: menu.url, tabs };
}
