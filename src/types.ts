/** 局域网内发现的 Songloft TV 设备（由 TV 配置页 UDP beacon 广播而来，不含配对码） */
export interface TvDevice {
  ip: string;
  port: number;
  name: string;
  version: string;
  lastSeen: number;
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
