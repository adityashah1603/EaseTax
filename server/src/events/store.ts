// Append-only event store on SQLite (D-03). The only table the workpaper writes to,
// plus attachment blobs and frozen snapshots.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';

// Loaded via require so test bundlers that don't know the newer `node:sqlite` builtin leave it alone.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import type { EventType, Role, WorkEvent } from '@easetax/shared';

export interface AppendInput {
  type: EventType;
  payload: unknown;
  actor: string;
  role: Role;
  reason?: string;
  batchId?: string;
  at?: string;
}

export class EventStore {
  private db: DatabaseSyncT;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        seq      INTEGER PRIMARY KEY AUTOINCREMENT,
        id       TEXT NOT NULL UNIQUE,
        at       TEXT NOT NULL,
        actor    TEXT NOT NULL,
        role     TEXT NOT NULL,
        type     TEXT NOT NULL,
        payload  TEXT NOT NULL,
        reason   TEXT,
        batch_id TEXT
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id     TEXT PRIMARY KEY,
        name   TEXT NOT NULL,
        mime   TEXT,
        size   INTEGER,
        sha256 TEXT,
        data   BLOB
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        at           TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        content      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
  }

  /** Appends events atomically and returns them with their assigned seq. */
  append(inputs: AppendInput[]): WorkEvent[] {
    const insert = this.db.prepare(
      'INSERT INTO events (id, at, actor, role, type, payload, reason, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const out: WorkEvent[] = [];
    this.db.exec('BEGIN');
    try {
      for (const i of inputs) {
        const id = randomUUID();
        const at = i.at ?? new Date().toISOString();
        const r = insert.run(id, at, i.actor, i.role, i.type, JSON.stringify(i.payload), i.reason ?? null, i.batchId ?? null);
        out.push({
          seq: Number(r.lastInsertRowid),
          id,
          at,
          actor: i.actor,
          role: i.role,
          type: i.type,
          payload: i.payload as any,
          reason: i.reason,
          batchId: i.batchId,
        });
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return out;
  }

  all(): WorkEvent[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY seq').all() as any[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      id: r.id,
      at: r.at,
      actor: r.actor,
      role: r.role,
      type: r.type,
      payload: JSON.parse(r.payload),
      reason: r.reason ?? undefined,
      batchId: r.batch_id ?? undefined,
    }));
  }

  lastSeq(): number {
    const r = this.db.prepare('SELECT MAX(seq) AS s FROM events').get() as any;
    return Number(r?.s ?? 0);
  }

  putAttachment(a: { id: string; name: string; mime?: string; size: number; sha256: string; data: Uint8Array }) {
    this.db
      .prepare('INSERT INTO attachments (id, name, mime, size, sha256, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.id, a.name, a.mime ?? null, a.size, a.sha256, a.data);
  }

  getAttachment(id: string): { name: string; mime: string | null; data: Uint8Array } | undefined {
    return this.db.prepare('SELECT name, mime, data FROM attachments WHERE id = ?').get(id) as any;
  }

  putSnapshot(s: { id: string; kind: string; at: string; seq: number; contentHash: string; content: string }) {
    this.db
      .prepare('INSERT INTO snapshots (id, kind, at, seq, content_hash, content) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.id, s.kind, s.at, s.seq, s.contentHash, s.content);
  }

  snapshots(): { id: string; kind: string; at: string; seq: number; contentHash: string }[] {
    return (this.db.prepare('SELECT id, kind, at, seq, content_hash FROM snapshots ORDER BY at').all() as any[]).map((r) => ({
      id: r.id,
      kind: r.kind,
      at: r.at,
      seq: Number(r.seq),
      contentHash: r.content_hash,
    }));
  }

  getSnapshot(id: string): { content: string; contentHash: string } | undefined {
    const r = this.db.prepare('SELECT content, content_hash FROM snapshots WHERE id = ?').get(id) as any;
    return r ? { content: r.content, contentHash: r.content_hash } : undefined;
  }

  getMeta(k: string): string | undefined {
    return (this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as any)?.v;
  }

  setMeta(k: string, v: string) {
    this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  close() {
    this.db.close();
  }
}
