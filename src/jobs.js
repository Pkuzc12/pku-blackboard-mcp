// Background download jobs. A lecture replay can be 1–2 GB and take many
// minutes, longer than a typical MCP tool call should block. So pku_download
// starts a job and returns immediately; pku_download_status polls it.

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { downloadHls } from "./hls.js";
import { remuxToMp4 } from "./ffmpeg.js";
import { DOWNLOAD_DIR, DOWNLOAD_CONCURRENCY, ensureDirs } from "./config.js";
import { httpGetBuffer } from "./portal.js";
import { cookieHeaderFor } from "./session.js";

const jobs = new Map();
let counter = 0;

// Optional sink for live progress lines (wired to MCP logging notifications in
// index.js). No-op until set, so jobs.js stays usable standalone.
let progressNotifier = null;
export function setProgressNotifier(fn) {
  progressNotifier = typeof fn === "function" ? fn : null;
}
function notify(msg) {
  if (progressNotifier) {
    try {
      progressNotifier(msg);
    } catch {}
  }
}

function bar(pct, width = 22) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmtDuration(sec) {
  if (!isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtMB(bytes) {
  return +(bytes / 1048576).toFixed(1);
}

function sanitize(name) {
  return (name || "replay")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  let i = 2;
  while (fs.existsSync(p)) {
    p = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
  return p;
}

function headerValue(v) {
  return Array.isArray(v) ? v[0] : v || "";
}

function decodeRfc5987(v) {
  const m = /^([^']*)'[^']*'(.*)$/.exec(v || "");
  try {
    return decodeURIComponent(m ? m[2] : v);
  } catch {
    return m ? m[2] : v;
  }
}

function filenameFromDisposition(disposition) {
  const cd = headerValue(disposition);
  if (!cd) return "";
  const star = /filename\*=([^;]+)/i.exec(cd);
  if (star) return decodeRfc5987(star[1].trim().replace(/^"|"$/g, ""));
  const plain = /filename=([^;]+)/i.exec(cd);
  if (!plain) return "";
  const raw = plain[1].trim().replace(/^"|"$/g, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function filenameFromUrl(url) {
  try {
    const name = path.basename(decodeURIComponent(new URL(url).pathname));
    return name && name !== "/" ? name : "";
  } catch {
    return "";
  }
}

function extFromContentType(contentType) {
  const ct = headerValue(contentType).split(";")[0].trim().toLowerCase();
  return (
    {
      "application/pdf": ".pdf",
      "application/zip": ".zip",
      "application/x-zip-compressed": ".zip",
      "application/msword": ".doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
      "application/vnd.ms-powerpoint": ".ppt",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
      "application/vnd.ms-excel": ".xls",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
      "text/plain": ".txt",
      "text/csv": ".csv",
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "video/mp4": ".mp4",
    }[ct] || ""
  );
}

function extFromMagic(buffer) {
  if (!buffer || buffer.length < 4) return "";
  if (buffer.subarray(0, 4).toString("latin1") === "%PDF") return ".pdf";
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) return ".zip";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString("latin1") === "PNG") return ".png";
  if (buffer.subarray(0, 3).toString("latin1") === "GIF") return ".gif";
  return "";
}

function chooseFileName({ url, name, headers, buffer }) {
  const preferred =
    filenameFromDisposition(headers && headers["content-disposition"]) ||
    filenameFromUrl(url) ||
    name ||
    "material";
  const parsed = path.parse(sanitize(preferred));
  const magicExt = extFromMagic(buffer);
  const typeExt = extFromContentType(headers && headers["content-type"]);
  let ext = parsed.ext || magicExt || typeExt || ".bin";
  if (magicExt && parsed.ext && parsed.ext.toLowerCase() !== magicExt && parsed.ext.toLowerCase() === ".bin") {
    ext = magicExt;
  }
  return { base: parsed.name || "material", ext };
}

function requestModule(url) {
  return new URL(url).protocol === "http:" ? http : https;
}

function streamToFile(url, outPath, { referer, timeoutMs = 120000, onProgress, followRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const cookie = cookieHeaderFor(url);
    const req = requestModule(url).request(
      url,
      {
        method: "GET",
        rejectUnauthorized: false,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(referer ? { Referer: referer } : {}),
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
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
          return resolve(streamToFile(next, outPath, { referer, timeoutMs, onProgress, followRedirects: followRedirects - 1 }));
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new Error(`http-${status}`));
        }
        const total = Number(res.headers["content-length"] || 0) || 0;
        let bytes = 0;
        const out = fs.createWriteStream(outPath);
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (onProgress) onProgress({ bytes, total });
        });
        res.on("error", (err) => {
          out.destroy();
          reject(err);
        });
        out.on("error", reject);
        out.on("finish", () => resolve({ bytes, total, headers: res.headers, url }));
        res.pipe(out);
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

export function startDownload({ m3u8, name, referer, outDir, format = "mp4" }) {
  ensureDirs();
  const dir = outDir ? path.resolve(outDir) : DOWNLOAD_DIR;
  fs.mkdirSync(dir, { recursive: true });

  const id = `job-${++counter}`;
  const base = sanitize(name);
  const tsPath = path.join(dir, base + ".ts");

  const job = {
    id,
    status: "running", // running | done | error
    phase: "downloading", // downloading | remuxing | done
    m3u8,
    name: base,
    dir,
    format,
    total: 0,
    done: 0,
    bytes: 0,
    outFile: null,
    error: null,
    startMs: Date.now(),
    finishMs: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastNotifyMs: 0,
  };
  jobs.set(id, job);

  (async () => {
    try {
      await downloadHls({
        m3u8Url: m3u8,
        referer,
        outTsPath: tsPath,
        concurrency: DOWNLOAD_CONCURRENCY,
        onProgress: ({ done, total, bytes }) => {
          job.done = done;
          job.total = total;
          job.bytes = bytes;
          const now = Date.now();
          if (now - job.lastNotifyMs >= 1500 || done === total) {
            job.lastNotifyMs = now;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            notify(
              `[${id}] ${base} ↓ ${pct}% (${done}/${total} segs, ${fmtMB(bytes)}MB)`
            );
          }
        },
      });

      if (format === "mp4") {
        job.phase = "remuxing";
        notify(`[${id}] ${base} segments done, remuxing to mp4 / 封装 mp4 中…`);
        const mp4Path = uniquePath(dir, base, ".mp4");
        await remuxToMp4(tsPath, mp4Path);
        fs.rmSync(tsPath, { force: true });
        job.outFile = mp4Path;
      } else {
        job.outFile = tsPath;
      }
      job.phase = "done";
      job.status = "done";
      job.finishMs = Date.now();
      job.finishedAt = new Date().toISOString();
      notify(`[${id}] ${base} done / 完成 → ${job.outFile}`);
    } catch (err) {
      job.status = "error";
      job.error = String(err && err.message ? err.message : err);
      job.finishMs = Date.now();
      job.finishedAt = new Date().toISOString();
      notify(`[${id}] ${base} error / 失败: ${job.error}`);
    }
  })();

  return job;
}

export function startDirectDownload({ url, name, referer, outDir }) {
  ensureDirs();
  const dir = outDir ? path.resolve(outDir) : DOWNLOAD_DIR;
  fs.mkdirSync(dir, { recursive: true });

  const id = `job-${++counter}`;
  const base = sanitize(name || "media");
  const parsedExt = path.extname(filenameFromUrl(url)).toLowerCase();
  const ext = parsedExt || ".mp4";
  const finalPath = uniquePath(dir, base, ext);
  const partPath = finalPath + ".part";

  const job = {
    id,
    type: "direct",
    status: "running",
    phase: "downloading",
    url,
    name: base,
    dir,
    total: 0,
    done: 0,
    bytes: 0,
    outFile: null,
    error: null,
    startMs: Date.now(),
    finishMs: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastNotifyMs: 0,
  };
  jobs.set(id, job);

  (async () => {
    try {
      await streamToFile(url, partPath, {
        referer,
        timeoutMs: 120000,
        onProgress: ({ bytes, total }) => {
          job.bytes = bytes;
          job.total = total || 0;
          job.done = total ? bytes : 0;
          const now = Date.now();
          if (now - job.lastNotifyMs >= 1500) {
            job.lastNotifyMs = now;
            const pct = total ? Math.round((bytes / total) * 100) : 0;
            notify(`[${id}] ${base} -> ${pct}% (${fmtMB(bytes)}MB)`);
          }
        },
      });
      await fs.promises.rename(partPath, finalPath);
      job.done = job.total || job.bytes;
      job.phase = "done";
      job.status = "done";
      job.outFile = finalPath;
      job.finishMs = Date.now();
      job.finishedAt = new Date().toISOString();
      notify(`[${id}] ${base} done / completed -> ${job.outFile}`);
    } catch (err) {
      fs.rmSync(partPath, { force: true });
      job.status = "error";
      job.error = String(err && err.message ? err.message : err);
      job.finishMs = Date.now();
      job.finishedAt = new Date().toISOString();
      notify(`[${id}] ${base} error / failed: ${job.error}`);
    }
  })();

  return job;
}

export function startFileDownload({ url, name, referer, outDir }) {
  ensureDirs();
  const dir = outDir ? path.resolve(outDir) : DOWNLOAD_DIR;
  fs.mkdirSync(dir, { recursive: true });

  const id = `job-${++counter}`;
  const job = {
    id,
    type: "file",
    status: "running",
    phase: "downloading",
    url,
    name: sanitize(name || "material"),
    dir,
    total: 1,
    done: 0,
    bytes: 0,
    outFile: null,
    error: null,
    startMs: Date.now(),
    finishMs: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastNotifyMs: 0,
  };
  jobs.set(id, job);

  (async () => {
    try {
      const res = await httpGetBuffer(url, { timeoutMs: 120000, referer });
      if (res.loginRedirect) throw new Error("session expired");
      if (res.status < 200 || res.status >= 300) throw new Error(`http-${res.status}`);
      const { base, ext } = chooseFileName({ url: res.url || url, name, headers: res.headers || {}, buffer: res.buffer });
      const outPath = uniquePath(dir, base, ext);
      await fs.promises.writeFile(outPath, res.buffer);
      job.done = 1;
      job.total = 1;
      job.bytes = res.buffer.length;
      job.outFile = outPath;
      job.phase = "done";
      job.status = "done";
      job.finishMs = Date.now();
      job.finishedAt = new Date().toISOString();
      notify(`[${id}] ${job.name} done / file saved -> ${job.outFile}`);
    } catch (err) {
      job.status = "error";
      job.error = String(err && err.message ? err.message : err);
      job.finishMs = Date.now();
      job.finishedAt = new Date().toISOString();
      notify(`[${id}] ${job.name} error / failed: ${job.error}`);
    }
  })();

  return job;
}

function view(job) {
  if (!job) return null;
  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const endMs = job.finishMs || Date.now();
  const elapsed = (endMs - job.startMs) / 1000;
  const speed = elapsed > 0 ? job.bytes / elapsed : 0; // bytes/s
  let eta = null;
  if (job.status === "running" && job.done > 0 && job.total > 0) {
    eta = ((job.total - job.done) * elapsed) / job.done;
  }

  const phaseLabel =
    (job.type === "file" || job.type === "direct") && job.status === "running"
      ? "Downloading file / downloading file"
      : job.phase === "remuxing"
      ? "Remuxing mp4 / 封装 mp4 中"
      : job.status === "done"
        ? "Done / 完成"
        : job.status === "error"
          ? "Error / 失败"
          : "Downloading / 下载中";

  let progress;
  if (job.type === "file" || job.type === "direct") {
    progress =
      job.status === "done"
        ? `[${bar(100)}] saved ${fmtMB(job.bytes)}MB`
        : job.status === "error"
          ? `[${bar(0)}] error`
          : `[${bar(pct)}] ${pct}%  ${fmtMB(job.bytes)}MB` +
            (job.total ? `/${fmtMB(job.total)}MB` : "");
  } else if (job.phase === "remuxing") {
    progress = `[${bar(100)}] remuxing to mp4 / 封装 mp4 中…`;
  } else {
    progress =
      `[${bar(pct)}] ${pct}%  ${job.done}/${job.total} segs  ` +
      `${fmtMB(job.bytes)}MB  ${fmtMB(speed)}MB/s` +
      (eta != null ? `  ETA ${fmtDuration(eta)}` : "");
  }

  return {
    id: job.id,
    type: job.type || "replay",
    status: job.status,
    phase: phaseLabel,
    name: job.name,
    percent: pct,
    progress,
    segments: `${job.done}/${job.total}`,
    sizeMB: fmtMB(job.bytes),
    speedMBps: fmtMB(speed),
    etaSeconds: eta != null ? Math.round(eta) : null,
    elapsedSeconds: Math.round(elapsed),
    outFile: job.outFile,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export function getJob(id) {
  return view(jobs.get(id));
}

export function listJobs() {
  return [...jobs.values()].map(view);
}
