// Background download jobs. A lecture replay can be 1–2 GB and take many
// minutes, longer than a typical MCP tool call should block. So pku_download
// starts a job and returns immediately; pku_download_status polls it.

import fs from "node:fs";
import path from "node:path";
import { downloadHls } from "./hls.js";
import { remuxToMp4 } from "./ffmpeg.js";
import { DOWNLOAD_DIR, DOWNLOAD_CONCURRENCY, ensureDirs } from "./config.js";

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
    job.phase === "remuxing"
      ? "Remuxing mp4 / 封装 mp4 中"
      : job.status === "done"
        ? "Done / 完成"
        : job.status === "error"
          ? "Error / 失败"
          : "Downloading / 下载中";

  let progress;
  if (job.phase === "remuxing") {
    progress = `[${bar(100)}] remuxing to mp4 / 封装 mp4 中…`;
  } else {
    progress =
      `[${bar(pct)}] ${pct}%  ${job.done}/${job.total} segs  ` +
      `${fmtMB(job.bytes)}MB  ${fmtMB(speed)}MB/s` +
      (eta != null ? `  ETA ${fmtDuration(eta)}` : "");
  }

  return {
    id: job.id,
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
