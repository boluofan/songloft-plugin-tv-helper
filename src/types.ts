/** 局域网内发现的 Songloft TV 设备（由 TV 配置页 UDP beacon 广播而来，不含配对码） */
export interface TvDevice {
  ip: string;
  port: number;
  name: string;
  version: string;
  lastSeen: number;
  /** 来源：beacon 广播 / scan 主动嗅探 */
  source?: 'beacon' | 'scan';
}

/** 手动添加的设备（广播不可达场景：Docker 非 host 网络 / AP 隔离等） */
export interface ManualDevice {
  ip: string;
  port: number;
  name: string;
  addedAt: number;
}

/** 插件配置 */
export interface PluginConfig {
  /** 已废弃：推送地址改为自动提取，此字段保留仅为兼容旧存储，不再参与推送逻辑 */
  hostAddr: string;
  /** 主动嗅探的网段（CIDR，可逗号分隔多个）；留空时按 getNetworkAddresses 推导 /24 */
  scanCidr: string;
  /** 嗅探端口（TV 配置页端口，默认 18899）；0 表示默认 */
  scanPort: number;
  /** 主动嗅探开关（心跳），true 时每 15 秒扫描一次 */
  scanEnabled: boolean;
  /** UDP 广播监听开关（默认 true，广播为默认模式） */
  listenEnabled: boolean;
}

/** 历史设备（不持久化 pin） */
export interface HistoryDevice {
  ip: string;
  port: number;
  name: string;
  version: string;
  lastSeen: number;
  online: boolean;
}

/** 一轮嗅探扫描的统计（供界面诊断：扫了多少 IP、有没有 HTTP 响应但无 /probe 的设备） */
export interface ScanSummary {
  /** 扫描完成时间戳（ms） */
  ts: number;
  /** 扫描的网段 */
  subnets: string[];
  /** 探测 IP 总数 */
  total: number;
  /** 发现的 TV 数 */
  found: number;
  /** 有 HTTP 响应但没有 /probe 端点的数量（TV 端版本过低或端口不对） */
  httpOnly: number;
  /** 本轮扫描耗时（ms） */
  durationMs: number;
}

/** 扫描进行中的进度（界面显示当前扫到哪个 IP） */
export interface ScanProgress {
  /** 已完成探测的 IP 数 */
  done: number;
  /** IP 总数 */
  total: number;
  /** 当前正在探测的 IP */
  currentIp: string;
}

/** 一条 UDP beacon 接收日志（含解析失败记录，供广播日志界面排障） */
export interface BeaconLog {
  /** 自增序号，前端用它做增量拉取 */
  id: number;
  /** 接收时间戳（ms） */
  ts: number;
  /** 来源 "ip:port" */
  from: string;
  /** 是否成功解析为 songloft-tv 设备 */
  ok: boolean;
  name?: string;
  ip?: string;
  port?: number;
  version?: string;
  /** 解码后的原始 payload（截断） */
  raw: string;
  error?: string;
}
