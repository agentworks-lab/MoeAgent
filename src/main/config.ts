import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppConfig } from '../shared/types';
import { DEFAULT_CONFIG, deepMergeConfig } from '../shared/defaults';

export { DEFAULT_CONFIG };

export type ConfigListener = (config: AppConfig) => void;

/**
 * 配置管理：JSON 存储于 userData，支持深合并写入与文件热加载。
 */
export class ConfigStore {
  private file: string;
  private config: AppConfig;
  private listeners = new Set<ConfigListener>();
  private watcher?: fs.FSWatcher;
  private suppressWatch = false;

  constructor() {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'config.json');
    this.config = this.loadFromDisk();
  }

  private loadFromDisk(): AppConfig {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
        // 与默认值深合并：旧版配置文件缺失的新字段会自动补齐
        return deepMergeConfig(DEFAULT_CONFIG, raw);
      }
    } catch (err) {
      console.error('[config] 读取配置失败，使用默认配置:', err);
    }
    return structuredClone(DEFAULT_CONFIG);
  }

  get(): AppConfig {
    return this.config;
  }

  /** 深合并写入并持久化 */
  update(patch: unknown): AppConfig {
    this.config = deepMergeConfig(this.config, patch);
    this.suppressWatch = true;
    fs.writeFileSync(this.file, JSON.stringify(this.config, null, 2), 'utf-8');
    setTimeout(() => (this.suppressWatch = false), 300);
    this.emit();
    return this.config;
  }

  /** 监听配置文件变更（热加载） */
  watch(): void {
    try {
      this.watcher = fs.watch(this.file, () => {
        if (this.suppressWatch) return;
        const next = this.loadFromDisk();
        this.config = next;
        this.emit();
      });
    } catch {
      /* 文件不存在时忽略 */
    }
  }

  onChange(fn: ConfigListener): void {
    this.listeners.add(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.config);
  }

  dispose(): void {
    this.watcher?.close();
  }
}
