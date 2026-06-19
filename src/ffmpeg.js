// Remux a concatenated MPEG-TS file to .mp4 using the project-local
// ffmpeg-static binary (no system ffmpeg, no PATH changes).

import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

// Stream-copy remux (no re-encode): fast and lossless. aac_adtstoasc fixes
// AAC audio carried in TS so it plays correctly in an MP4 container.
export function remuxToMp4(tsPath, mp4Path) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      return reject(
        new Error("ffmpeg-static unavailable, cannot remux to mp4. / ffmpeg-static 不可用，无法封装为 mp4。")
      );
    }
    const args = [
      "-y",
      "-i",
      tsPath,
      "-c",
      "copy",
      "-bsf:a",
      "aac_adtstoasc",
      "-movflags",
      "+faststart",
      mp4Path,
    ];
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(mp4Path)
        : reject(new Error(`ffmpeg exited with code ${code}:\n${stderr.slice(-1500)}`))
    );
  });
}
