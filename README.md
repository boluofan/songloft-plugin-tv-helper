# 电视助手（tv-helper）

Songloft 宿主 JS 插件：嗅探局域网内的 [Songloft TV](https://github.com/boluofan/songloft-tv) Android 客户端，列表显示，输入电视屏幕上的配对码后**一键登录**（免输入账号密码）。

## 工作原理

插件界面分「广播发现」「主动嗅探」两个页签，两种模式各有独立开关（广播监听开关 / 嗅探心跳开关），**默认全部关闭**，需要手动开启；**切换页签时自动关闭老页签的开关**（进入新页签不会自动打开任何开关），状态持久化、宿主重启后自动恢复：

1. **广播发现**（默认）：TV 端打开「登录配置页」时，每 2 秒向局域网广播一次 UDP beacon（端口 18910），携带设备名 / IP / 配置端口 / 版本（**不携带配对码**），payload 为 **Base64 编码的 JSON**（保证中文设备名不乱码；宿主 UDP API 还会再包一层 base64）；插件监听 UDP 18910 收集 beacon，秒级发现所有停留在配置页的 TV。需电视与宿住在同一局域网且广播可达，页签内可手动停止/重新开启监听；
2. **主动嗅探**：广播不可达（电视与宿主不在同一局域网 / Docker bridge 网络 / AP 隔离）时，切换到该页签并点击「开始嗅探」开启**心跳扫描**：插件每 15 秒并发 GET 各网段 IP 的 `/probe` 接口（TV 端 v1.1.5+ 提供，与 beacon 同构的 JSON，默认端口 18899），网段留空时按宿主地址自动推导 /24，也可手动配置；嗅探到的设备与手动配对的设备一并显示；
3. 页面显示设备列表，用户点击「登录」并**手动输入电视屏幕上显示的 4 位配对码**（配对码由 TV 端生成，每 60 秒自动刷新）；
4. 插件使用宿主**插件专用永久 JWT**（`plugin.getToken()`）与宿主地址，向 TV 推送 `POST /push-token`。宿主地址自动提取，优先级：① 与 TV 同网段的宿主局域网 IP（保留宿主端口）→ ② 前端页面访问来源（通过公网域名/公网 IP 访问宿主时自动提取，如 `https://music.example.com:23456`，适用于电视与宿主不在同一局域网、宿主公网可达的场景）→ ③ 宿主第一个局域网地址 → ④ 原样（通常是 localhost，兜底）；
5. TV 校验配对码正确后写入服务器地址与 token，自动登录进入主界面。

## 使用

- 宿主版本：≥ v2.9.4（`net` 权限与 `songloft.net` UDP API 自此版本提供）
- TV 端版本：需支持 beacon 广播与 `/push-token` 端点（v1.1.5+）；主动嗅探需支持 `/probe` 端点（v1.1.5+）
- 构建：`npm install` → `npm run build`，产物 `dist/tv-helper.jsplugin.zip`
- 安装：宿主「插件管理」页上传 ZIP，或放入宿主 `data/jsplugins/` 目录后重启

流程：电视打开 app 停留在登录配置页（屏幕显示配对码）→ 宿主打开「电视助手」插件 → 默认「广播发现」页签列表显示（广播不可达时切到「主动嗅探」页签开启扫描）→ 点击目标设备「登录」→ 输入电视屏幕上的配对码 → 一键登录。

「广播发现」页签底部提供**广播日志**面板：实时滚动显示 UDP 18910 收到的每个数据包（时间 / 来源 / 解析结果 / 原始内容），解析失败也会记录，便于排查广播被防火墙拦截、协议不兼容等网络问题；向上滚动可暂停跟随，点「跟随」恢复。

## Docker 部署与网络要求

TV 发现依赖 **UDP 局域网广播**（18910 端口），配对时插件还会向 TV 推送**宿主局域网地址**。Docker 部署时网络模式决定这两点是否可用：

| 网络模式 | 广播可达 | 宿主地址自动检测 | 结论 |
|---------|---------|----------------|------|
| `host`（推荐） | ✅ | ✅ | 开箱即用 |
| `macvlan` / `ipvlan` | ✅ | ✅ | 容器直连局域网，可用 |
| `bridge` + `-p 18910:18910/udp` | ❌ | ❌ | **不可用**：Docker 端口映射不转发广播包，`getNetworkAddresses()` 也只返回容器网段地址 |

**为什么 `-p 18910:18910/udp` 不行**：Docker 的端口发布（docker-proxy）只转发发往宿主机 IP 的单播包，UDP 广播（`255.255.255.255` / 网段广播）不会进入容器。这是所有依赖发现协议（SSDP/UPnP 等）的容器应用都要求 host 网络的原因。

### 方案一：host 网络（推荐）

```yaml
services:
  songloft:
    image: your-songloft-image
    network_mode: host
    restart: unless-stopped
```

### 方案二：macvlan（容器直连局域网，兼有隔离性）

```yaml
services:
  songloft:
    image: your-songloft-image
    networks:
      lan:
        ipv4_address: 192.168.1.100   # 换成局域网内空闲 IP
networks:
  lan:
    driver: macvlan
    driver_opts:
      parent: eth0                   # 宿主机上网卡名
    ipam:
      config:
        - subnet: 192.168.1.0/24     # 与局域网一致
          gateway: 192.168.1.1
```

macvlan 下容器相当于局域网内一台独立设备，广播与地址检测均正常。注意宿主机与 macvlan 容器默认互访受限，如需互访请配合 `macvlan` + host 侧虚拟网卡或改用 `ipvlan`。

### 方案三：bridge + 广播中继 + 插件手动配置（无法改网络时）

1. 映射 HTTP 端口供 TV 访问宿主：`-p 58091:58091`（容器内宿主端口按实际调整）；
2. 在**宿主机**上运行 socat 把局域网广播转发进容器：

```bash
# 宿主机执行：把 UDP 18910 广播转发到容器 IP
socat -d -d UDP4-RECVFROM:18910,broadcast,fork UDP4-SENDTO:172.17.0.2:18910
```

3. 打开插件页面，在「嗅探配置」卡片里**配置嗅探网段**（如 `192.168.1.0/24`，bridge 下自动检测不到局域网网段；插件每 15 秒扫描一次，找到 TV 会带「嗅探」标记），或在「手动配对」里输入电视 IP:端口点**探测**，成功即自动加入列表；
4. 宿主地址在推送时自动提取（同网段局域网 IP 优先，公网访问时用页面访问来源），无需手动配置。

> 手动添加的设备与嗅探配置持久化保存；配对流程与自动发现完全一致（电视端仍需停留在登录配置页显示配对码）。

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
