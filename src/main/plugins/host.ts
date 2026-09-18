import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { app } from 'electron';
import type { PluginInfo, PluginToolDef } from '../../shared/types';

interface LoadedPlugin {
  info: PluginInfo;
  exports: {
    onLoad?: (api: unknown) => void | Promise<void>;
    onUnload?: () => void | Promise<void>;
    onMessage?: (message: unknown) => unknown;
    tools?: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>;
  };
}

/**
 * 插件宿主：扫描插件目录，使用 node:vm 沙箱隔离执行插件代码。
 * 支持生命周期钩子（onLoad / onUnload / onMessage）与工具注册，
 * 插件可为 LLM Agent 提供 Function Calling 工具（如查询时间、天气等）。
 */
export class PluginHost {
  private plugins = new Map<string, LoadedPlugin>();
  private pluginsDir: string;

  constructor() {
    this.pluginsDir = app.isPackaged
      ? path.join(process.resourcesPath, 'plugins')
      : path.join(app.getAppPath(), 'plugins');
  }

  async loadAll(): Promise<void> {
    if (!fs.existsSync(this.pluginsDir)) return;
    for (const entry of fs.readdirSync(this.pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        await this.loadPlugin(path.join(this.pluginsDir, entry.name));
      } catch (err) {
        console.error(`[plugin] 加载插件 ${entry.name} 失败:`, err);
      }
    }
    console.log(`[plugin] 已加载 ${this.plugins.size} 个插件`);
  }

  private async loadPlugin(dir: string): Promise<void> {
    const manifestPath = path.join(dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) return;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      id: string;
      name: string;
      version: string;
      description?: string;
      main?: string;
      tools?: PluginToolDef[];
    };

    const mainFile = path.join(dir, manifest.main ?? 'index.js');
    const code = fs.readFileSync(mainFile, 'utf-8');

    const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
    const sandbox = {
      module: moduleObj,
      exports: moduleObj.exports,
      console: {
        log: (...args: unknown[]) => console.log(`[plugin:${manifest.id}]`, ...args),
        warn: (...args: unknown[]) => console.warn(`[plugin:${manifest.id}]`, ...args),
        error: (...args: unknown[]) => console.error(`[plugin:${manifest.id}]`, ...args),
      },
      setTimeout,
      clearTimeout,
      Date,
      Math,
      JSON,
      api: {
        pluginId: manifest.id,
        version: manifest.version,
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: mainFile, timeout: 5000 });

    const exports = moduleObj.exports as LoadedPlugin['exports'];
    const info: PluginInfo = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? '',
      tools: manifest.tools ?? [],
      enabled: true,
    };

    await exports.onLoad?.(sandbox.api);
    this.plugins.set(manifest.id, { info, exports });
  }

  list(): PluginInfo[] {
    return [...this.plugins.values()].map((p) => p.info);
  }

  /** 汇总所有插件提供的工具（供 LLM Function Calling） */
  allTools(): { pluginId: string; tool: PluginToolDef }[] {
    const out: { pluginId: string; tool: PluginToolDef }[] = [];
    for (const p of this.plugins.values()) {
      for (const tool of p.info.tools) out.push({ pluginId: p.info.id, tool });
    }
    return out;
  }

  async invokeTool(pluginId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`插件不存在: ${pluginId}`);
    const fn = plugin.exports.tools?.[toolName];
    if (typeof fn !== 'function') throw new Error(`工具不存在: ${pluginId}/${toolName}`);
    return await fn(args);
  }

  broadcast(message: unknown): void {
    for (const p of this.plugins.values()) {
      try {
        p.exports.onMessage?.(message);
      } catch (err) {
        console.error(`[plugin] onMessage 失败 (${p.info.id}):`, err);
      }
    }
  }

  async dispose(): Promise<void> {
    for (const p of this.plugins.values()) {
      try {
        await p.exports.onUnload?.();
      } catch {
        /* ignore */
      }
    }
    this.plugins.clear();
  }
}
