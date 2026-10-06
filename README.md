# 同频 · Listen Together

一个可自行部署的网易云多人在线听歌室。房主扫码绑定网易云账号，服务端使用该账号的 Cookie 获取歌曲播放地址；成员无需登录网易云，即可加入房间、点歌、聊天和同步收听。

## 快速开始

需要 **Node.js 24.14+** 和 npm。使用 Node 内置 SQLite，不需要额外安装数据库。

```powershell
npm ci
npm run dev
```

打开 <http://localhost:5173>。默认使用真实网易云 API：

1. 创建房间并填写昵称，可选设置房间密码。
2. 房主点击「连接网易云」，使用网易云 App 扫码确认登录。
3. 搜索歌曲，或粘贴网易云歌曲链接 / 数字 ID。也支持导入歌单前 100 首。
4. 通过「邀请朋友」复制房间链接，成员输入昵称后加入。
5. 房主开始播放；每个浏览器第一次收听时点击「开启声音」。

前端开发端口为 `5173`，后端为 `3001`；Vite 代理 REST 和 Socket.IO 到后端。开发时请保持后端为 `3001`。需要让朋友访问本机时，将 `PUBLIC_ORIGIN` 配置为实际使用的局域网或公网来源。

## 无账号演示

```powershell
npm run demo
```

房主点击「连接音源」连接本地演示音源，搜索「推荐」，或添加歌曲 ID `1` 至 `6`。演示旋律由本地程序合成，用来验证同步、队列和聊天，不使用网易云账号、不宣称拥有会员歌曲播放权限。

默认真实模式使用 `data/`，演示模式使用 `data/demo/`，二者数据互相独立。如果手动设置 `DATA_DIR`，也请为不同模式使用独立目录。请先停止已运行的服务，再切换启动模式。

## 已实现功能

- 创建和邀请加入房间，可选房间密码；每个房间最多 50 名成员、200 首歌曲。
- 仅房主可以扫码登录、手动绑定 Cookie、切歌、暂停、拖动进度、删除歌曲和关闭房间。
- 所有成员都可以搜索、点歌、导入歌单、聊天和调整本机音量。
- 房间级凭据；服务端 AES-256-GCM 加密，二维码 key 和网易云 Cookie 不返回给浏览器。
- 服务端权威播放状态、计划执行时间、客户端时钟采样、播放速度微调与大偏差跳转。
- 后加入成员同步当前位置，断线自动重连；断线期间本机暂停，重连后恢复对齐。
- 服务端按歌曲时长自动切到队列下一首，末尾暂停；手动上一首 / 下一首循环选择。
- 歌词同步展示，桌面 / 窄屏布局，浏览器媒体会话信息。
- SQLite 持久化房间、成员、队列和聊天；后端重启后保留房间，播放暂停等待房主恢复。
- 拒绝仅试听或无播放权限的歌曲；音频 URL 按房间缓存并可刷新，关闭其他音源匹配。
- 默认以 30 秒为本机预缓冲目标；右下角「本机播放设置」可选择 15 / 30 / 60 秒，进度条和播放器显示实际连续缓存。

播放器在开始或断粮后先积累缓冲，恢复时再对齐房间进度。普通 `canplay` / `progress` 事件不再强制跳转；较小同步误差用平缓变速吸收，避免反复 seek 导致持续加载。浏览器可以限制自动预加载量：达不到目标时，等待 8 秒后允许使用至少 5 秒的缓存恢复；歌曲末尾按剩余长度判断。缓冲设置保存在本机浏览器，较长目标可能增加首次开始时的等待。

本机音量直接作用于当前音频元素，静音后取消静音会恢复之前的非零音量。右下角滑块提供较大的鼠标操作区域；窄屏可在「本机播放设置」调节音量。同一站点的另一个标签开启声音时，旧标签会停止本机收听，避免叠加播放。

默认请求网易云 `exhigh` 极高音质，目标码率为 320 kbps；最终返回的音质取决于歌曲音源和房主账号权限，实际码率、采样率和声道以具体文件为准。服务端使用房主凭据获取 CDN 地址，缓存的是地址及其过期时间；各浏览器独立从网易云 CDN 下载和缓冲音频。音频不经 Node 服务转发，房主浏览器也不负责上传或中继；WebSocket 仅同步房间状态和播放指令。

## 账号与会话

网易云凭据只用于对应房间。扫码成功后，服务端验证登录态并加密存储 Cookie，向页面仅返回昵称及会员状态。手动输入的 Cookie 只提交至本服务并随即清空输入，不写入 localStorage。

浏览器持有 `HttpOnly`、`SameSite=Lax` 的本应用会话 Cookie；REST 写入校验 CSRF 与来源，Socket.IO 握手校验会话、CSRF、来源及房间成员身份。昵称可以保存在 localStorage，那里不包含网易云登录凭据。

房主离开页面时房间和凭据保留，便于恢复；断开音乐账号会删除该房间凭据并暂停播放。关闭房间会清除房间、成员、聊天、凭据和缓存，并通知在线成员退出。房主身份绑定浏览器会话；首版不包含跨设备找回和房主转让，清除浏览器 Cookie 后无法恢复原房主身份。

本地首次启动会自动生成 `data/secrets.json`。**请保留数据库及密钥文件**，丢失密钥将无法解密已保存凭据；不要提交它们到 Git。生产环境需自己配置密钥，不会自动生成。

## 配置

可以复制 `.env.example` 为 `.env` 并按需要修改。所有环境变量仅在服务端读取。

| 变量 | 说明 |
| --- | --- |
| `MUSIC_PROVIDER` | `netease`（默认）或 `demo` |
| `HOST` / `PORT` | 后端监听地址及端口，默认 `0.0.0.0:3001` |
| `DATA_DIR` | SQLite 和本地开发密钥的存储目录 |
| `PUBLIC_ORIGIN` | 页面完整来源，含协议和端口；多个来源用逗号分隔 |
| `CREDENTIAL_KEY` | 随机 32 字节的 base64 编码，用于加密网易云 Cookie |
| `SESSION_SECRET` | 至少 32 字符随机字符串，用于会话请求校验 |
| `COOKIE_SECURE` | HTTPS 公网部署设为 `true`；本地 HTTP 访问设为 `false` |
| `TRUST_PROXY` | 仅在可信的单层反向代理之后设为 `true` |

可以分别运行下面的命令生成两个随机密钥，然后填入 `.env`；生成的值不要公开。

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## 构建和部署

```powershell
npm run build
npm start
```

构建后 Node 服务同时托管网页、REST 和 Socket.IO，通过 <http://localhost:3001> 访问。直接在本机运行时默认仍读取开发配置；公网部署请设置 `NODE_ENV=production`、两个密钥、实际 `PUBLIC_ORIGIN` 和 HTTPS Cookie 配置。

Docker Compose 部署：

```powershell
docker compose up -d --build
```

Compose 从 `.env` 读取必要密钥和公开来源，数据保存在命名卷 `listen-data`。HTTPS 反向代理需要透传 WebSocket 升级以及原始 Host，代理所有 `/api/*` 和 `/socket.io/*` 请求至同一个实例。

首版使用单个 Node 实例及 SQLite。多实例部署需要另行引入共享状态、Socket.IO adapter 和统一调度，不能直接横向复制当前实例。

## 验证

```powershell
npm run typecheck
npm test
npm run build
```

测试使用独立模拟音源及内存 SQLite，通过真实 HTTP / WebSocket 连接验证权限、扫码挑战绑定、凭据加密、房间隔离、同步控制、并发点歌、聊天及资源清理。不使用真实账号。

验证真实网易云生成二维码、匿名搜索及普通歌曲《Waves》的完整播放地址解析：

```powershell
npx tsx scripts/check-netease.ts
```

播放接口显式使用 SDK 支持的 `eapi` 协议。SDK 4.41 默认的 `xeapi` 依赖命令行初始化的公钥，模块调用时可能抛出 `xeapi public key is missing`；播放适配层避免这个依赖，仍按房主账号检查完整播放权限。接口检查只输出是否成功，不输出 Cookie 或音频签名地址。

扫码成功及会员歌曲完整播放仍需房主使用自己的账号实际验证。歌曲权限、地区限制及非官方 API 变化可能影响可用性。首次播放建议选择普通歌曲，随后验证该账号可完整播放的会员歌曲。

移动浏览器可能在锁屏或后台时暂停音频和网络；回到页面后会重新采样时钟并对齐进度。项目不承诺浏览器后台保持持续精确同步。

## 项目结构

```text
client/src/       React 页面、音频播放器、时钟同步
server/app.ts    REST / Socket.IO、会话、CSRF、二维码流程
server/rooms.ts  房间生命周期、播放队列、权威播放状态
server/music.ts  网易云接口适配和本地演示音源
server/repository.ts  SQLite 存储与 AES-GCM 凭据加密
shared/         前后端共享模型及播放时间计算
tests/          单元和 HTTP / WebSocket 集成测试
scripts/        开发启动与真实网易云接口检查
```

网易云接口依赖 [NeteaseCloudMusicApi Enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)。房间同步采用前述架构独立实现，没有复制 `music-together` 的项目源码。
