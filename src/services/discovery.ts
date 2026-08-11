import type { HistoryDevice, TvDevice } from '../types';

const BEACON_PORT = 18910;
const DEVICE_TTL_MS = 30_000;
const PRUNE_INTERVAL_MS = 5_000;
const HISTORY_KEY = 'tv_history';
const HISTORY_LIMIT = 20;

/**
 * TV 发现服务：监听 UDP 18910 收集 TV 配置页广播的 beacon，
 * 维护在线设备注册表（TTL 30s）与最近设备历史（storage，不存 pin）。
 */
export class DiscoveryService {
  private socketId: string | null = null;
  private readonly devices = new Map<string, TvDevice>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private listening = false;

  async init(): Promise<void> {
    try {
      const info = await songloft.net.udpBind({ address: `:${BEACON_PORT}` });
      this.socketId = info.socketId;
      songloft.net.onData(this.socketId, (event: unknown) => this.onBeacon(event));
      this.timer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
      this.listening = true;
      songloft.log.info(`[tv-helper] 已监听 UDP ${BEACON_PORT}，等待电视 beacon`);
    } catch (e) {
      this.listening = false;
      songloft.log.error(`[tv-helper] 监听 UDP ${BEACON_PORT} 失败: ${String(e)}`);
    }
  }

  isListening(): boolean {
    return this.listening;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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

  private onBeacon(event: unknown): void {
    try {
      const ev = (event || {}) as { Data?: string; data?: string };
      const raw = atob(ev.Data || ev.data || '');
      const data = JSON.parse(raw) as {
        app?: string;
        name?: string;
        ip?: string;
        port?: number;
        version?: string;
      };
      if (data.app !== 'songloft-tv' || !data.ip || !data.port) return;
      const key = `${data.ip}:${data.port}`;
      this.devices.set(key, {
        ip: data.ip,
        port: Number(data.port),
        name: String(data.name || 'Songloft TV'),
        version: String(data.version || ''),
        lastSeen: Date.now(),
      });
    } catch {
      // 忽略无法解析或非本协议的数据包
    }
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
    try {
      const raw = await songloft.storage.get(HISTORY_KEY);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (d: HistoryDevice) => d && typeof d.ip === 'string' && typeof d.port === 'number'
      );
    } catch {
      return [];
    }
  }

  private async saveHistory(list: HistoryDevice[]): Promise<void> {
    try {
      await songloft.storage.set(HISTORY_KEY, JSON.stringify(list));
    } catch (e) {
      songloft.log.warn(`[tv-helper] 保存历史设备失败: ${String(e)}`);
    }
  }
}
