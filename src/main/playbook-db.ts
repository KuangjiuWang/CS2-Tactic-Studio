import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { LibraryFolder, LibraryTactic, LibraryTacticInput, PlaybookLibrary, Project } from '../types';

const nameSchema = z.string().trim().min(1).max(120);
const stepSchema = z.object({
  index: z.number().int().min(1).max(4), tick: z.number().finite(),
  players: z.array(z.unknown()), utility: z.array(z.unknown()), annotations: z.array(z.unknown()), captured: z.boolean(),
});
const inputSchema = z.object({
  id: z.string().min(1).max(80), folderId: z.string().max(80).nullable().optional(), name: nameSchema,
  description: z.string().max(4000), map: z.string().min(1).max(100), side: z.string().max(32),
  demoPath: z.string().max(4096).nullable(), roundNumber: z.number().int().positive().nullable(),
  startTick: z.number().int().nonnegative().nullable(), endTick: z.number().int().nonnegative().nullable(),
  thumbnailPath: z.string().max(4096).nullable().optional(), tags: z.array(z.string().max(80)).max(64),
  tickRate: z.number().finite().positive().max(1000), teamId: z.string().max(100),
  players: z.array(z.object({ id: z.string(), steamId: z.string(), name: z.string(), teamId: z.string() }).passthrough()).max(16),
  steps: z.array(stepSchema).length(4), videos: z.array(z.object({
    playerId: z.string().max(100), playerName: z.string().max(128), proxyPath: z.string().max(4096).optional(),
    fullPath: z.string().max(4096).optional(), startTick: z.number().int().nonnegative(), endTick: z.number().int().nonnegative(),
    fps: z.number().positive().max(1000), duration: z.number().positive().max(86400),
  })).max(16),
}).superRefine((value, ctx) => {
  if (value.startTick !== null && value.endTick !== null && value.endTick <= value.startTick) {
    ctx.addIssue({ code: 'custom', path: ['endTick'], message: 'Tactic end tick must be after its start tick.' });
  }
});

const migrations = [
  `CREATE TABLE folders (
    id TEXT PRIMARY KEY, parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120), sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX folders_parent_order ON folders(parent_id, sort_order, name);
  CREATE TABLE tactics (
    id TEXT PRIMARY KEY, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', map TEXT NOT NULL, side TEXT NOT NULL DEFAULT '',
    demo_path TEXT, round_number INTEGER, start_tick INTEGER, end_tick INTEGER, thumbnail_path TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]', metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX tactics_folder_updated ON tactics(folder_id, updated_at DESC);
  CREATE TABLE tactic_steps (
    id TEXT PRIMARY KEY, tactic_id TEXT NOT NULL REFERENCES tactics(id) ON DELETE CASCADE,
    step_index INTEGER NOT NULL CHECK(step_index BETWEEN 1 AND 4), tick INTEGER NOT NULL,
    data_json TEXT NOT NULL, UNIQUE(tactic_id, step_index)
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, demo_path TEXT NOT NULL, metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE share_records (
    id TEXT PRIMARY KEY, tactic_id TEXT NOT NULL UNIQUE REFERENCES tactics(id) ON DELETE CASCADE,
    share_token TEXT NOT NULL UNIQUE, visibility TEXT NOT NULL CHECK(visibility IN ('private','unlisted','public')),
    provider_data_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, server_url TEXT NOT NULL DEFAULT ''
  );`,
];

type DbRow = Record<string, string | number | null>;
const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const folderFromRow = (row: DbRow): LibraryFolder => ({
  id: String(row.id), parentId: row.parent_id === null ? null : String(row.parent_id), name: String(row.name),
  sortOrder: Number(row.sort_order), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
});

export class PlaybookDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  close() { this.db.close(); }

  private migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
    const applied = new Set((this.db.prepare('SELECT version FROM schema_migrations').all() as DbRow[]).map(row => Number(row.version)));
    migrations.forEach((sql, index) => {
      const version = index + 1;
      if (applied.has(version)) return;
      this.transaction(() => {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(version, new Date().toISOString());
      });
    });
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getLibrary(): PlaybookLibrary {
    const folders = (this.db.prepare('SELECT * FROM folders ORDER BY sort_order, name COLLATE NOCASE').all() as DbRow[]).map(folderFromRow);
    const rows = this.db.prepare('SELECT * FROM tactics ORDER BY updated_at DESC, name COLLATE NOCASE').all() as DbRow[];
    const steps = this.db.prepare('SELECT * FROM tactic_steps ORDER BY step_index').all() as DbRow[];
    const byTactic = new Map<string, LibraryTactic['steps']>();
    for (const row of steps) {
      const id = String(row.tactic_id);
      const list = byTactic.get(id) ?? [];
      list.push(parseJson(row.data_json, { index: Number(row.step_index), tick: Number(row.tick), players: [], utility: [], annotations: [], captured: false }));
      byTactic.set(id, list);
    }
    const tactics: LibraryTactic[] = rows.map(row => {
      const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
      return {
        id: String(row.id), folderId: row.folder_id === null ? null : String(row.folder_id), name: String(row.name),
        description: String(row.description), map: String(row.map), side: String(row.side),
        demoPath: row.demo_path === null ? null : String(row.demo_path),
        roundNumber: row.round_number === null ? null : Number(row.round_number),
        startTick: row.start_tick === null ? null : Number(row.start_tick), endTick: row.end_tick === null ? null : Number(row.end_tick),
        thumbnailPath: row.thumbnail_path === null ? null : String(row.thumbnail_path), tags: parseJson(row.tags_json, []),
        tickRate: Number(metadata.tickRate) || 64, teamId: String(metadata.teamId ?? ''),
        players: parseJson(metadata.players, []), steps: byTactic.get(String(row.id)) ?? [], videos: parseJson(metadata.videos, []),
        createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      };
    });
    return { folders, tactics };
  }

  createFolder(name: string, parentId: string | null = null): LibraryFolder {
    const folderName = nameSchema.parse(name), id = crypto.randomUUID(), now = new Date().toISOString();
    if (parentId && !this.getFolder(parentId)) throw new Error('Parent folder does not exist.');
    const row = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS order_value FROM folders WHERE parent_id IS ?').get(parentId) as DbRow;
    this.db.prepare('INSERT INTO folders(id,parent_id,name,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, parentId, folderName, Number(row.order_value), now, now);
    return this.getFolder(id)!;
  }

  renameFolder(id: string, name: string) {
    const result = this.db.prepare('UPDATE folders SET name=?, updated_at=? WHERE id=?').run(nameSchema.parse(name), new Date().toISOString(), id);
    if (!result.changes) throw new Error('Folder not found.');
  }

  moveFolder(id: string, parentId: string | null) {
    const source = this.getFolder(id);
    if (!source) throw new Error('Folder not found.');
    if (parentId && !this.getFolder(parentId)) throw new Error('Destination folder not found.');
    if (id === parentId) throw new Error('A folder cannot be moved into itself.');
    if (parentId) {
      const cycle = this.db.prepare(`WITH RECURSIVE descendants(id) AS (
        SELECT id FROM folders WHERE parent_id=? UNION ALL SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id
      ) SELECT 1 AS found FROM descendants WHERE id=? LIMIT 1`).get(id, parentId);
      if (cycle) throw new Error('A folder cannot be moved into its descendant.');
    }
    const row = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS order_value FROM folders WHERE parent_id IS ?').get(parentId) as DbRow;
    this.db.prepare('UPDATE folders SET parent_id=?, sort_order=?, updated_at=? WHERE id=?').run(parentId, Number(row.order_value), new Date().toISOString(), id);
  }

  deleteFolder(id: string) {
    const result = this.db.prepare('DELETE FROM folders WHERE id=?').run(id);
    if (!result.changes) throw new Error('Folder not found.');
  }

  private getFolder(id: string): LibraryFolder | undefined {
    const row = this.db.prepare('SELECT * FROM folders WHERE id=?').get(id) as DbRow | undefined;
    return row ? folderFromRow(row) : undefined;
  }

  saveTactic(input: LibraryTacticInput): LibraryTactic {
    const value = inputSchema.parse({ ...input, folderId: input.folderId ?? null, thumbnailPath: input.thumbnailPath ?? null });
    if (value.folderId && !this.getFolder(value.folderId)) throw new Error('Destination folder not found.');
    const existing = this.db.prepare('SELECT created_at FROM tactics WHERE id=?').get(value.id) as DbRow | undefined;
    const now = new Date().toISOString(), createdAt = String(existing?.created_at ?? now);
    const metadata = JSON.stringify({ tickRate: value.tickRate, teamId: value.teamId, players: value.players, videos: value.videos });
    this.transaction(() => {
      this.db.prepare(`INSERT INTO tactics(id,folder_id,name,description,map,side,demo_path,round_number,start_tick,end_tick,thumbnail_path,tags_json,metadata_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,name=excluded.name,description=excluded.description,map=excluded.map,side=excluded.side,
        demo_path=excluded.demo_path,round_number=excluded.round_number,start_tick=excluded.start_tick,end_tick=excluded.end_tick,thumbnail_path=excluded.thumbnail_path,
        tags_json=excluded.tags_json,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`).run(
        value.id, value.folderId ?? null, value.name, value.description, value.map, value.side, value.demoPath, value.roundNumber,
        value.startTick, value.endTick, value.thumbnailPath ?? null, JSON.stringify(value.tags), metadata, createdAt, now,
      );
      this.db.prepare('DELETE FROM tactic_steps WHERE tactic_id=?').run(value.id);
      const insert = this.db.prepare('INSERT INTO tactic_steps(id,tactic_id,step_index,tick,data_json) VALUES(?,?,?,?,?)');
      for (const step of value.steps) insert.run(crypto.randomUUID(), value.id, step.index, step.tick, JSON.stringify(step));
    });
    const tactic = this.getLibrary().tactics.find(item => item.id === value.id);
    if (!tactic) throw new Error('Tactic save failed.');
    return tactic;
  }

  moveTactic(id: string, folderId: string | null) {
    if (folderId && !this.getFolder(folderId)) throw new Error('Destination folder not found.');
    const result = this.db.prepare('UPDATE tactics SET folder_id=?,updated_at=? WHERE id=?').run(folderId, new Date().toISOString(), id);
    if (!result.changes) throw new Error('Tactic not found.');
  }

  deleteTactic(id: string) {
    const result = this.db.prepare('DELETE FROM tactics WHERE id=?').run(id);
    if (!result.changes) throw new Error('Tactic not found.');
  }

  duplicateTactic(id: string, folderId?: string | null): LibraryTactic {
    const source = this.getLibrary().tactics.find(tactic => tactic.id === id);
    if (!source) throw new Error('Tactic not found.');
    const copy: LibraryTacticInput = {
      id: source.id, folderId: source.folderId, name: source.name, description: source.description, map: source.map, side: source.side,
      demoPath: source.demoPath, roundNumber: source.roundNumber, startTick: source.startTick, endTick: source.endTick,
      thumbnailPath: source.thumbnailPath, tags: source.tags, tickRate: source.tickRate, teamId: source.teamId,
      players: source.players, steps: source.steps, videos: source.videos,
    };
    return this.saveTactic({ ...copy, id: crypto.randomUUID(), folderId: folderId === undefined ? source.folderId : folderId, name: `${source.name} (copy)` });
  }

  saveProject(project: Project) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO projects(id,name,demo_path,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,demo_path=excluded.demo_path,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
      .run(project.directory, project.name, project.demoPath, JSON.stringify({ selectedTeam: project.selectedTeam, mock: project.mock }), now, now);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as DbRow | undefined;
    return row ? String(row.value) : null;
  }

  setSetting(key: string, value: string) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  getShare(tacticId: string): { id: string; tacticId: string; shareToken: string; providerData: Record<string, unknown>; createdAt: string; expiresAt: string | null; serverUrl: string } | null {
    const row = this.db.prepare('SELECT * FROM share_records WHERE tactic_id=?').get(tacticId) as DbRow | undefined;
    if (!row) return null;
    return { id: String(row.id), tacticId: String(row.tactic_id), shareToken: String(row.share_token),
      providerData: parseJson(row.provider_data_json, {}), createdAt: String(row.created_at),
      expiresAt: row.expires_at === null ? null : String(row.expires_at), serverUrl: String(row.server_url) };
  }

  saveShare(value: { id: string; tacticId: string; shareToken: string; providerData: Record<string, unknown>; createdAt: string; expiresAt: string | null; serverUrl: string }) {
    this.db.prepare(`INSERT INTO share_records(id,tactic_id,share_token,visibility,provider_data_json,created_at,expires_at,server_url)
      VALUES(?,?,?,'unlisted',?,?,?,?) ON CONFLICT(tactic_id) DO UPDATE SET id=excluded.id,share_token=excluded.share_token,
      visibility='unlisted',provider_data_json=excluded.provider_data_json,created_at=excluded.created_at,expires_at=excluded.expires_at,server_url=excluded.server_url`)
      .run(value.id, value.tacticId, value.shareToken, JSON.stringify(value.providerData), value.createdAt, value.expiresAt, value.serverUrl);
  }

  deleteShare(tacticId: string) {
    this.db.prepare('DELETE FROM share_records WHERE tactic_id=?').run(tacticId);
  }
}
