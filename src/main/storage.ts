import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { HistoryRecord, HistorySession } from '../shared/types';

interface DbLike {
  prepare(sql: string): {
    run: (...params: unknown[]) => { lastInsertRowid: number | bigint };
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
  exec(sql: string): unknown;
  close(): void;
}

/**
 * 对话历史存储：优先 better-sqlite3（含 FTS5 全文检索），
 * 原生模块不可用时回退到 JSON 文件存储。
 */
export class HistoryStore {
  private db: DbLike | null = null;
  private jsonFile: string;

  constructor() {
    this.jsonFile = path.join(app.getPath('userData'), 'history.json');
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3');
      const db: DbLike = new Database(path.join(app.getPath('userData'), 'history.db'));
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          emotion TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content_rowid='id');
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
        -- 迁移：旧版删除触发器误用 FTS5「外部内容表」的 'delete' 命令，而本表是普通 FTS 表，
        -- 该命令报错导致删除消息/会话失败；改为按 rowid 删除，并强制重建此触发器以修复旧库。
        DROP TRIGGER IF EXISTS messages_ad;
        CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
          DELETE FROM messages_fts WHERE rowid = old.id;
        END;
      `);
      // 迁移：messages 增加 images 列（JSON 存储附带图片）；旧库已存在该列时忽略
      try {
        db.exec('ALTER TABLE messages ADD COLUMN images TEXT');
      } catch {
        /* 列已存在，忽略 */
      }
      this.db = db;
    } catch (err) {
      console.warn('[history] better-sqlite3 不可用，回退到 JSON 存储:', (err as Error).message);
      this.db = null;
    }
  }

  private readJson(): { sessions: HistorySession[]; messages: HistoryRecord[] } {
    try {
      if (fs.existsSync(this.jsonFile)) return JSON.parse(fs.readFileSync(this.jsonFile, 'utf-8'));
    } catch {
      /* ignore */
    }
    return { sessions: [], messages: [] };
  }

  private writeJson(data: { sessions: HistorySession[]; messages: HistoryRecord[] }): void {
    fs.writeFileSync(this.jsonFile, JSON.stringify(data), 'utf-8');
  }

  newSession(title = '新对话'): HistorySession {
    const now = Date.now();
    const session: HistorySession = {
      id: `s_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    if (this.db) {
      this.db
        .prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(session.id, session.title, session.createdAt, session.updatedAt);
    } else {
      const data = this.readJson();
      data.sessions.push(session);
      this.writeJson(data);
    }
    return session;
  }

  listSessions(): HistorySession[] {
    if (this.db) {
      const rows = this.db
        .prepare(
          `SELECT s.id, s.title, s.created_at AS createdAt, s.updated_at AS updatedAt,
                  (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messageCount
           FROM sessions s ORDER BY s.updated_at DESC`
        )
        .all() as unknown as HistorySession[];
      return rows;
    }
    return this.readJson().sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  renameSession(id: string, title: string): void {
    if (this.db) {
      this.db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id);
    } else {
      const data = this.readJson();
      const s = data.sessions.find((x) => x.id === id);
      if (s) s.title = title;
      this.writeJson(data);
    }
  }

  deleteSession(id: string): void {
    if (this.db) {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    } else {
      const data = this.readJson();
      data.sessions = data.sessions.filter((s) => s.id !== id);
      data.messages = data.messages.filter((m) => m.sessionId !== id);
      this.writeJson(data);
    }
  }

  /** 一键清空全部历史（会话+消息+全文索引） */
  clearAll(): void {
    if (this.db) {
      this.db.prepare('DELETE FROM messages').run();
      this.db.prepare('DELETE FROM sessions').run();
    } else {
      this.writeJson({ sessions: [], messages: [] });
    }
  }

  addMessage(record: Omit<HistoryRecord, 'id'>): void {
    const createdAt = record.createdAt ?? Date.now();
    if (this.db) {
      this.db
        .prepare(
          'INSERT INTO messages (session_id, role, content, emotion, created_at, images) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(
          record.sessionId,
          record.role,
          record.content,
          record.emotion ?? null,
          createdAt,
          record.images && record.images.length > 0 ? JSON.stringify(record.images) : null
        );
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(createdAt, record.sessionId);
    } else {
      const data = this.readJson();
      data.messages.push({ ...record, createdAt });
      const s = data.sessions.find((x) => x.id === record.sessionId);
      if (s) s.updatedAt = createdAt;
      this.writeJson(data);
    }
  }

  queryMessages(sessionId: string): HistoryRecord[] {
    if (this.db) {
      const rows = this.db
        .prepare(
          `SELECT id, session_id AS sessionId, role, content, emotion, created_at AS createdAt, images
           FROM messages WHERE session_id = ? ORDER BY id ASC`
        )
        .all(sessionId) as unknown as (HistoryRecord & { images?: string | null })[];
      return rows.map((r) => {
        const { images, ...rest } = r;
        let parsed: string[] | undefined;
        if (typeof images === 'string' && images) {
          try {
            parsed = JSON.parse(images) as string[];
          } catch {
            parsed = undefined;
          }
        }
        return parsed && parsed.length > 0 ? { ...rest, images: parsed } : rest;
      });
    }
    return this.readJson()
      .messages.filter((m) => m.sessionId === sessionId)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  /** FTS5 全文检索（JSON 模式下退化为子串匹配） */
  search(keyword: string): HistoryRecord[] {
    if (!keyword.trim()) return [];
    if (this.db) {
      try {
        return this.db
          .prepare(
            `SELECT m.id, m.session_id AS sessionId, m.role, m.content, m.emotion, m.created_at AS createdAt
             FROM messages_fts f JOIN messages m ON m.id = f.rowid
             WHERE messages_fts MATCH ? ORDER BY rank LIMIT 50`
          )
          .all(`"${keyword.replace(/"/g, '""')}"`) as unknown as HistoryRecord[];
      } catch {
        /* MATCH 语法错误时回退 LIKE */
        return this.db
          .prepare(
            `SELECT id, session_id AS sessionId, role, content, emotion, created_at AS createdAt
             FROM messages WHERE content LIKE ? ORDER BY id DESC LIMIT 50`
          )
          .all(`%${keyword}%`) as unknown as HistoryRecord[];
      }
    }
    const data = this.readJson();
    return data.messages.filter((m) => m.content.includes(keyword)).slice(-50);
  }

  exportAll(): { sessions: HistorySession[]; messages: HistoryRecord[] } {
    return { sessions: this.listSessions(), messages: this.db ? this.allMessages() : this.readJson().messages };
  }

  private allMessages(): HistoryRecord[] {
    return this.db!
      .prepare(
        `SELECT id, session_id AS sessionId, role, content, emotion, created_at AS createdAt
         FROM messages ORDER BY id ASC`
      )
      .all() as unknown as HistoryRecord[];
  }

  dispose(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
  }
}
