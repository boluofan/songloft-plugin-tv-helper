import { createRouter, jsonResponse } from '@songloft/plugin-sdk';
import type { HTTPRequest, Router } from '@songloft/plugin-sdk';
import type { DiscoveryService } from '../services/discovery';

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

export function registerHandlers(router: Router, discovery: DiscoveryService): void {
  router.get('/api/devices', async () => {
    const [online, history] = await Promise.all([discovery.listOnline(), discovery.listHistory()]);
    return jsonResponse({
      success: true,
      listening: discovery.isListening(),
      data: { online, history },
    });
  });

  router.post('/api/login', async (req: HTTPRequest) => {
    const body = parseBody(req);
    const ip = String(body.ip || '').trim();
    const port = Number(body.port);
    const pin = String(body.pin || '').trim();
    if (!ip || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return jsonResponse({ success: false, message: '参数缺失：需要 ip / port' });
    }
    if (!pin) {
      return jsonResponse({ success: false, message: '请填写电视屏幕显示的配对码' });
    }
    // 只允许登录当前在线设备，防止把插件当代理去推任意内网地址
    const dev = discovery.listOnline().find((d) => d.ip === ip && d.port === port);
    if (!dev) {
      return jsonResponse({ success: false, message: '设备不在线，请确认电视停留在登录配置页后刷新列表' });
    }
    try {
      const token = await songloft.plugin.getToken();
      const urls = await songloft.plugin.getNetworkAddresses();
      const server = Array.isArray(urls) ? urls[0] : '';
      if (!server) {
        return jsonResponse({ success: false, message: '无法获取宿主局域网地址，请检查宿主网络' });
      }
      const resp = await fetch(`http://${ip}:${port}/push-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `server=${encodeURIComponent(server)}&token=${encodeURIComponent(token)}&pin=${encodeURIComponent(pin)}`,
      });
      const text = await resp.text();
      let data: { success?: boolean; message?: string } = {};
      try {
        data = JSON.parse(text);
      } catch {
        // 非 JSON 响应按 HTTP 状态判断
      }
      const ok = resp.ok && data.success !== false;
      if (ok) await discovery.touchHistory(ip, port);
      return jsonResponse({ success: ok, message: data.message || (ok ? '已发送，电视端正在登录' : `HTTP ${resp.status}`) });
    } catch (e) {
      return jsonResponse({ success: false, message: `推送失败: ${String(e)}` });
    }
  });
}
