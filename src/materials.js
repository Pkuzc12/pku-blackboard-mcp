import fs from "node:fs";
import path from "node:path";

import { COURSE_NAME, DOWNLOAD_DIR, ensureDirs } from "./config.js";
import { checkSessionValid, hasSession } from "./session.js";
import { httpGet, listCourseTabsHttp, isExtractableType } from "./portal.js";
import { startFileDownload } from "./jobs.js";

const MAX_TEXT_CHARS = 1500;
const MAX_DEPTH = 6;

function decodeEntities(s) {
  return (s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripTags(html) {
  return decodeEntities(
    (html || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseAttrs(raw) {
  const attrs = {};
  for (const m of (raw || "").matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function anchors(html, baseUrl) {
  const out = [];
  for (const m of (html || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = parseAttrs(m[1]);
    const href = attrs.href || "";
    if (!href || href.startsWith("#") || /^javascript:/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    out.push({
      href,
      url,
      text: stripTags(m[2]),
      title: attrs.title || "",
      attrs,
    });
  }
  return out;
}

function basenameFromUrl(url) {
  try {
    const name = path.basename(decodeURIComponent(new URL(url).pathname));
    return name && name !== "/" ? name : "";
  } catch {
    return "";
  }
}

function cleanTitle(s, fallback = "untitled") {
  return (s || fallback).replace(/\s+/g, " ").trim().slice(0, 180) || fallback;
}

function cleanBody(s) {
  return (s || "").replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function textItem({ title, body, url, type, section }) {
  const bodyText = cleanBody(body);
  if (!bodyText || bodyText.length < 2) return null;
  return {
    title: cleanTitle(title || section || type || "Text"),
    type,
    section,
    url,
    text: bodyText.length > MAX_TEXT_CHARS ? bodyText.slice(0, MAX_TEXT_CHARS) + "..." : bodyText,
  };
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.url || `${item.section}:${item.title}:${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractFiles(html, pageUrl, section) {
  return dedupeByUrl(
    anchors(html, pageUrl)
      .filter((a) => /\/bbcswebdav\//i.test(a.url))
      .map((a) => ({
        title: cleanTitle(a.text || a.title || basenameFromUrl(a.url), "attachment"),
        url: a.url,
        section,
        sourceUrl: pageUrl,
      }))
  );
}

function extractContentTexts(html, pageUrl, section) {
  const texts = [];
  for (const m of html.matchAll(/<li\b[^>]*class="[^"]*listElement[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
    const itemHtml = m[1];
    const h = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(itemHtml);
    const title = h ? stripTags(h[1]) : section;
    const body = stripTags(itemHtml.replace(/<a\b[\s\S]*?<\/a>/gi, " "));
    const item = textItem({ title, body, url: pageUrl, type: "content", section });
    if (item) texts.push(item);
  }
  return texts;
}

function extractAnnouncementTexts(html, pageUrl, section) {
  const texts = [];
  const h3s = [...html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)];
  for (let i = 0; i < h3s.length; i++) {
    const start = h3s[i].index + h3s[i][0].length;
    const end = i + 1 < h3s.length ? h3s[i + 1].index : html.length;
    const chunk = html.slice(start, end);
    const details = /<div\b[^>]*class="[^"]*details[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(chunk);
    const body = stripTags(details ? details[1] : chunk);
    const item = textItem({
      title: stripTags(h3s[i][1]),
      body,
      url: pageUrl,
      type: "announcement",
      section,
    });
    if (item) texts.push(item);
  }
  if (texts.length) return texts;
  const body = stripTags(html);
  const item = textItem({ title: section, body, url: pageUrl, type: "announcement", section });
  return item ? [item] : [];
}

function elementTextById(html, id) {
  const startRe = new RegExp(`<([a-z0-9]+)\\b[^>]*id=["']${id}["'][^>]*>`, "i");
  const start = startRe.exec(html);
  if (!start) return "";
  const tag = start[1].toLowerCase();
  const tagRe = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  tagRe.lastIndex = start.index;
  let depth = 0;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[0][1] === "/") depth -= 1;
    else depth += 1;
    if (depth === 0) return stripTags(html.slice(start.index, tagRe.lastIndex));
  }
  return stripTags(html.slice(start.index));
}

function extractScopedText(html, pageUrl, section, type) {
  const id =
    type === "grades"
      ? "grades_wrapper"
      : type === "staff"
        ? "containerdiv"
        : "";
  if (id) {
    const body = elementTextById(html, id);
    if (body) {
      const item = textItem({ title: section, body, url: pageUrl, type, section });
      if (item) return [item];
    }
  }
  const main =
    /<div\b[^>]*id="contentPanel"[^>]*>([\s\S]*?)<\/div>/i.exec(html) ||
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html) ||
    /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const item = textItem({ title: section, body: stripTags(main ? main[1] : html), url: pageUrl, type, section });
  return item ? [item] : [];
}

function folderLinks(html, pageUrl) {
  return anchors(html, pageUrl).filter(
    (a) => /listContent(Editable)?\.jsp/i.test(a.url) && !/\/bbcswebdav\//i.test(a.url)
  );
}

function nextPageLinks(html, pageUrl) {
  return anchors(html, pageUrl).filter((a) => {
    const label = `${a.title} ${a.text}`.toLowerCase();
    return /next|\u4e0b\u4e00/.test(label) && !/\/bbcswebdav\//i.test(a.url);
  });
}

export function parseMaterialPage({ html, pageUrl, section, type }) {
  const files = extractFiles(html, pageUrl, section);
  const texts =
    type === "content"
      ? extractContentTexts(html, pageUrl, section)
      : type === "announcements"
        ? extractAnnouncementTexts(html, pageUrl, section)
        : extractScopedText(html, pageUrl, section, type || "tool");
  const childLinks = type === "content" ? dedupeByUrl([...folderLinks(html, pageUrl), ...nextPageLinks(html, pageUrl)]) : [];
  return { files, texts, childLinks };
}

async function fetchPage(url) {
  const page = await httpGet(url).catch((e) => ({ error: e }));
  if (page.error) return { ok: false, reason: "http-error", detail: String(page.error.message || page.error) };
  if (page.loginRedirect) return { ok: false, reason: "expired" };
  if (page.status < 200 || page.status >= 300) return { ok: false, reason: `http-${page.status}` };
  return { ok: true, url: page.url, html: page.body };
}

async function extractContentPage({ url, section, visited, depth }) {
  if (visited.has(url) || depth > MAX_DEPTH) return { files: [], texts: [] };
  visited.add(url);

  const page = await fetchPage(url);
  if (!page.ok) return { files: [], texts: [], errors: [{ url, reason: page.reason, detail: page.detail }] };

  const parsed = parseMaterialPage({ html: page.html, pageUrl: page.url, section, type: "content" });
  let files = parsed.files;
  let texts = parsed.texts;
  let errors = [];

  for (const link of parsed.childLinks) {
    if (visited.has(link.url)) continue;
    const child = await extractContentPage({
      url: link.url,
      section: link.text ? `${section} / ${cleanTitle(link.text)}` : section,
      visited,
      depth: depth + 1,
    });
    files = files.concat(child.files || []);
    texts = texts.concat(child.texts || []);
    errors = errors.concat(child.errors || []);
  }

  return { files: dedupeByUrl(files), texts, errors };
}

async function extractTab(tab) {
  const url = tab.resolvedHref || tab.href;
  const section = tab.name;
  if (/\/bbcswebdav\//i.test(url)) {
    return {
      ...tab,
      files: [{ title: cleanTitle(section || basenameFromUrl(url), "attachment"), url, section, sourceUrl: url }],
      texts: [],
    };
  }
  if (!isExtractableType(tab.type)) {
    return { ...tab, files: [], texts: [], skipped: true };
  }
  if (tab.type === "content") {
    const r = await extractContentPage({ url, section, visited: new Set(), depth: 0 });
    return { ...tab, files: r.files || [], texts: r.texts || [], errors: r.errors || [] };
  }

  const page = await fetchPage(url);
  if (!page.ok) return { ...tab, files: [], texts: [], errors: [{ url, reason: page.reason, detail: page.detail }] };

  const parsed = parseMaterialPage({ html: page.html, pageUrl: page.url, section, type: tab.type || "tool" });
  return { ...tab, files: parsed.files, texts: parsed.texts };
}

function tabMatches(tab, { tabNames, types }) {
  if (types && types.length && !types.includes(tab.type)) return false;
  if (!tabNames || !tabNames.length) return true;
  const name = (tab.name || "").toLowerCase();
  return tabNames.some((n) => name.includes(String(n).toLowerCase()));
}

export async function listMaterials({ course, courseKey, tabNames, types } = {}) {
  ensureDirs();
  if (!hasSession()) return { ok: false, message: "Not logged in. Run pku_login first." };
  const session = await checkSessionValid();
  if (session.valid === false) {
    return {
      ok: false,
      reason: session.reason || "expired",
      message:
        session.reason === "no-session"
          ? "Not logged in. Run pku_login first."
          : "Session expired. Run pku_login again.",
    };
  }

  const tabsResult = await listCourseTabsHttp({ course: (course || COURSE_NAME || "").trim(), courseKey }).catch((e) => ({
    ok: false,
    reason: "http-error",
    detail: String(e && e.message ? e.message : e),
  }));
  if (!tabsResult.ok) {
    if (tabsResult.reason === "expired") {
      return { ok: false, reason: "expired", message: "Session expired. Run pku_login again." };
    }
    return { ok: false, reason: tabsResult.reason, detail: tabsResult.detail, courses: tabsResult.courses };
  }

  const selected = tabsResult.tabs.filter((t) => tabMatches(t, { tabNames, types }));
  const sections = [];
  for (const tab of selected) sections.push(await extractTab(tab));

  const files = dedupeByUrl(sections.flatMap((s) => s.files || []));
  const texts = sections.flatMap((s) => s.texts || []);
  return {
    ok: true,
    via: "http",
    course: tabsResult.course,
    courseKey: tabsResult.courseKey,
    menuUrl: tabsResult.menuUrl,
    tabCount: tabsResult.tabs.length,
    selectedTabCount: selected.length,
    fileCount: files.length,
    textCount: texts.length,
    files,
    texts,
    sections,
    message: `Found ${files.length} file(s) and ${texts.length} text item(s).`,
  };
}

function safeMdName(s) {
  return cleanTitle(s || "materials")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 100);
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}${ext}`);
  let i = 2;
  while (fs.existsSync(p)) {
    p = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
  return p;
}

function writeTextsMarkdown({ texts, outDir, course }) {
  if (!texts.length) return null;
  const dir = outDir ? path.resolve(outDir) : DOWNLOAD_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = uniquePath(dir, safeMdName(`${course || "course"} materials`), ".md");
  const body = texts
    .map((t) => {
      const title = t.section && t.section !== t.title ? `${t.section} - ${t.title}` : t.title;
      return `## ${title}\n\nSource: ${t.url || ""}\n\n${t.text}\n`;
    })
    .join("\n");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

export async function downloadMaterials({
  course,
  courseKey,
  tabNames,
  types,
  fileUrls,
  downloadFiles = true,
  saveText = "none",
  outDir,
} = {}) {
  const listed = await listMaterials({ course, courseKey, tabNames, types });
  if (!listed.ok) return listed;

  const wantedUrls = fileUrls && fileUrls.length ? new Set(fileUrls) : null;
  const files = wantedUrls ? listed.files.filter((f) => wantedUrls.has(f.url)) : listed.files;
  const jobs = downloadFiles
    ? files.map((file) => {
        const job = startFileDownload({ url: file.url, name: file.title, referer: file.sourceUrl, outDir });
        return { title: file.title, url: file.url, jobId: job.id, status: job.status };
      })
    : [];
  const textFile = saveText === "md" ? writeTextsMarkdown({ texts: listed.texts, outDir, course: listed.course }) : null;

  return {
    ok: true,
    via: "http",
    course: listed.course,
    courseKey: listed.courseKey,
    fileCount: files.length,
    textCount: listed.texts.length,
    jobs,
    textFile,
    message: `Started ${jobs.length} file download job(s)${textFile ? ` and saved text to ${textFile}` : ""}.`,
  };
}
