# pku-course-dl

[中文文档](README.zh.md)

An MCP server for downloading lecture recordings / replays (课堂实录 / 课程回放) from
PKU's teaching network (`course.pku.edu.cn`).

Inspired by the [pku-learner skill](https://github.com/pku-skills/curated/tree/main/skills/pku-learner)
(manual browser login → sniff m3u8 → HLS download), but packaged as a **self-contained MCP that
never touches your system environment**:

- **No global env changes** — all config is passed as process-scoped env from the MCP client;
  session, cache, and downloads all stay inside the project directory.
- **No system yt-dlp / ffmpeg** — HLS download + AES-128 decryption are implemented in pure Node;
  remuxing to mp4 uses the `ffmpeg-static` npm package (lives in `node_modules`).
- **Reuses your browser** — login prefers a system-installed Chrome → Edge, falling back to a
  project-local Chromium (≈150 MB, first run only, downloaded into the project's `.cache/browsers`,
  never to the global `~/.cache`).

> For downloading recordings **you are authorized to access** only. Respect your institution's
> rules and copyright.

## Requirements

- Node.js ≥ 20
- A system Chrome or Edge (recommended), otherwise a project-local Chromium is fetched on first login.

## Install

```bash
cd pku-course-dl
npm install
```

`npm install` does not download a browser. A bundled Chromium is fetched only on first login, and
only if neither Chrome nor Edge is found.

## Tools

| Tool | Purpose |
|------|---------|
| `pku_status` | Show login state and data/download dir locations (no browser). |
| `pku_login` | Open a browser to complete IAAA login; saves the session. |
| `pku_list_lessons` | List **all lessons** (index + title) in a course's recordings — no playback, no download. |
| `pku_download_lessons` | Take an array of lesson indices; capture and background-download them in one window. |
| `pku_capture_replay` | Open a browser, play a replay, and sniff a single m3u8 URL. |
| `pku_download` | Background download + AES-128 decrypt + remux to mp4 for one m3u8; returns a jobId. |
| `pku_download_status` | Query a job's progress, or list all jobs. |

## Typical flow (batch download, recommended)

A course usually has many lessons, so list first, pick indices, then download:

1. **`pku_login`** — a browser window opens; complete IAAA login (password / WeChat / 2FA). The
   session is saved to `.cache/session-state.json` once you return to `course.pku.edu.cn`.
2. **`pku_list_lessons`** — opens a browser (reusing the session), auto-navigates
   `course list → course → recordings`, stops at the lesson list, and returns every lesson:
   ```json
   { "ok": true, "count": 12, "lessons": [
     { "index": 1, "title": "Lesson 1 …" },
     { "index": 2, "title": "Lesson 2 …" }
   ] }
   ```
   - Pass `course` (course name) or set `PKU_COURSE_NAME` to auto-open the course from the home
     page. The name is **fuzzy-matched** (substring first, then subsequence), so minor typos or a
     missing character still resolve to the closest course.
   - Pass `url` to open the recordings list directly and skip navigation.
   - If the list isn't found, the result includes `diagnostics` (a snapshot of the page's real
     links/buttons) to help pin selectors.
3. **Pick indices** — choose the lessons you want, e.g. 1, 3, 5.
4. **`pku_download_lessons`** — pass `indices: [1, 3, 5]` (use the same `course`/`url` as step 2).
   In a single window it plays each lesson, captures its m3u8, and starts a background job per
   lesson, returning each `jobId`:
   ```json
   { "ok": true, "results": [
     { "index": 1, "jobId": "job-1", "name": "course-01", "m3u8": "https://…" },
     { "index": 3, "jobId": "job-2", "name": "course-03", "m3u8": "https://…" }
   ], "skipped": [] }
   ```
   - Lessons whose m3u8 can't be captured go to `skipped` (with a reason); the rest proceed.
   - Output files are named `<prefix>-03.mp4`; customize via `namePrefix`.
5. **`pku_download_status`** — list all jobs, or pass a `jobId` for one. Progress includes a bar,
   speed, and ETA, e.g.:
   `[██████████░░░░░░░░░░░░] 46%  120/260 segs  248.6MB  3.1MB/s  ETA 0:48`
   The output `mp4` path is in `outFile` (default `downloads/`). Progress is also pushed live via
   MCP logging notifications.

> A single replay can be 1–2 GB and take minutes, so downloads run in the background and never
> block the conversation.

## Single lesson (fallback)

When you only want one replay, or auto-navigation doesn't kick in:

1. **`pku_capture_replay`** — opens a browser (reusing the session), **auto-plays by default**, and
   sniffs the `playlist.m3u8`. The window is headed, so you can click manually as a fallback (or
   pass `autoplay: false`). Note it captures **only the first lesson** in the list — for a specific
   lesson use `pku_list_lessons` + `pku_download_lessons`.
2. **`pku_download`** — pass the captured `m3u8` (and ideally a `name`); returns a `jobId`.
3. **`pku_download_status`** — pass the `jobId` to track progress.

## Configuration (optional, all process-scoped env)

| Env var | Default | Description |
|---------|---------|-------------|
| `PKU_DATA_DIR` | `<project>/.cache` | Session, browser cache, temp files. |
| `PKU_DOWNLOAD_DIR` | `<project>/downloads` | Video output directory. |
| `PKU_CONCURRENCY` | `6` | HLS segment download concurrency. |
| `PKU_COURSE_HOME` | `https://course.pku.edu.cn` | Teaching network entry point. |
| `PKU_COURSE_NAME` | (empty) | Course name for auto-navigation (also settable per call via `course`). |
| `PLAYWRIGHT_BROWSERS_PATH` | `<PKU_DATA_DIR>/browsers` | Bundled Chromium location (defaults inside the project). |

## Connecting an MCP client

Replace `/path/to/pku-course-dl` with your actual project path (on Windows, use forward slashes or
double backslashes).

### Claude Code

```bash
claude mcp add pku-course-dl -- node "/path/to/pku-course-dl/src/index.js"
```

To pass configuration (see [Configuration](#configuration-optional-all-process-scoped-env)),
add one or more `-e KEY=value` flags **before** the `--` separator:

```bash
claude mcp add pku-course-dl \
  -e PKU_COURSE_NAME="实验原子物理进展" \
  -e PKU_DOWNLOAD_DIR="/path/to/downloads" \
  -- node "/path/to/pku-course-dl/src/index.js"
```

By default the server is added at `local` scope (this project only). Use `-s user` for all
projects, or `-s project` to share it via a committed `.mcp.json`.

> **Windows / PowerShell:** the `claude mcp add … -- node …` form fails because PowerShell drops
> the `--` separator, so the variadic `-e` swallows `node` and the script path
> (`error: missing required argument 'commandOrUrl'`). Use `add-json` instead — but PowerShell also
> strips the inner double quotes when passing a JSON string to a native command, so you must escape
> each interior `"` as `\"` (outer quotes stay single). Use forward slashes in paths to avoid
> backslash escaping:
>
> ```powershell
> claude mcp add-json pku-course-dl '{\"command\":\"node\",\"args\":[\"D:/path/to/pku-course-dl/src/index.js\"],\"env\":{\"PKU_DOWNLOAD_DIR\":\"D:/path/to/downloads\"}}'
> ```
>
> To change an existing entry, remove it first (`add-json` won't overwrite):
> `claude mcp remove pku-course-dl` then re-run the command above. Verify with
> `claude mcp get pku-course-dl`.

### Generic stdio config

```json
{
  "mcpServers": {
    "pku-course-dl": {
      "command": "node",
      "args": ["/path/to/pku-course-dl/src/index.js"],
      "env": {
        "PKU_DOWNLOAD_DIR": "/path/to/downloads"
      }
    }
  }
}
```

## Notes and limitations

- Use only for recordings **you are authorized to access**; respect institutional rules and copyright.
- Session cookies usually expire within hours to days; once expired, the tools prompt you to
  `pku_login` again.
- Supports standard HLS (including AES-128). Non-HLS platforms (polyv / 超星 / ClassIn / …) may not
  yield an m3u8 and would need separate handling.
- `.cache/` holds login cookies, is gitignored, and must not be committed or shared.
