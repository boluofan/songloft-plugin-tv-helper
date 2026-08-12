# 电视助手（tv-helper）

Songloft 宿主 JS 插件：嗅探局域网内的 [Songloft TV](https://github.com/boluofan/songloft-tv) Android 客户端，列表显示，输入电视屏幕上的配对码后**一键登录**（免输入账号密码）。

## 工作原理

1. TV 端打开「登录配置页」时，每 2 秒向局域网广播一次 UDP beacon（端口 18910），携带设备名 / IP / 配置端口 / 版本（**不携带配对码**），payload 为 **Base64 编码的 JSON**（保证中文设备名不乱码；宿主 UDP API 还会再包一层 base64）；
2. 插件监听 UDP 18910 收集 beacon，秒级发现所有停留在配置页的 TV；
3. 页面显示设备列表，用户点击「登录」并**手动输入电视屏幕上显示的 4 位配对码**（配对码由 TV 端生成，每 60 秒自动刷新）；
4. 插件使用宿主**插件专用永久 JWT**（`plugin.getToken()`）与宿主局域网地址，向 TV 推送 `POST /push-token`；
5. TV 校验配对码正确后写入服务器地址与 token，自动登录进入主界面。

## 使用

- 宿主版本：≥ v2.9.4（`net` 权限与 `songloft.net` UDP API 自此版本提供）
- TV 端版本：需支持 beacon 广播与 `/push-token` 端点（v1.1.5+）
- 构建：`npm install` → `npm run build`，产物 `dist/tv-helper.jsplugin.zip`
- 安装：宿主「插件管理」页上传 ZIP，或放入宿主 `data/jsplugins/` 目录后重启

流程：电视打开 app 停留在登录配置页（屏幕显示配对码）→ 宿主打开「电视助手」插件 → 点击目标设备「登录」→ 输入电视屏幕上的配对码 → 一键登录。

页面底部提供**广播日志**面板：实时滚动显示 UDP 18910 收到的每个数据包（时间 / 来源 / 解析结果 / 原始内容），解析失败也会记录，便于排查广播被防火墙拦截、协议不兼容等网络问题；向上滚动可暂停跟随，点「跟随」恢复。

## 权限

- `net`：UDP 监听（发现 beacon）
- `storage`：保存最近登录过的设备列表（不保存配对码）

## 已知限制

1. **宿主重启后需重新配对**：插件 token 由宿主启动时生成，重启后重新签发，TV 端旧 token 失效回到配置页，重新点一次一键登录即可；
2. **仅发现停留在配置页的 TV**：已登录 TV 不会广播 beacon（后续版本可做常驻广播）；
3. **AP 隔离 / 防火墙阻断广播时发现失败**：请确认电视与宿住在同一局域网且未开 AP 隔离；
4. **配对码防护等级 =「用户在场确认」**：配对码不出现在广播中、由用户对照 TV 屏幕手动输入，且每 60 秒自动刷新，防止局域网内其他设备趁配置页开放时劫持登录；TV 端配置页本身对局域网开放是既有设计。

## 发布

一键发布脚本：`./scripts/bump-version.sh [release|major|minor|patch] [--dry-run]`

- `patch` / `minor` / `major`：按语义化版本升级（`0.1.0 -> 0.1.1 / 0.2.0 / 1.0.0`，默认 `patch`）
- `release`：去掉预发布后缀正式发布（`0.1.0-beta.2 -> 0.1.0`）
- `--dry-run`：仅预览将执行的操作，不修改任何文件

脚本会自动同步 `package.json` / `package-lock.json` / `plugin.json` 三个文件的版本号，随后 commit、创建 `vX.Y.Z` tag 并 `git push --follow-tags`。推送 tag 后由 `.github/workflows/release.yml` 自动完成构建、GitHub Release，并把 `download_url` / `updateUrl` 回写到 main 分支的 `plugin.json`。

示例：

```bash
./scripts/bump-version.sh patch            # 0.1.0 -> 0.1.1 并发布
./scripts/bump-version.sh minor --dry-run  # 仅预览，不修改
./scripts/bump-version.sh --help           # 查看完整帮助
```

## 开发

```
src/
├── main.ts              # 入口钩子 onInit / onHTTPRequest / onDeinit
├── types.ts             # 设备类型
├── services/discovery.ts # UDP beacon 监听 + 设备注册表（TTL 30s）+ 历史设备
└── handlers/router.ts   # /api/devices、/api/login
static/                  # 插件页面（common.js 自动注入主题与 API）
```

本地验证：`npm run validate` 校验 manifest，`npm run build` 产出 ZIP。
