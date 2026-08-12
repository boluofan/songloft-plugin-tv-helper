import type { BeaconLog, HistoryDevice, ManualDevice, PluginConfig, ScanProgress, ScanSummary, TvDevice } from '../types';
import { fetchWithTimeout } from '../utils';

const BEACON_PORT = 18910;
const DEVICE_TTL_MS = 30_000;
const PRUNE_INTERVAL_MS = 5_000;
const HISTORY_KEY = 'tv_history';
const HISTORY_LIMIT = 20;
const MANUAL_KEY = 'tv_manual_devices';
const CONFIG_KEY = 'tv_config';
const MANUAL_LIMIT = 20;
const LOG_LIMIT = 300;
const LOG_FETCH_MAX = 100;
const RAW_TRUNCATE = 200;
const SCAN_INTERVAL_MS = 15_000;
// 局域网内无响应 IP 的 TCP 连接在此超时后即放弃；可达设备响应通常 <50ms
const SCAN_TIMEOUT_MS = 400;
const SCAN_CONCURRENCY = 128;
const DEFAULT_SCAN_PORT = 18899;

/** CIDR 转待扫描 IP 列表（仅支持 /24 及更小范围，即最多 254 个主机地址；去掉网络号与广播地址） */
function cidrIps(cidr: string): string[] {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return [];
  const host = (Number(m[1]) << 24 | Number(m[2]) << 16 | Number(m[3]) << 8 | Number(m[4])) >>> 0;
  const prefix = Number(m[5]);
  // 地址总数 = 2^(32-prefix)；/24 为 256（254 个主机），比 /24 更大的网段拒绝扫描
  const count = prefix >= 32 ? 0 : 1 << (32 - prefix);
  if (count > 256) return [];
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const base = (host & mask) >>> 0;
  const ips: string[] = [];
  for (let i = 1; i < count - 1; i++) {
    const v = (base + i) >>> 0;
    ips.push(`${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`);
  }
  return ips;
}

/**
 * TV 发现服务：监听 UDP 18910 收集 TV 配置页广播的 beacon，
 * 维护在线设备注册表（TTL 30s）与最近设备历史（storage，不存 pin）。
 */
export class DiscoveryService {
  private socketId: string | null = null;
  private readonly devices = new Map<string, TvDevice>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private listening = false;
  private lastScan: ScanSummary | null = null;
  private scanProgress: ScanProgress | null = null;
  private readonly logs: BeaconLog[] = [];
  private logSeq = 0;

  async init(): Promise<void> {
    this.timer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    // UDP 广播监听按配置恢复（默认开启，广播为默认模式）；主动嗅探按配置恢复（默认关闭）
    await this.applyListenState();
    await this.applyScanState();
  }

  isListening(): boolean {
    return this.listening;
  }

  /** 开启/关闭 UDP 广播监听（广播发现开关），状态持久化用于重启恢复 */
  async setListening(enabled: boolean): Promise<void> {
    if (enabled && !this.listening) {
      await this.startListening();
    } else if (!enabled && this.listening) {
      await this.stopListening();
    }
    const cfg = await this.getConfig();
    if (cfg.listenEnabled !== enabled) {
      await this.saveConfig({ ...cfg, listenEnabled: enabled });
    }
  }

  private async startListening(): Promise<void> {
    try {
      const info = await songloft.net.udpBind({ address: `:${BEACON_PORT}` });
      this.socketId = info.socketId;
      songloft.net.onData(this.socketId, (event: unknown) => this.onBeacon(event));
      this.listening = true;
      songloft.log.info(`[tv-helper] 已监听 UDP ${BEACON_PORT}，等待电视 beacon`);
    } catch (e) {
      this.listening = false;
      songloft.log.error(`[tv-helper] 监听 UDP ${BEACON_PORT} 失败: ${String(e)}`);
    }
  }

  private async stopListening(): Promise<void> {
    if (this.socketId) {
      try {
        await songloft.net.udpClose(this.socketId);
      } catch (e) {
        songloft.log.warn(`[tv-helper] 关闭 UDP socket 失败: ${String(e)}`);
      }
      this.socketId = null;
    }
    this.listening = false;
  }

  /** 按配置恢复 UDP 广播监听（listenEnabled 默认 true） */
  private async applyListenState(): Promise<void> {
    const cfg = await this.getConfig();
    if (cfg.listenEnabled) {
      await this.startListening();
    }
  }

  /** 嗅探开关状态（心跳扫描是否在运行） */
  isScanEnabled(): boolean {
    return this.scanTimer !== null;
  }

  /** 开启/关闭主动嗅探（心跳开关），开启时立即扫描一次；运行时状态由内存决定，持久化仅用于重启恢复 */
  async setScanEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      this.startScanLoop();
    } else {
      this.stopScanLoop();
    }
    const cfg = await this.getConfig();
    if (cfg.scanEnabled !== enabled) {
      await this.saveConfig({ ...cfg, scanEnabled: enabled });
    }
  }

  private startScanLoop(): void {
    if (this.scanTimer) return;
    void this.scan();
    this.scanTimer = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
    songloft.log.info('[tv-helper] 主动嗅探已开启');
  }

  private stopScanLoop(): void {
    if (!this.scanTimer) return;
    clearInterval(this.scanTimer);
    this.scanTimer = null;
    songloft.log.info('[tv-helper] 主动嗅探已停止');
  }

  /** 按配置的 scanEnabled 恢复嗅探心跳扫描（仅 init 时调用） */
  private async applyScanState(): Promise<void> {
    const cfg = await this.getConfig();
    if (cfg.scanEnabled) {
      this.startScanLoop();
    } else {
      this.stopScanLoop();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopScanLoop();
    await this.stopListening();
  }

  private onBeacon(event: unknown): void {
    const ev = (event || {}) as { Data?: string; data?: string; RemoteAddr?: string; remoteAddr?: string };
    const b64 = ev.Data || ev.data || '';
    const from = ev.RemoteAddr || ev.remoteAddr || '';
    if (!b64) {
      this.addLog({ ok: false, from, raw: '', error: '空数据包' });
      return;
    }
    try {
      const raw = this.decodeBeacon(b64);
      const data = JSON.parse(raw) as {
        app?: string;
        name?: string;
        ip?: string;
        port?: number;
        version?: string;
      };
      if (data.app !== 'songloft-tv' || !data.ip || !data.port) {
        this.addLog({ ok: false, from, raw: this.truncate(raw), error: '非 songloft-tv 广播' });
        return;
      }
      const key = `${data.ip}:${data.port}`;
      this.devices.set(key, {
        ip: data.ip,
        port: Number(data.port),
        name: String(data.name || 'Songloft TV'),
        version: String(data.version || ''),
        lastSeen: Date.now(),
        source: 'beacon',
      });
      this.addLog({
        ok: true,
        from,
        name: String(data.name || 'Songloft TV'),
        ip: data.ip,
        port: Number(data.port),
        version: String(data.version || ''),
        raw: this.truncate(raw),
      });
    } catch (e) {
      this.addLog({ ok: false, from, raw: '', error: String(e) });
    }
  }

  /** 解码 beacon：宿主 UDP API 对原始字节再包一层 base64，协议层为 base64 编码的 JSON；旧版 TV 为明文 JSON，解码失败时回退 */
  private decodeBeacon(b64: string): string {
    const toUtf8 = (s: string) => new TextDecoder('utf-8').decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
    const layer1 = atob(b64);
    try {
      const utf8 = toUtf8(atob(layer1));
      JSON.parse(utf8);
      return utf8;
    } catch {
      return toUtf8(layer1);
    }
  }

  private truncate(s: string, n = RAW_TRUNCATE): string {
    return s.length > n ? `${s.slice(0, n)}…` : s;
  }

  private addLog(entry: Omit<BeaconLog, 'id' | 'ts'>): void {
    this.logs.push({ id: ++this.logSeq, ts: Date.now(), ...entry });
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
  }

  /** 增量拉取广播日志（id > afterId；afterId <= 0 返回最近 LOG_FETCH_MAX 条） */
  listLogs(afterId: number): BeaconLog[] {
    if (afterId <= 0) return this.logs.slice(-LOG_FETCH_MAX);
    const idx = this.logs.findIndex((l) => l.id > afterId);
    if (idx < 0) return [];
    return this.logs.slice(idx, idx + LOG_FETCH_MAX);
  }

  private prune(): void {
    const cutoff = Date.now() - DEVICE_TTL_MS;
    for (const [key, dev] of this.devices) {
      if (dev.lastSeen < cutoff) this.devices.delete(key);
    }
  }

  /** 在线设备（配对码不上广播，由用户对照 TV 屏幕手动输入） */
  listOnline(): TvDevice[] {
    this.prune();
    return [...this.devices.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** 主动嗅探：并发 GET 各网段 IP 的 /probe 接口，发现广播不可达的 TV（Docker 非 host 网络 / AP 隔离等）。
   *  fetch 本身即「TCP 连上才发请求」，不可达 IP 靠 SCAN_TIMEOUT_MS 快速放弃，一轮通常 1~2 秒完成 */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    const startedAt = Date.now();
    try {
      const cfg = await this.getConfig();
      const port = cfg.scanPort > 0 ? cfg.scanPort : DEFAULT_SCAN_PORT;
      const subnets = await this.scanSubnets(cfg);
      const ips: string[] = [];
      for (const subnet of subnets) {
        ips.push(...cidrIps(subnet));
      }
      let found = 0;
      let httpOnly = 0;
      for (let i = 0; i < ips.length; i += SCAN_CONCURRENCY) {
        const batch = ips.slice(i, i + SCAN_CONCURRENCY);
        this.scanProgress = { done: i, total: ips.length, currentIp: batch[0] };
        const results = await Promise.all(batch.map((ip) => this.probe(ip, port)));
        for (const r of results) {
          if (!r) continue;
          if (r.device) {
            this.registerScanned(r.device);
            found++;
          } else if (r.http) {
            httpOnly++;
          }
        }
      }
      this.scanProgress = null;
      this.lastScan = { ts: Date.now(), subnets, total: ips.length, found, httpOnly, durationMs: Date.now() - startedAt };
      // 未发现 TV 时给出诊断提示，避免静默失败
      if (found === 0) {
        const reason = httpOnly > 0
          ? `有 ${httpOnly} 台设备响应 HTTP 但没有 /probe 端点（TV 端需 v1.1.5+，或端口不是 ${port}）`
          : '网段内无 HTTP 响应（检查网段配置；TV 需停留在登录配置页）';
        songloft.log.info(`[tv-helper] 本轮嗅探 ${subnets.join(',')}（${ips.length} 个 IP）未发现 TV：${reason}`);
      }
    } catch (e) {
      songloft.log.warn(`[tv-helper] 嗅探扫描失败: ${String(e)}`);
    } finally {
      this.scanning = false;
      this.scanProgress = null;
    }
  }

  /** 最近一轮扫描的统计（界面诊断用） */
  getScanInfo(): ScanSummary | null {
    return this.lastScan;
  }

  /** 当前扫描进度（扫描进行中时非空） */
  getScanProgress(): ScanProgress | null {
    return this.scanProgress;
  }

  /** 扫描网段：优先用户配置（逗号分隔 CIDR），否则按宿主地址推导 /24 */
  private async scanSubnets(cfg: PluginConfig): Promise<string[]> {
    if (cfg.scanCidr) {
      return cfg.scanCidr.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const addrs = await songloft.plugin.getNetworkAddresses();
    const seen = new Set<string>();
    for (const a of addrs) {
      // getNetworkAddresses 可能返回裸 IP 或带协议/端口（http://192.168.1.2:58091）
      const ip = a.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
      const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
      if (m) seen.add(`${m[1]}.${m[2]}.${m[3]}.0/24`);
    }
    return [...seen];
  }

  /** 探测单台 TV：GET /probe（TV 配置页 Web 服务提供，与 beacon 同构的 JSON）；http=true 表示端口上有 HTTP 服务但非 TV 或版本过低 */
  private async probe(ip: string, port: number): Promise<{ device: TvDevice | null; http: boolean }> {
    try {
      const { status, text } = await fetchWithTimeout(`http://${ip}:${port}/probe`, SCAN_TIMEOUT_MS);
      if (status !== 200) return { device: null, http: true };
      const data = JSON.parse(text) as {
        app?: string;
        name?: string;
        ip?: string;
        port?: number;
        version?: string;
      };
      if (data.app !== 'songloft-tv') return { device: null, http: true };
      return {
        device: {
          ip: String(data.ip || ip),
          port: Number(data.port) || port,
          name: String(data.name || 'Songloft TV'),
          version: String(data.version || ''),
          lastSeen: Date.now(),
          source: 'scan',
        },
        http: true,
      };
    } catch {
      return { device: null, http: false };
    }
  }

  private registerScanned(dev: TvDevice): void {
    const key = `${dev.ip}:${dev.port}`;
    const prev = this.devices.get(key);
    // 同一设备若已被 beacon 发现，保留 beacon 数据（信息更可靠）
    const fresh: TvDevice = {
      ...dev,
      source: prev && prev.source === 'beacon' ? ('beacon' as const) : ('scan' as const),
    };
    const isNew = !prev || prev.lastSeen < Date.now() - DEVICE_TTL_MS;
    this.devices.set(key, fresh);
    if (isNew) {
      this.addLog({
        ok: true,
        from: `${dev.ip}:${dev.port}`,
        name: dev.name,
        ip: dev.ip,
        port: dev.port,
        version: dev.version,
        raw: 'probe',
      });
    }
  }

  /** 历史设备（无 pin），合并在线状态 */
  async listHistory(): Promise<HistoryDevice[]> {
    const online = new Set(this.listOnline().map((d) => `${d.ip}:${d.port}`));
    const history = await this.loadHistory();
    return history.map((d) => ({
      ...d,
      online: online.has(`${d.ip}:${d.port}`),
    }));
  }

  /** 记录一次登录行为（更新历史设备的上次活跃时间） */
  async touchHistory(ip: string, port: number): Promise<void> {
    const online = this.listOnline().find((d) => d.ip === ip && d.port === port);
    if (!online) return;
    const history = await this.loadHistory();
    const idx = history.findIndex((d) => d.ip === ip && d.port === port);
    const entry: HistoryDevice = {
      ip,
      port,
      name: online.name,
      version: online.version,
      lastSeen: Date.now(),
      online: true,
    };
    if (idx >= 0) history.splice(idx, 1);
    history.unshift(entry);
    await this.saveHistory(history.slice(0, HISTORY_LIMIT));
  }

  private async loadHistory(): Promise<HistoryDevice[]> {
    const parsed = await this.loadJson<HistoryDevice[]>(HISTORY_KEY);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d: HistoryDevice) => d && typeof d.ip === 'string' && typeof d.port === 'number'
    );
  }

  private async saveHistory(list: HistoryDevice[]): Promise<void> {
    await this.saveJson(HISTORY_KEY, list);
  }

  /** 手动添加的设备列表（广播不可达场景的兜底，持久化） */
  async listManual(): Promise<ManualDevice[]> {
    const parsed = await this.loadJson<ManualDevice[]>(MANUAL_KEY);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d: ManualDevice) => d && typeof d.ip === 'string' && typeof d.port === 'number'
    );
  }

  async addManual(ip: string, port: number, name: string): Promise<void> {
    const list = await this.listManual();
    if (list.some((d) => d.ip === ip && d.port === port)) return;
    list.unshift({ ip, port, name, addedAt: Date.now() });
    await this.saveJson(MANUAL_KEY, list.slice(0, MANUAL_LIMIT));
  }

  async removeManual(ip: string, port: number): Promise<void> {
    const list = await this.listManual();
    const next = list.filter((d) => !(d.ip === ip && d.port === port));
    if (next.length !== list.length) await this.saveJson(MANUAL_KEY, next);
  }

  /** 从在线注册表与手动设备中移除指定设备（仍在广播/嗅探在线时会在下一轮重新出现） */
  async removeDevice(ip: string, port: number): Promise<void> {
    this.devices.delete(`${ip}:${port}`);
    await this.removeManual(ip, port);
  }

  /** 插件配置（手动指定的宿主地址、嗅探网段等） */
  async getConfig(): Promise<PluginConfig> {
    const cfg = await this.loadJson<PluginConfig>(CONFIG_KEY);
    return {
      hostAddr: cfg && typeof cfg.hostAddr === 'string' ? cfg.hostAddr : '',
      scanCidr: cfg && typeof cfg.scanCidr === 'string' ? cfg.scanCidr : '',
      scanPort: cfg && typeof cfg.scanPort === 'number' ? cfg.scanPort : 0,
      scanEnabled: !!(cfg && cfg.scanEnabled),
      // 广播监听默认关闭（用户手动开启；切页签时自动停）
      listenEnabled: !!(cfg && cfg.listenEnabled),
    };
  }

  async saveConfig(cfg: PluginConfig): Promise<void> {
    await this.saveJson(CONFIG_KEY, {
      hostAddr: (cfg.hostAddr || '').trim(),
      scanCidr: (cfg.scanCidr || '').trim(),
      scanPort: Number(cfg.scanPort) || 0,
      scanEnabled: !!cfg.scanEnabled,
      listenEnabled: cfg.listenEnabled !== false,
    });
  }

  private async loadJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await songloft.storage.get(key);
      return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T | null;
    } catch {
      return null;
    }
  }

  private async saveJson(key: string, value: unknown): Promise<void> {
    try {
      await songloft.storage.set(key, JSON.stringify(value));
    } catch (e) {
      songloft.log.warn(`[tv-helper] 保存 ${key} 失败: ${String(e)}`);
    }
  }
}
