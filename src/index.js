#!/usr/bin/env node
// MCP entry point for PKU Blackboard course recordings and materials.
// Keep implementation comments in English; user-facing tool metadata and
// returned messages are bilingual where practical.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  runLogin,
  captureReplay,
  listCourses,
  listLessons,
  downloadLessons,
} from "./capture.js";
import { startDownload, getJob, listJobs, setProgressNotifier } from "./jobs.js";
import { hasSession, pkuCookieCount, checkSessionValid } from "./session.js";
import { DATA_DIR, DOWNLOAD_DIR, STATE_FILE } from "./config.js";
import { listMaterials, downloadMaterials } from "./materials.js";

const SERVER_NAME = "pku-blackboard-mcp";
const SERVER_VERSION = "0.1.0";

const server = new McpServer(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  { capabilities: { logging: {} } }
);

function text(obj) {
  return {
    content: [
      {
        type: "text",
        text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
      },
    ],
  };
}

const courseDescription =
  "Course name; fuzzy matched against your Blackboard course list. Also configurable with PKU_COURSE_NAME. / 课程名；会在你的 Blackboard 课程列表中模糊匹配。也可用 PKU_COURSE_NAME 配置。";

const recordingsUrlDescription =
  "Optional direct recordings-list URL. Omit it to resolve from the course name. / 可选：课堂实录/回放列表页 URL。不填则按课程名解析。";

server.registerTool(
  "pku_status",
  {
    title: "Status / 状态",
    description:
      "Check saved session validity, PKU cookie count, and data/download directories. Does not open a browser. / 检查已保存会话是否有效、PKU cookie 数量，以及数据/下载目录。不打开浏览器。",
    inputSchema: {},
  },
  async () => {
    const check = await checkSessionValid();

    let hint;
    if (check.valid === true) {
      hint =
        "Session valid; you can list courses, lessons, and materials. / 会话有效，可以列课程、课次和课程资料。";
    } else if (check.reason === "no-session") {
      hint = "Not logged in; run pku_login first. / 尚未登录，请先运行 pku_login。";
    } else if (check.valid === false) {
      hint = "Session expired; run pku_login again. / 会话已过期，请重新运行 pku_login。";
    } else {
      hint = `Saved session exists but could not be verified (${check.reason}); rerun pku_login if requests bounce to login. / 已有保存会话但无法验证（${check.reason}）；如果请求被重定向到登录页，请重新运行 pku_login。`;
    }

    return text({
      ok: true,
      server: SERVER_NAME,
      version: SERVER_VERSION,
      loggedIn: hasSession(),
      sessionValid: check.valid,
      sessionCheck: check.reason || "ok",
      pkuCookies: pkuCookieCount(),
      stateFile: STATE_FILE,
      dataDir: DATA_DIR,
      downloadDir: DOWNLOAD_DIR,
      hint,
    });
  }
);

server.registerTool(
  "pku_login",
  {
    title: "Login / 登录",
    description:
      "Open a browser at course.pku.edu.cn for manual IAAA login; saves the session after returning to Blackboard. / 打开浏览器进入 course.pku.edu.cn，由你手动完成 IAAA 登录；回到教学网后保存会话。",
    inputSchema: {
      timeoutSeconds: z
        .number()
        .int()
        .min(30)
        .max(900)
        .optional()
        .describe("Maximum seconds to wait for manual login; default 300. / 等待手动登录的最长秒数；默认 300。"),
    },
  },
  async ({ timeoutSeconds }) => {
    const res = await runLogin({ timeoutMs: (timeoutSeconds || 300) * 1000 });
    return text(res);
  }
);

server.registerTool(
  "pku_list_courses",
  {
    title: "List courses / 列课程",
    description:
      "List courses in your PKU Blackboard account using the saved session. Does not open a browser. / 复用已保存会话列出你的北大教学网课程。不打开浏览器。",
    inputSchema: {},
  },
  async () => text(await listCourses())
);

server.registerTool(
  "pku_list_lessons",
  {
    title: "List recording lessons / 列回放课次",
    description:
      "List all recording lessons for a course, returning indices and titles. Usually browser-free; may fall back to browser for non-standard pages. / 列出某课程全部回放课次，返回序号和标题。通常不开浏览器；非标准页面可能回退浏览器。",
    inputSchema: {
      course: z.string().optional().describe(courseDescription),
      url: z.string().url().optional().describe(recordingsUrlDescription),
      timeoutSeconds: z
        .number()
        .int()
        .min(30)
        .max(900)
        .optional()
        .describe("Maximum seconds to reach the lesson list; default 120. / 到达课次列表的最长秒数；默认 120。"),
    },
  },
  async ({ course, url, timeoutSeconds }) =>
    text(
      await listLessons({
        course,
        url,
        timeoutMs: (timeoutSeconds || 120) * 1000,
      })
    )
);

server.registerTool(
  "pku_download_lessons",
  {
    title: "Download recording lessons / 下载回放课次",
    description:
      "Download selected lesson indices from pku_list_lessons. Opens one browser window to resolve the real media URL, then starts background downloads for HLS or direct MP4 media. / 下载 pku_list_lessons 返回的指定课次序号。会打开一个浏览器窗口解析真实媒体地址，然后为 HLS 或直连 MP4 启动后台下载。",
    inputSchema: {
      indices: z
        .array(z.number().int().min(1))
        .min(1)
        .describe("1-based lesson indices from pku_list_lessons, e.g. [1, 3, 5]. / 来自 pku_list_lessons 的课次序号数组（从 1 开始），如 [1, 3, 5]。"),
      course: z.string().optional().describe(courseDescription),
      url: z.string().url().optional().describe(recordingsUrlDescription),
      namePrefix: z
        .string()
        .optional()
        .describe("Output filename prefix; default is the course name. / 输出文件名前缀；默认使用课程名。"),
      format: z
        .enum(["mp4", "ts"])
        .optional()
        .describe("HLS output format; default mp4. Direct MP4 recordings are saved as mp4 regardless. / HLS 输出格式；默认 mp4。直连 MP4 回放始终保存为 mp4。"),
      outDir: z
        .string()
        .optional()
        .describe("Optional output directory; overrides PKU_DOWNLOAD_DIR for this call. / 可选输出目录；本次调用覆盖 PKU_DOWNLOAD_DIR。"),
      timeoutSeconds: z
        .number()
        .int()
        .min(30)
        .max(900)
        .optional()
        .describe("Maximum seconds to resolve each lesson's media URL; default 180. / 每节课解析媒体地址的最长秒数；默认 180。"),
    },
  },
  async ({ indices, course, url, namePrefix, format, outDir, timeoutSeconds }) =>
    text(
      await downloadLessons({
        indices,
        course,
        url,
        namePrefix,
        format,
        outDir,
        timeoutMs: (timeoutSeconds || 180) * 1000,
      })
    )
);

server.registerTool(
  "pku_capture_replay",
  {
    title: "Capture one replay URL / 抓取单节回放地址",
    description:
      "Manual fallback for a single replay. Opens a browser and waits for playback, then returns captured media URLs. Prefer pku_list_lessons + pku_download_lessons for normal batch downloads. / 单节回放的手动兜底工具。打开浏览器等待播放并返回捕获到的媒体地址。常规批量下载请优先使用 pku_list_lessons + pku_download_lessons。",
    inputSchema: {
      url: z
        .string()
        .url()
        .optional()
        .describe("Optional direct replay/player URL. / 可选：直达回放或播放器页面 URL。"),
      timeoutSeconds: z
        .number()
        .int()
        .min(30)
        .max(900)
        .optional()
        .describe("Maximum seconds to wait for media; default 240. / 等待媒体地址的最长秒数；默认 240。"),
      autoplay: z
        .boolean()
        .optional()
        .describe("Whether to try automatic playback; default true. / 是否尝试自动播放；默认 true。"),
      course: z.string().optional().describe(courseDescription),
    },
  },
  async ({ url, timeoutSeconds, autoplay, course }) =>
    text(
      await captureReplay({
        url,
        timeoutMs: (timeoutSeconds || 240) * 1000,
        autoplay: autoplay !== false,
        course,
      })
    )
);

server.registerTool(
  "pku_download",
  {
    title: "Download one HLS URL / 下载单个 HLS 地址",
    description:
      "Download an m3u8 playlist directly, including AES-128 HLS segments, and remux to mp4 by default. For course lessons, prefer pku_download_lessons. / 直接下载 m3u8 播放列表，支持 AES-128 HLS 分片，默认封装为 mp4。课程课次请优先使用 pku_download_lessons。",
    inputSchema: {
      m3u8: z.string().url().describe("The m3u8 playlist URL. / m3u8 播放列表 URL。"),
      name: z.string().optional().describe("Output filename without extension. / 输出文件名（不含扩展名）。"),
      referer: z.string().url().optional().describe("Optional Referer header. / 可选 Referer 请求头。"),
      outDir: z.string().optional().describe("Optional output directory. / 可选输出目录。"),
      format: z.enum(["mp4", "ts"]).optional().describe("Output format; default mp4. / 输出格式；默认 mp4。"),
    },
  },
  async ({ m3u8, name, referer, outDir, format }) => {
    const job = startDownload({ m3u8, name, referer, outDir, format });
    return text({
      ok: true,
      jobId: job.id,
      status: job.status,
      message: `Started download job ${job.id}; poll with pku_download_status. / 已启动下载任务 ${job.id}；请用 pku_download_status 查询进度。`,
    });
  }
);

server.registerTool(
  "pku_list_materials",
  {
    title: "List course materials / 列课程资料",
    description:
      "List downloadable files and visible text from Blackboard course menu tabs. Does not download. / 列出 Blackboard 课程菜单中的可下载文件和可见文本。不下载。",
    inputSchema: {
      course: z.string().optional().describe(courseDescription),
      courseKey: z.string().optional().describe("Direct Blackboard course key, e.g. _86050_1. / Blackboard 课程 key，如 _86050_1。"),
      tabNames: z
        .array(z.string())
        .optional()
        .describe("Optional menu tab name filters; substring matched. / 可选菜单栏目名过滤；按子串匹配。"),
      types: z
        .array(z.enum(["content", "announcements", "grades", "discussion", "staff", "mail", "tool"]))
        .optional()
        .describe("Optional tab type filters. / 可选栏目类型过滤。"),
    },
  },
  async ({ course, courseKey, tabNames, types }) =>
    text(await listMaterials({ course, courseKey, tabNames, types }))
);

server.registerTool(
  "pku_download_materials",
  {
    title: "Download course materials / 下载课程资料",
    description:
      "Start background downloads for selected Blackboard attachments, and optionally save extracted text as Markdown. / 为选中的 Blackboard 附件启动后台下载，并可把提取到的文本保存为 Markdown。",
    inputSchema: {
      course: z.string().optional().describe(courseDescription),
      courseKey: z.string().optional().describe("Direct Blackboard course key, e.g. _86050_1. / Blackboard 课程 key，如 _86050_1。"),
      tabNames: z
        .array(z.string())
        .optional()
        .describe("Optional menu tab name filters; substring matched. / 可选菜单栏目名过滤；按子串匹配。"),
      types: z
        .array(z.enum(["content", "announcements", "grades", "discussion", "staff", "mail", "tool"]))
        .optional()
        .describe("Optional tab type filters. / 可选栏目类型过滤。"),
      fileUrls: z
        .array(z.string().url())
        .optional()
        .describe("Exact file URLs from pku_list_materials; omit to download all matched files. / pku_list_materials 返回的精确文件 URL；不填则下载匹配范围内全部文件。"),
      downloadFiles: z
        .boolean()
        .optional()
        .describe("Whether to download files; default true. / 是否下载文件；默认 true。"),
      saveText: z
        .enum(["none", "md"])
        .optional()
        .describe("Set to md to save extracted text as Markdown; default none. / 设为 md 时把提取文本保存为 Markdown；默认 none。"),
      outDir: z.string().optional().describe("Optional output directory. / 可选输出目录。"),
    },
  },
  async ({ course, courseKey, tabNames, types, fileUrls, downloadFiles, saveText, outDir }) =>
    text(
      await downloadMaterials({
        course,
        courseKey,
        tabNames,
        types,
        fileUrls,
        downloadFiles: downloadFiles !== false,
        saveText: saveText || "none",
        outDir,
      })
    )
);

server.registerTool(
  "pku_download_status",
  {
    title: "Download status / 下载状态",
    description:
      "Query one background job by jobId, or list all current jobs. / 按 jobId 查询单个后台任务，或列出当前全部任务。",
    inputSchema: {
      jobId: z.string().optional().describe("Job ID; omit to list all jobs. / 任务 ID；不填则列出全部任务。"),
    },
  },
  async ({ jobId }) => {
    if (jobId) {
      const job = getJob(jobId);
      return text(job || { ok: false, error: `Job not found / 未找到任务: ${jobId}` });
    }
    return text({ ok: true, jobs: listJobs() });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

setProgressNotifier((message) => {
  server.server
    .sendLoggingMessage({ level: "info", logger: "pku-download", data: message })
    .catch(() => {});
});

console.error(`[${SERVER_NAME}] server ready`);
