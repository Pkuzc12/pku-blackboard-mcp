// Native HLS (m3u8) downloader with AES-128 decryption — no yt-dlp / ffmpeg
// needed for the fetch+decrypt step. Produces a single concatenated MPEG-TS
// file; remuxing to .mp4 is handled separately (jobs.js -> ffmpeg.js).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cookieHeaderFor } from "./session.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function headersFor(url, referer) {
  const h = {
    "User-Agent": UA,
    Accept: "*/*",
  };
  const cookie = cookieHeaderFor(url);
  if (cookie) h["Cookie"] = cookie;
  if (referer) h["Referer"] = referer;
  return h;
}

async function fetchText(url, referer) {
  const res = await fetch(url, { headers: headersFor(url, referer) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function fetchBuffer(url, referer) {
  const res = await fetch(url, { headers: headersFor(url, referer) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Parse `KEY=VALUE,KEY="V,V"` attribute lists, honoring quoted commas.
function parseAttrs(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    attrs[m[1]] = v;
  }
  return attrs;
}

function ivFromSequence(seq) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(seq >>> 0, 12); // low 32 bits suffice for our sequence sizes
  return iv;
}

function hexToBuf(hex) {
  return Buffer.from(hex.replace(/^0x/i, ""), "hex");
}

// Resolve a master playlist down to a concrete media playlist (highest
// bandwidth variant), returning { playlistUrl, text }.
async function resolveMediaPlaylist(m3u8Url, referer, depth = 0) {
  const text = await fetchText(m3u8Url, referer);
  if (!/#EXT-X-STREAM-INF/i.test(text)) {
    return { playlistUrl: m3u8Url, text };
  }
  if (depth > 4) return { playlistUrl: m3u8Url, text };

  const lines = text.split(/\r?\n/);
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const attrs = parseAttrs(lines[i]);
      const bw = parseInt(attrs.BANDWIDTH || attrs["AVERAGE-BANDWIDTH"] || "0", 10);
      const uri = (lines[i + 1] || "").trim();
      if (uri && (!best || bw > best.bw)) {
        best = { bw, uri: new URL(uri, m3u8Url).toString() };
      }
    }
  }
  if (!best) return { playlistUrl: m3u8Url, text };
  return resolveMediaPlaylist(best.uri, referer, depth + 1);
}

// Parse a media playlist into an ordered segment list with per-segment key info.
function parseSegments(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let curKey = null; // { method, keyUrl, iv }
  let seq = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
      seq = parseInt(line.split(":")[1] || "0", 10) || 0;
    } else if (line.startsWith("#EXT-X-KEY")) {
      const attrs = parseAttrs(line.slice("#EXT-X-KEY:".length));
      const method = (attrs.METHOD || "NONE").toUpperCase();
      if (method === "NONE") {
        curKey = null;
      } else {
        curKey = {
          method,
          keyUrl: attrs.URI ? new URL(attrs.URI, baseUrl).toString() : null,
          iv: attrs.IV ? hexToBuf(attrs.IV) : null,
        };
      }
    } else if (line && !line.startsWith("#")) {
      const url = new URL(line, baseUrl).toString();
      segments.push({
        url,
        seq,
        key: curKey
          ? { ...curKey, iv: curKey.iv || ivFromSequence(seq) }
          : null,
      });
      seq++;
    }
  }
  return segments;
}

// Download + decrypt all segments concurrently, concatenating (in order) into
// `outTsPath`. Calls onProgress({ done, total, bytes }) as segments complete.
export async function downloadHls({
  m3u8Url,
  referer,
  outTsPath,
  concurrency = 6,
  onProgress = () => {},
}) {
  const { playlistUrl, text } = await resolveMediaPlaylist(m3u8Url, referer);
  const segments = parseSegments(text, playlistUrl);
  if (segments.length === 0)
    throw new Error(
      "Playlist has no segments (may not be a valid m3u8). / 播放列表中没有分片(可能不是有效的 m3u8)。"
    );

  const tmpDir = outTsPath + ".parts";
  fs.mkdirSync(tmpDir, { recursive: true });

  const keyCache = new Map();
  async function getKey(keyUrl) {
    if (!keyCache.has(keyUrl)) {
      keyCache.set(keyUrl, await fetchBuffer(keyUrl, referer));
    }
    return keyCache.get(keyUrl);
  }

  const total = segments.length;
  let done = 0;
  let bytes = 0;

  async function processOne(idx) {
    const seg = segments[idx];
    const partPath = path.join(tmpDir, String(idx).padStart(6, "0") + ".ts");
    if (fs.existsSync(partPath) && fs.statSync(partPath).size > 0) {
      done++;
      bytes += fs.statSync(partPath).size;
      onProgress({ done, total, bytes });
      return;
    }
    let data = await fetchBuffer(seg.url, referer);
    if (seg.key && seg.key.method === "AES-128") {
      const key = await getKey(seg.key.keyUrl);
      const decipher = crypto.createDecipheriv("aes-128-cbc", key, seg.key.iv);
      data = Buffer.concat([decipher.update(data), decipher.final()]);
    } else if (seg.key && seg.key.method && seg.key.method !== "NONE") {
      throw new Error(`Unsupported encryption method / 不支持的加密方式: ${seg.key.method}`);
    }
    fs.writeFileSync(partPath, data);
    done++;
    bytes += data.length;
    onProgress({ done, total, bytes });
  }

  // Simple worker pool.
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= total) return;
      await processOne(idx);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, total) }, worker);
  await Promise.all(workers);

  // Concatenate parts in order into the final .ts file.
  const out = fs.createWriteStream(outTsPath);
  for (let i = 0; i < total; i++) {
    const partPath = path.join(tmpDir, String(i).padStart(6, "0") + ".ts");
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(partPath);
      rs.on("error", reject);
      rs.on("end", resolve);
      rs.pipe(out, { end: false });
    });
  }
  await new Promise((resolve) => out.end(resolve));

  // Clean up parts.
  fs.rmSync(tmpDir, { recursive: true, force: true });

  return { tsPath: outTsPath, segments: total, bytes };
}
