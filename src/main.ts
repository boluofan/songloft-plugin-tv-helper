/// <reference types="@songloft/plugin-sdk" />
import { createRouter } from '@songloft/plugin-sdk';
import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';
import { DiscoveryService } from './services/discovery';
import { registerHandlers } from './handlers/router';

const router = createRouter();
let discovery: DiscoveryService | null = null;

async function onInit(): Promise<void> {
  songloft.log.info('[tv-helper] 插件初始化');
  discovery = new DiscoveryService();
  await discovery.init();
  registerHandlers(router, discovery);
  songloft.log.info('[tv-helper] 初始化完成');
}

async function onDeinit(): Promise<void> {
  if (discovery) {
    await discovery.stop();
    discovery = null;
  }
  songloft.log.info('[tv-helper] 已停止');
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  if (!discovery) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ success: false, error: '插件尚未初始化完成' }),
    };
  }
  try {
    const resp = await router.handle(req);
    if (!resp || typeof resp !== 'object') {
      songloft.log.error(`[tv-helper] handler 返回非对象: ${typeof resp}`);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ success: false, error: 'handler 返回无效响应' }),
      };
    }
    return resp;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    songloft.log.error(`[tv-helper] onHTTPRequest: ${msg}`);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ success: false, error: msg }),
    };
  }
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
