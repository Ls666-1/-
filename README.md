# 团队工作管理平台

一个零依赖、可自托管的团队任务协作工具：任务看板、成员分工、进度看板、任务评论、历史记录、到期提醒，支持**多人实时协作**（基于 SSE）与**钉钉待办/日历关联**。

## 目录结构

```
team-app/
├── server.js        # 零依赖 Node 后端（静态托管 + REST API + SSE + JSON 存储）
├── public/
│   └── index.html   # 前端（双模式：检测到后端→实时协作；否则→本地单机）
├── data/            # 运行时自动生成 state.json（数据落盘）
├── package.json
└── README.md
```

## 一、本地启动（开发 / 演示）

```bash
cd team-app
node server.js
# 浏览器打开 http://localhost:3000
```

无需 `npm install`，纯 Node 内置模块。多人打开同一地址即为实时协作。

### 功能一览

- **任务看板**：待办 / 进行中 / 已完成 三栏，含负责人、优先级（P0/P1/P2）、截止日，逾期标红
- **成员分工**：成员 + 角色，自动统计每人当前任务负载
- **进度看板**：完成率环形图 + 状态分布 + 成员负载（全手写 SVG，零外部依赖）
- **任务评论**：点开任务卡片 → 详情抽屉内可多人讨论、增删评论
- **历史记录**：任务标记为「已完成」或删除已完成任务时，自动归档到「历史记录」页（含负责人、完成时间、评论），可一键恢复到看板或删除
- **到期提醒**：每个任务可设提醒时间，到点触发 App 内 toast + 浏览器通知；逾期/临期自动在「今天要处理」置顶
- **深色模式**：顶栏一键切换浅/深，偏好本地记忆
- **钉钉关联**：任务详情里「同步到钉钉待办 / 日历」，可把任务推到团队钉钉（需配置凭据，见下）

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `DATA_DIR` | `./data` | 数据存储目录 |
| `TEAM_KEY` | 空 | 设置后，所有写操作需带请求头 `x-team-key` |
| `DINGTALK_APPKEY` | 空 | 钉钉企业内部应用的 AppKey（推荐，配合 AppSecret 自动换取 access_token） |
| `DINGTALK_APPSECRET` | 空 | 钉钉企业内部应用的 AppSecret |
| `DINGTALK_TODO_TOKEN` | 空 | 也可直接填静态 access_token（兜底；优先用上面的 AppKey/AppSecret 自动获取） |
| `DINGTALK_WEBHOOK` | 空 | 钉钉群机器人 Webhook 地址，配置后「同步到钉钉」以群消息形式推送通知 |

### 钉钉关联（两种真实路径 + 本地回退）

凭据已验证可用：用 `AppKey` + `AppSecret` 调 `/gettoken` 可成功换取 `access_token`（服务端已内置自动获取与 2 小时缓存）。

**路径 A · 真实钉钉待办（最完整，但需应用开通「待办」能力）**
- 钉钉开发者后台 → 你的应用 → **权限管理** → 找到「待办」相关权限并申请/勾选，发布应用
- 之后点任务详情「同步到钉钉待办」即把任务写入钉钉待办
- 若报错 `不合法ApiName / dingtalk.oapi.todo.task.create`，说明应用尚未开通「待办」能力，按上一步开通即可
- 注意：待办需指定成员（钉钉 userid）；若未配 `DINGTALK_DEFAULT_USERID`，任务进入应用级待办，可能无人可见

**路径 B · 群机器人 Webhook（推荐，免审批，全组可见）**
- 在任意钉钉群 → 群设置 → 智能群助手 → 添加「自定义机器人」→ 拿到 Webhook 地址
- 启动时配置 `DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=xxx`
- 推送时把任务作为 markdown 卡片发到群里，全员可见，**无需任何权限审批**
- 这是最稳妥的「把任务关联到钉钉」方式；若「待办」能力未开通，推送会自动回退到这里

**路径 C · 无凭据回退**
- 都没配 → 前端自动「唤起钉钉 + 复制任务文本」，你在钉钉里粘贴即可手动建待办/日程

> 钉钉没有单独的「企业 API token」。企业内部应用就是用 `AppKey + AppSecret` 换 `access_token`，本服务已自动处理，你无需手动拿 token。

### 把工作台嵌进钉钉（让团队从钉钉里直接打开）

1. 准备一个**钉钉里能打开的链接**：
   - 想多人实时协作 → 把 `server.js` 部署到公网 Node 主机，拿到链接
   - 暂时只要能打开 → 部署 `public/` 静态版（CloudStudio 等）也能作为入口，但只是单机版
2. 钉钉开发者后台 → 你的应用 → **应用功能 / 工作台** → 设置「PC 端首页」与「移动端首页」为该链接
3. 「开发管理」里把该域名加入**可信域名 / 安全域名**白名单（否则钉钉内 WebView 会拦截）
4. 发布应用 → 员工在钉钉工作台即可看到并点开

示例（自动取 token + 群机器人启动）：

```bash
DINGTALK_APPKEY=你的AppKey \
DINGTALK_APPSECRET=你的AppSecret \
DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=xxx \
node server.js
```

## 二、一键部署到云端（Railway，推荐 · 免运维 · 自动 HTTPS）

Railway 是托管 Node 应用最简单的平台之一：GitHub 登录 → 上传代码 → 自动拿到公网 HTTPS 链接，钉钉群推送、多人协作全部打通。**免费额度够小团队用**。

### 第 1 步 · 准备代码仓库
1. 注册 GitHub（https://github.com），新建一个**空仓库**（如 `team-work-platform`）
2. 把本项目这几个文件上传到仓库根目录（可直接在 GitHub 网页拖拽，保留目录结构）：
   - `server.js`
   - `package.json`
   - `public/`（整个文件夹）
   - `railway.json`（已内置，可选）
   - **不要传 `.env` 和 `data/`**（已被忽略；`.env` 含密钥，绝不能上传到公开仓库）

### 第 2 步 · 部署
1. 打开 https://railway.app → 用 GitHub 登录
2. 「New Project」→「Deploy from GitHub repo」→ 选你的仓库
3. Railway 自动识别 Node，用 `npm start`（即 `node server.js`）启动
4. 稍等 1-2 分钟，点「View Logs」看到「已启动」即成功
5. 顶部「Settings → Domains」点「Generate Domain」，拿到形如 `https://xxx.up.railway.app` 的链接

### 第 3 步 · 配置钉钉凭据（关键）
1. 在 Railway 项目里点「Variables」→「New Variable」，逐个添加：
   - `DINGTALK_APPKEY` = 你的 AppKey
   - `DINGTALK_APPSECRET` = 你的 AppSecret
   - `DINGTALK_WEBHOOK` = 你的群机器人 Webhook 地址
   - （可选）`TEAM_KEY` = 一段自定义密码，开启后写操作需带该密钥（防乱改）
2. 添加变量后 Railway 会**自动重启**服务使变量生效
3. 打开上一步的链接 → 点任意任务的「同步到钉钉」→ 群里收到卡片即验证成功

### 第 4 步 · 给团队用
- 把 `https://xxx.up.railway.app` 发到钉钉群，大家浏览器打开即用
- 也可把此链接设成你钉钉应用的「首页地址」嵌进工作台（见下文「嵌进钉钉」）

### 备选 · 阿里云 / 腾讯云（需要自有备案域名时）
若要把应用**嵌进钉钉工作台**，钉钉要求首页域名已完成 ICP 备案。`xxx.up.railway.app` 是海外域名，可能不被钉钉信任；此时建议用阿里云/腾讯云轻量服务器 + 你自己的已备案域名，并用本项目附带的 `Dockerfile` 跑容器：
```bash
docker build -t team-app .
docker run -d -p 3000:3000 \
  -e DINGTALK_APPKEY=xxx -e DINGTALK_APPSECRET=xxx -e DINGTALK_WEBHOOK=xxx \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped team-app
```
再用 Nginx/Caddy 反代到你的备案域名（HTTPS）。这样钉钉工作台、任意地点访问、真·多人协作全通。

### 通用说明
- 本服务是标准 Node 应用，也支持 Render / Fly.io / VPS 等任意能跑 Node 的环境
- 启动命令 `node server.js`，监听 `process.env.PORT`（平台自动注入）
- 部署后前端自动走「实时协作」模式（顶栏显示绿色「实时协作」），任何人增删改任务，他人页面**秒级自动刷新**
- ⚠️ 数据持久化：Railway 免费版文件系统是临时的，**每次重新部署会清空 `data/`**。重要数据请定期用页面「导出 JSON」备份，或在 Railway 挂一个 Volume（设置 `DATA_DIR` 指向挂载目录）
- ⚠️ 静态托管（CloudStudio 等纯静态）**无法运行后端**，只能跑单机版；要多人协作必须用能跑 Node 进程的主机

## 三、只想要一个「钉钉/手机能打开」的链接（单机版）

若暂不需要后端，可直接把 `public/index.html` 作为静态站点部署（CloudStudio / 任意静态托管）。
打开后是「本地单机」模式：数据存在使用者各自浏览器本地，**不跨设备共享**，但界面、功能完全一致，适合个人或小范围演示。

## 四、数据备份与迁移

- 页面右上角「导出」可下载 JSON 备份
- 「导入」可恢复（多人模式会写回服务端）
- 多人模式数据落在服务端 `data/state.json`，定期备份该文件即可

## API 速览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/state` | 读取全部任务、成员与历史记录 |
| GET | `/api/events` | SSE 实时事件流 |
| POST | `/api/task` | 新增任务 |
| PUT | `/api/task/:id` | 更新任务（含 `comments` / `reminder` 字段；置为「已完成」会自动归档） |
| DELETE | `/api/task/:id` | 删除任务（删除已完成任务会先归档到历史） |
| POST | `/api/task/:id/dingtalk` | 推送任务到钉钉（body: `{"kind":"todo"|"cal"}`） |
| GET | `/api/history` | 读取历史记录 |
| DELETE | `/api/history/:id` | 删除某条历史记录 |
| POST | `/api/history/:id?restore` | 将历史记录恢复为「已完成」任务 |
| POST | `/api/member` | 新增成员 |
| DELETE | `/api/member/:id` | 删除成员 |
