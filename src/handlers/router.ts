import { createRouter, jsonResponse, parseQuery } from '@songloft/plugin-sdk';
import type { HTTPRequest, Router } from '@songloft/plugin-sdk';
import type { DiscoveryService } from '../services/discovery';
import { fetchWithTimeout } from '../utils';

/** 解析请求体（兼容 Uint8Array 和 string） */
function parseBody(req: HTTPRequest): any {
  if (!req.body) return {};
  try {
    const str = typeof req.body === 'string'
      ? req.body
      : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array));
    return JSON.parse(str);
  } catch {
    return {};
  }
}

/** 判断两个 IPv4 是否同网段（前三段相同）；非 IPv4 视为不匹配（忽略端口） */
function sameSubnet(a: string, b: string): boolean {
  const pa = a.replace(/:\d+$/, '').split('.');
  const pb = b.replace(/:\d+$/, '').split('.');
  return pa.length === 4 && pb.length === 4 && pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2];
}

/** 判断 URL 是否可作为公网宿主地址（域名或公网 IP，排除回环/内网地址） */
function isValidPublicUrl(url: string): boolean {
  if (!/^https?:\/\/[^/]+$/i.test(url)) return false;
  const host = url.replace(/^https?:\/\//i, '').split(':')[0].toLowerCase();
  if (!host || host === 'localhost' || host.startsWith('127.') || host === '::1') return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some((p) => p > 255)) return false;
    return !(parts[0] === 10
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
  }
  return true; // 域名
}

/** 校验 IPv4 地址格式 */
function isValidIp(ip: string): boolean {
  const parts = ip.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** 归一化：折叠重复的协议前缀（如 http://http://ip:port → http://ip:port） */
function normalizeServerUrl(url: string): string {
  return url.replace(/^(https?:\/\/)+/i, '$1');
}

/** getNetworkAddresses 可能返回裸 IP，也可能带协议/端口（如 http://192.168.1.2:58091）；统一成 host[:port] */
function toHostPort(addr: string, hostUrl: string): string {
  let a = normalizeServerUrl(addr).replace(/^https?:\/\//i, '');
  if (!/:\d+$/.test(a)) {
    const port = hostUrl.match(/^https?:\/\/[^/]+:(\d+)/);
    if (port) a += `:${port[1]}`;
  }
  return a;
}

/**
 * 计算推送给 TV 的宿主地址（必须是带协议和端口的完整 URL，否则 TV 端 Retrofit 初始化会失败），优先级：
 * 1. 与 TV 同网段的宿主局域网地址；2. 前端页面访问来源（公网域名/公网 IP，如 https://music.example.com:23456，宿主公网访问时自动提取）；
 * 3. 宿主第一个局域网地址；4. 原样返回（通常是 localhost，最后兜底）。
 */
async function resolvePushServer(
  hostUrl: string,
  tvIp: string,
  publicOrigin: string
): Promise<string> {
  const norm = normalizeServerUrl(hostUrl);
  const host = (norm.match(/^https?:\/\/([^/:]+)/) || [])[1] || '';
  const isLoopback = host === 'localhost' || host.startsWith('127.') || host === '::1';
  if (!isLoopback) return norm;
  const addrs = await songloft.plugin.getNetworkAddresses();
  const lanHosts = addrs.map((a) => toHostPort(a, norm));
  const lanIp = lanHosts.find((a) => sameSubnet(a, tvIp));
  if (lanIp) return norm.replace(/^(\w+:\/\/)[^/]+/, `$1${lanIp}`);
  if (isValidPublicUrl(publicOrigin)) return normalizeServerUrl(publicOrigin);
  const first = lanHosts[0];
  if (first) return norm.replace(/^(\w+:\/\/)[^/]+/, `$1${first}`);
  return norm;
}

export function registerHandlers(router: Router, discovery: DiscoveryService): void {
  router.get('/api/devices', async () => {
    const [online, history, manual, config] = await Promise.all([
      discovery.listOnline(),
      discovery.listHistory(),
      discovery.listManual(),
      discovery.getConfig(),
    ]);
    const manualDevices = manual.map((m) => ({
      ip: m.ip,
      port: m.port,
      name: m.name,
      version: '',
      lastSeen: m.addedAt,
      manual: true,
    }));
    // 统一设备列表：手动 + 在线 按 ip:port 去重（手动条目优先），按 lastSeen 倒序
    const devices = [...manualDevices, ...online]
      .filter((d, i, arr) => arr.findIndex((x) => x.ip === d.ip && x.port === d.port) === i)
      .sort((a, b) => b.lastSeen - a.lastSeen);
    return jsonResponse({
      success: true,
      listening: discovery.isListening(),
      scanning: discovery.isScanEnabled(),
      scanInfo: discovery.getScanInfo(),
      scanProgress: discovery.getScanProgress(),
      data: { devices, history, config },
    });
  });

  router.post('/api/scan/start', async () => {
    await discovery.setScanEnabled(true);
    return jsonResponse({ success: true, message: '嗅探已开启，正在扫描局域网…' });
  });

  router.post('/api/scan/stop', async () => {
    await discovery.setScanEnabled(false);
    return jsonResponse({ success: true, message: '嗅探已停止' });
  });

  router.post('/api/listen/start', async () => {
    await discovery.setListening(true);
    return jsonResponse({
      success: true,
      listening: discovery.isListening(),
      message: discovery.isListening() ? '监听已开启' : '监听开启失败，请检查 UDP 18910 端口占用',
    });
  });

  router.post('/api/listen/stop', async () => {
    await discovery.setListening(false);
    return jsonResponse({ success: true, listening: false, message: '监听已停止' });
  });

  router.post('/api/probe', async (req: HTTPRequest) => {
    const body = parseBody(req);
    const ip = String(body.ip || '').trim();
    const port = Number(body.port);
    if (!isValidIp(ip) || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return jsonResponse({ success: false, message: '请输入合法的 IP 与端口' });
    }
    const startedAt = Date.now();
    try {
      const { status, text } = await fetchWithTimeout(`http://${ip}:${port}/probe`, 3000);
      let device: { ip: string; port: number; name: string } | null = null;
      if (status === 200) {
        try {
          const data = JSON.parse(text) as { app?: string; name?: string; ip?: string; port?: number };
          if (data && data.app === 'songloft-tv') {
            device = {
              ip: String(data.ip || ip),
              port: Number(data.port) || port,
              name: String(data.name || 'Songloft TV'),
            };
            // 探测成功即加入手动设备（持久化），与手动配对等价
            await discovery.addManual(device.ip, device.port, device.name);
          }
        } catch {
          // 响应非 JSON，视为非 TV，device 保持 null
        }
      }
      return jsonResponse({
        success: true,
        data: {
          httpStatus: status,
          body: text.slice(0, 500),
          elapsedMs: Date.now() - startedAt,
          device,
          added: !!device,
        },
      });
    } catch (e) {
      return jsonResponse({
        success: true,
        data: { error: String(e), elapsedMs: Date.now() - startedAt },
      });
    }
  });

  router.post('/api/devices/manual', async (req: HTTPRequest) => {
    const body = parseBody(req);
    const ip = String(body.ip || '').trim();
    const port = Number(body.port);
    const name = String(body.name || '').trim() || 'Songloft TV（手动）';
    if (!isValidIp(ip) || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return jsonResponse({ success: false, message: '请输入合法的 IP 与端口' });
    }
    await discovery.addManual(ip, port, name);
    return jsonResponse({ success: true, message: '已添加' });
  });

  router.post('/api/devices/manual/remove', async (req: HTTPRequest) => {
    const body = parseBody(req);
    const ip = String(body.ip || '').trim();
    const port = Number(body.port);
    await discovery.removeManual(ip, port);
    return jsonResponse({ success: true });
  });

  router.post('/api/devices/remove', async (req: HTTPRequest) => {
    const body = parseBody(req);
    const ip = String(body.ip || '').trim();
    const port = Number(body.port);
    await discovery.removeDevice(ip, port);
    return jsonResponse({ success: true });
  });

  router.post('/api/config', async (req: HTTPRequest) => {
    const body = parseBody(req);
    const scanCidr = String(body.scanCidr || '').trim();
    const scanPort = Number(body.scanPort);
    if (scanCidr) {
      const parts = scanCidr.split(',').map((s) => s.trim()).filter(Boolean);
      const valid = parts.every((c) => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(c));
      if (!valid || !parts.length) {
        return jsonResponse({ success: false, message: '嗅探网段格式应为 CIDR，如 192.168.1.0/24（多个用逗号分隔）' });
      }
    }
    if (!Number.isInteger(scanPort) || scanPort < 0 || scanPort > 65535) {
      return jsonResponse({ success: false, message: '嗅探端口不合法' });
    }
    const prev = await discovery.getConfig();
    await discovery.saveConfig({ ...prev, hostAddr: '', scanCidr, scanPort: scanPort || prev.scanPort });
    return jsonResponse({ success: true, message: '已保存' });
  });

  router.get('/api/logs', async (req: HTTPRequest) => {
    const q = parseQuery(req.query);
    const after = Number(q.after);
    return jsonResponse({
      success: true,
      logs: discovery.listLogs(Number.isFinite(after) && after > 0 ? after : 0),
    });
  });

  router.post('/api/login', async (req: HTTPRequest) => {
    const body = parseBody(req);
    const ip = String(body.ip || '').trim();
    const port = Number(body.port);
    const pin = String(body.pin || '').trim();
    const origin = String(body.origin || '').trim();
    if (!ip || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return jsonResponse({ success: false, message: '参数缺失：需要 ip / port' });
    }
    if (!pin) {
      return jsonResponse({ success: false, message: '请填写电视屏幕显示的配对码' });
    }
    // 只允许登录在线设备（含手动添加的），防止把插件当代理去推任意内网地址
    const onlineDevs = discovery.listOnline();
    const manualDevs = await discovery.listManual();
    const dev = onlineDevs.find((d) => d.ip === ip && d.port === port)
      || manualDevs.find((d) => d.ip === ip && d.port === port);
    if (!dev) {
      return jsonResponse({ success: false, message: '设备不在线，请确认电视停留在登录配置页后刷新列表' });
    }
    try {
      const token = await songloft.plugin.getToken();
      const server = await songloft.plugin.getHostUrl();
      if (!server) {
        return jsonResponse({ success: false, message: '无法获取宿主地址，请检查宿主网络' });
      }
      // 同网段局域网地址优先；自动检测不可用时用前端页面访问来源（公网域名/公网 IP）
      const pushServer = await resolvePushServer(server, ip, origin);
      const url = `http://${ip}:${port}/push-token`;
      const body = `server=${encodeURIComponent(pushServer)}&token=${encodeURIComponent(token)}&pin=${encodeURIComponent(pin)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const text = await resp.text();
      let data: { success?: boolean; message?: string } = {};
      try {
        data = JSON.parse(text);
      } catch {
        // 非 JSON 响应按 HTTP 状态判断
      }
      const ok = resp.ok && data.success !== false;
      if (ok && onlineDevs.some((d) => d.ip === ip && d.port === port)) {
        await discovery.touchHistory(ip, port);
      }
      return jsonResponse({ success: ok, message: data.message || (ok ? '已发送，电视端正在登录' : `HTTP ${resp.status}`) });
    } catch (e) {
      return jsonResponse({ success: false, message: `推送失败: ${String(e)}` });
    }
  });
}
