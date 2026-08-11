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
