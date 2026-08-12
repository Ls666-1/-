#!/usr/bin/env node
/**
 * 团队工作管理平台 —— 零依赖后端
 * 纯 Node 内置模块，无需 npm install。
 * 提供：静态前端托管 + REST API + SSE 实时同步 + JSON 文件存储。
 *
 * 启动：node server.js   （可选环境变量 PORT / DATA_DIR / TEAM_KEY）
 * 多人协作：把本服务部署到任意 Node 主机，前端自动走协作模式。
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// 加载 .env（零依赖，避免引入第三方包）。仅在变量未设置时填充，方便环境变量覆盖。
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const txt = fs.readFileSync(envPath, "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  }
} catch (e) { /* 忽略 .env 读取错误 */ }

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const TEAM_KEY = process.env.TEAM_KEY || ""; // 设置后，写操作需带 x-team-key 请求头
const PUBLIC_DIR = path.join(__dirname, "public");

const STATE_FILE = path.join(DATA_DIR, "state.json");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

let state = { tasks: [], members: [], history: [], updatedAt: Date.now() };
const sseClients = new Set();

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function sanitizeReminder(r) {
  if (!r || typeof r !== "object") return { enabled: false, at: null, channels: { inapp: true, browser: false, dingtalk: false }, notified: false };
  const ch = r.channels || {};
  return {
    enabled: !!r.enabled,
    at: r.at ? String(r.at).slice(0, 30) : null,
    channels: { inapp: !!ch.inapp, browser: !!ch.browser, dingtalk: !!ch.dingtalk },
    notified: !!r.notified,
  };
}

// 钉钉 access_token 获取（优先用 appKey/appSecret 自动换取，避免手动维护 token）
// 说明：钉钉没有单独的「企业 API token」，企业内部应用用 appKey+appSecret 调 /gettoken 换取 access_token。
let dingTokenCache = { token: "", exp: 0 };
async function getDingAccessToken() {
  const key = process.env.DINGTALK_APPKEY, secret = process.env.DINGTALK_APPSECRET;
  if (key && secret) {
    if (dingTokenCache.token && Date.now() < dingTokenCache.exp) return dingTokenCache.token;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(`https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(key)}&appsecret=${encodeURIComponent(secret)}`, { signal: ctrl.signal });
      clearTimeout(to);
      const j = await r.json();
      if (j.errcode === 0) {
        dingTokenCache = { token: j.access_token, exp: Date.now() + ((j.expires_in || 7200) * 1000 - 60000) };
        return j.access_token;
      }
    } catch (e) { /* fall through to static token */ }
  }
  return process.env.DINGTALK_TODO_TOKEN || "";
}

function seed() {
  const t = new Date();
  const y = new Date(t); y.setDate(y.getDate() - 1);
  const tm = new Date(t); tm.setDate(t.getDate() + 2);
  const base = (o) => ({ comments: [], reminder: { enabled: false, at: null, channels: { inapp: true, browser: false, dingtalk: false }, notified: false }, note: "", ...o });
  return {
    updatedAt: Date.now(),
    history: [],
    tasks: [
      base({ id: uid(), title: "整理 Q3 产品需求文档", owner: "张三", priority: "P0", due: fmtDate(y), status: "待办" }),
      base({ id: uid(), title: "首页改版视觉稿评审", owner: "李四", priority: "P1", due: fmtDate(t), status: "进行中" }),
      base({ id: uid(), title: "接口联调与提测", owner: "王五", priority: "P1", due: fmtDate(tm), status: "待办" }),
      base({ id: uid(), title: "本周站会纪要同步", owner: "张三", priority: "P2", due: fmtDate(t), status: "待办" }),
    ],
    members: [
      { id: uid(), name: "张三", role: "产品经理" },
      { id: uid(), name: "李四", role: "前端开发" },
      { id: uid(), name: "王五", role: "测试工程师" },
    ],
  };
}
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      state = { tasks: raw.tasks || [], members: raw.members || [], history: raw.history || [], updatedAt: raw.updatedAt || Date.now() };
      return;
    }
  } catch (e) { /* fallthrough to seed */ }
  state = seed();
  saveState();
}
function saveState() {
  state.updatedAt = Date.now();
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("保存状态失败:", e.message);
  }
}
function broadcast() {
  const payload = `data: ${JSON.stringify({ type: "update", state, ts: state.updatedAt })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { sseClients.delete(res); }
  }
}
// 将任务快照写入历史记录（用于保存过往工作），按任务 id 去重（同一任务重复完成时更新时间）
function archiveTask(t, completedAt) {
  if (!t) return;
  const snap = {
    id: "h-" + t.id,
    taskId: t.id,
    title: t.title,
    owner: t.owner,
    priority: t.priority,
    due: t.due,
    note: t.note || "",
    comments: Array.isArray(t.comments) ? t.comments : [],
    completedAt: completedAt || Date.now(),
  };
  const i = state.history.findIndex((h) => h.taskId === t.id);
  if (i >= 0) state.history[i] = snap; else state.history.unshift(snap);
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-team-key",
    "Cache-Control": "no-store",
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
function hasWriteAuth(req) {
  if (!TEAM_KEY) return true;
  return req.headers["x-team-key"] === TEAM_KEY;
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA 回退
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, b2) => {
        if (e2) { res.writeHead(404); res.end("Not found"); }
        else { res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(b2); }
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") { sendJSON(res, 204, {}); return; }

  // SSE 实时流
  if (p === "/api/events" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("retry: 3000\n\n");
    res.write(`data: ${JSON.stringify({ type: "hello", state })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // 读取状态
  if (p === "/api/state" && method === "GET") {
    return sendJSON(res, 200, { ok: true, tasks: state.tasks, members: state.members, history: state.history, updatedAt: state.updatedAt });
  }

  // 历史记录：列表 / 删除 / 恢复
  if (p === "/api/history" && method === "GET") {
    return sendJSON(res, 200, { ok: true, history: state.history });
  }
  let hm = p.match(/^\/api\/history\/([\w-]+)$/);
  if (hm) {
    const hid = hm[1];
    if (method === "DELETE") {
      if (!hasWriteAuth(req)) return sendJSON(res, 401, { ok: false, error: "需要团队密钥" });
      const before = state.history.length;
      state.history = state.history.filter((x) => x.id !== hid);
      if (state.history.length === before) return sendJSON(res, 404, { ok: false, error: "记录不存在" });
      saveState(); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
    if (method === "POST" && url.searchParams.get("restore") !== null) {
      if (!hasWriteAuth(req)) return sendJSON(res, 401, { ok: false, error: "需要团队密钥" });
      const h = state.history.find((x) => x.id === hid);
      if (!h) return sendJSON(res, 404, { ok: false, error: "记录不存在" });
      // 恢复为一条「已完成」任务
      const restored = {
        id: h.taskId && state.tasks.every((t) => t.id !== h.taskId) ? h.taskId : uid(),
        title: String(h.title || "").slice(0, 200),
        owner: String(h.owner || "").slice(0, 60),
        priority: ["P0", "P1", "P2"].includes(h.priority) ? h.priority : "P1",
        due: h.due || fmtDate(new Date()),
        status: "已完成",
        note: String(h.note || "").slice(0, 500),
        comments: Array.isArray(h.comments) ? h.comments : [],
        reminder: { enabled: false, at: null, channels: { inapp: true, browser: false, dingtalk: false }, notified: false },
        completedAt: h.completedAt,
      };
      state.tasks.push(restored);
      state.history = state.history.filter((x) => x.id !== hid);
      saveState(); broadcast();
      return sendJSON(res, 200, { ok: true, task: restored });
    }
  }

  // 任务：新增
  if (p === "/api/task" && method === "POST") {
    if (!hasWriteAuth(req)) return sendJSON(res, 401, { ok: false, error: "需要团队密钥" });
    try {
      const b = await readBody(req);
      if (!b.title || !b.owner) return sendJSON(res, 400, { ok: false, error: "标题与负责人必填" });
      const t = {
        id: uid(), title: String(b.title).slice(0, 200), owner: String(b.owner).slice(0, 60),
        priority: ["P0", "P1", "P2"].includes(b.priority) ? b.priority : "P1",
        due: b.due || fmtDate(new Date()), status: ["待办", "进行中", "已完成"].includes(b.status) ? b.status : "待办",
        note: String(b.note || "").slice(0, 500),
        comments: Array.isArray(b.comments) ? b.comments.slice(0, 200) : [],
        reminder: b.reminder ? sanitizeReminder(b.reminder) : { enabled: false, at: null, channels: { inapp: true, browser: false, dingtalk: false }, notified: false },
      };
      state.tasks.push(t); saveState(); broadcast();
      return sendJSON(res, 201, { ok: true, task: t });
    } catch (e) { return sendJSON(res, 400, { ok: false, error: "请求体解析失败" }); }
  }

  // 任务：更新 / 删除
  let m = p.match(/^\/api\/task\/([\w-]+)$/);
  if (m) {
    const id = m[1];
    if (method === "PUT" || method === "PATCH") {
      if (!hasWriteAuth(req)) return sendJSON(res, 401, { ok: false, error: "需要团队密钥" });
      try {
        const b = await readBody(req);
        const t = state.tasks.find((x) => x.id === id);
        if (!t) return sendJSON(res, 404, { ok: false, error: "任务不存在" });
        if (b.title !== undefined) t.title = String(b.title).slice(0, 200);
        if (b.owner !== undefined) t.owner = String(b.owner).slice(0, 60);
        if (b.priority !== undefined && ["P0", "P1", "P2"].includes(b.priority)) t.priority = b.priority;
        if (b.due !== undefined) t.due = b.due;
        if (b.status !== undefined && ["待办", "进行中", "已完成"].includes(b.status)) {
          const becameDone = b.status === "已完成" && t.status !== "已完成";
          t.status = b.status;
          if (becameDone) archiveTask(t, Date.now());
        }
        if (b.note !== undefined) t.note = String(b.note).slice(0, 500);
        if (b.comments !== undefined && Array.isArray(b.comments)) t.comments = b.comments.slice(0, 200);
        if (b.reminder !== undefined) t.reminder = sanitizeReminder(b.reminder);
        saveState(); broadcast();
        return sendJSON(res, 200, { ok: true, task: t });
      } catch (e) { return sendJSON(res, 400, { ok: false, error: "请求体解析失败" }); }
    }
    if (method === "DELETE") {
      if (!hasWriteAuth(req)) return sendJSON(res, 401, { ok: false, error: "需要团队密钥" });
      const t = state.tasks.find((x) => x.id === id);
      if (!t) return sendJSON(res, 404, { ok: false, error: "任务不存在" });
      if (t.status === "已完成") archiveTask(t, t.completedAt || Date.now()); // 删除已完成任务时保留到历史
      state.tasks = state.tasks.filter((x) => x.id !== id);
      saveState(); broadcast();
      return sendJSON(res, 200, { ok: true });
    }
  }

  // 钉钉关联：把任务推送到钉钉待办 / 日历
  // 优先级：配置了待办 access_token → 真实待办 API；配置了群机器人 webhook → 群通知；都没配 → 提示前端走本地深链
  let dm = p.match(/^\/api\/task\/([\w-]+)\/dingtalk$/);
  if (dm && method === "POST") {
    if (!hasWriteAuth(req)) return sendJSON(res, 401, { ok: false, error: "需要团队密钥" });
    try {
      const id = dm[1];
      const t = state.tasks.find((x) => x.id === id);
      if (!t) return sendJSON(res, 404, { ok: false, error: "任务不存在" });
      const b = await readBody(req).catch(() => ({}));
      const k = b.kind || b.target || "todo";
      const target = (k === "calendar" || k === "cal") ? "calendar" : "todo";
      const DING_TOKEN = await getDingAccessToken();
      const DING_WEBHOOK = process.env.DINGTALK_WEBHOOK || "";
      let todoFailedMsg = "";

      // 1) 真实待办 API（需钉钉开放平台「待办」能力 + access_token）
      if (DING_TOKEN) {
        const dueMs = t.reminder && t.reminder.at ? new Date(t.reminder.at).getTime() : (t.due ? new Date(t.due + "T18:00:00").getTime() : Date.now() + 86400000);
        const body = {
          sourceId: `teamapp-${t.id}`,
          subject: t.title.slice(0, 50),
          description: `负责人：${t.owner || "未指定"}\n优先级：${t.priority}\n${t.note || ""}`.slice(0, 400),
          dueTime: dueMs,
          priority: t.priority === "P0" ? 2 : t.priority === "P1" ? 1 : 0,
          done: t.status === "已完成",
        };
        try {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 6000);
          const r = await fetch(`https://oapi.dingtalk.com/topapi/todo/task/create?access_token=${encodeURIComponent(DING_TOKEN)}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal,
          });
          clearTimeout(to);
          const j = await r.json();
          if (j.errcode === 0) return sendJSON(res, 200, { ok: true, mode: "todo-api", taskId: j.result && j.result.taskId, message: "已推送到钉钉待办" });
          todoFailedMsg = "钉钉待办 API 拒绝：" + (j.errmsg || "未知错误") + "（多半是应用未开通「待办」能力，请在开放平台「权限管理」勾选，或改用更稳的群机器人 Webhook）";
        } catch (e) {
          todoFailedMsg = "调用钉钉待办接口异常：" + e.message;
        }
      }

      // 2) 群机器人 webhook（无需审批，最稳妥的推送方式）
      if (DING_WEBHOOK) {
        const text = `### 📋 团队任务提醒\n**${t.title}**\n- 负责人：${t.owner || "未指定"}\n- 优先级：${t.priority}\n- 截止：${t.due || "未设置"}\n- 状态：${t.status}`;
        try {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 6000);
          const r = await fetch(DING_WEBHOOK, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msgtype: "markdown", markdown: { title: "团队任务提醒", text } }), signal: ctrl.signal,
          });
          clearTimeout(to);
          const j = await r.json();
          if (j.errcode === 0) return sendJSON(res, 200, { ok: true, mode: "webhook", message: `已推送到钉钉群（${target === "calendar" ? "日历提醒" : "待办提醒"}）` });
          return sendJSON(res, 200, { ok: false, mode: "webhook-failed", error: j.errmsg || "推送失败", message: "群机器人推送失败，请检查 Webhook 地址是否正确" });
        } catch (e) {
          return sendJSON(res, 200, { ok: false, mode: "webhook-error", error: e.message, message: "调用钉钉群机器人异常" });
        }
      }

      // 3) 未配置凭据 / 待办被拒：返回提示（前端退回到本地深链 / 复制）
      const msg = todoFailedMsg
        ? todoFailedMsg + (DING_WEBHOOK ? "" : "；或配置 DINGTALK_WEBHOOK 群机器人即可免审批推送。")
        : "未配置钉钉凭据。前端已为你生成可手动添加的链接与复制文本。";
      return sendJSON(res, 200, { ok: false, mode: todoFailedMsg ? "todo-api-failed" : "unconfigured", message: msg });
    } catch (e) { return sendJSON(res, 400, { ok: false, error: "请求处理失败" }); }
  }

  // 成员：新增 / 删除
  if (p === "/api/member" && method === "POST") {
    if (!hasWriteAuth(req)) return sendJSON(res, 401, { ok: false, error: "需要团队密钥" });
    try {
      const b = await readBody(req);
      if (!b.name) return sendJSON(res, 400, { ok: false, error: "姓名必填" });
      const mem = { id: uid(), name: String(b.name).slice(0, 60), role: String(b.role || "").slice(0, 60) };
      state.members.push(mem); saveState(); broadcast();
      return sendJSON(res, 201, { ok: true, member: mem });
    } catch (e) { return sendJSON(res, 400, { ok: false, error: "请求体解析失败" }); }
  }
  m = p.match(/^\/api\/member\/([\w-]+)$/);
  if (m && method === "DELETE") {
    if (!hasWriteAuth(req)) return sendJSON(res, 401, { ok: false, error: "需要团队密钥" });
    const id = m[1];
    const before = state.members.length;
    state.members = state.members.filter((x) => x.id !== id);
    if (state.members.length === before) return sendJSON(res, 404, { ok: false, error: "成员不存在" });
    saveState(); broadcast();
    return sendJSON(res, 200, { ok: true });
  }

  // 静态资源
  if (p.startsWith("/api/")) return sendJSON(res, 404, { ok: false, error: "接口不存在" });
  serveStatic(req, res);
});

loadState();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`团队工作管理平台已启动: http://0.0.0.0:${PORT}  (PORT=${PORT})`);
  console.log("运行模式: 检测到 /api/state 即走多人协作；环境变量 DINGTALK_* 控制钉钉推送");
  if (TEAM_KEY) console.log("已启用团队密钥保护（写操作需 x-team-key 头）");
});
