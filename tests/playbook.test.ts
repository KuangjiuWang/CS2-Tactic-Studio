import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { PlaybookDatabase } from '../src/main/playbook-db';
import { exportTacticArchive, parseTacticArchive } from '../src/main/tactic-archive';
import { SupabaseShareProvider } from '../src/main/share-provider';
import { normalizeLanguage } from '../src/renderer/i18n';
import { mockProject } from '../src/demo/mock';
import type { LibraryTactic, LibraryTacticInput } from '../src/types';

const tempDirectories: string[] = [];
const openDatabases = new Set<PlaybookDatabase>();
function openDatabase(filename: string) { const database = new PlaybookDatabase(filename); openDatabases.add(database); return database; }
afterEach(async () => { for (const db of openDatabases) { try { db.close(); } catch { /* test already closed it */ } } openDatabases.clear(); await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });
function tacticInput(folderId: string | null = null): LibraryTacticInput {
  const { match } = mockProject();
  return {
    id: crypto.randomUUID(), folderId, name: 'A execute', description: 'Default execute with smoke cover.', map: match.map, side: 'T',
    demoPath: null, roundNumber: 3, startTick: 1000, endTick: 1640, thumbnailPath: null, tags: ['execute', 'A'], tickRate: 64,
    teamId: match.teams[0].id, players: match.players.slice(0, 5), videos: [],
    steps: Array.from({ length: 4 }, (_, index) => ({ index: index + 1, tick: 1000 + index * 160,
      players: index === 0 ? [{ ...mockProject().frames[0].players[0], id: match.players[0].id }] : [], utility: [],
      annotations: index === 0 ? [{ id: 'arrow-1', kind: 'arrow', color: '#fff', points: [[0.2, 0.3], [0.4, 0.5]] }] : [], captured: index === 0 })),
  };
}

describe('SQLite playbook database', () => {
  it('migrates, persists arbitrarily nested folders and tactic snapshots across reopen', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tactic-library-db-')); tempDirectories.push(directory);
    const filename = path.join(directory, 'tactics.db'); let db = openDatabase(filename);
    const a = db.createFolder('Mirage'), b = db.createFolder('T Side', a.id), c = db.createFolder('A Executes', b.id), d = db.createFolder('Fast execute', c.id);
    const tactic = db.saveTactic(tacticInput(d.id));
    expect(() => db.moveFolder(a.id, d.id)).toThrow(/descendant/i);
    db.moveTactic(tactic.id, b.id); db.setSetting('language', 'zh-CN'); db.close();
    db = openDatabase(filename);
    const library = db.getLibrary();
    expect(library.folders.map(folder => folder.name).sort()).toEqual(['A Executes', 'Fast execute', 'Mirage', 'T Side']);
    expect(library.folders.find(folder => folder.id === a.id)?.parentId).toBeNull();
    expect(library.folders.find(folder => folder.id === b.id)?.parentId).toBe(a.id);
    expect(library.tactics[0].folderId).toBe(b.id);
    expect(library.tactics[0].steps[0].annotations).toEqual(tactic.steps[0].annotations);
    expect(db.getSetting('language')).toBe('zh-CN');
    db.deleteFolder(a.id);
    expect(db.getLibrary().tactics[0].folderId).toBeNull();
    db.close();
  });

  it('duplicates snapshots with independent ids and removes tactic steps through foreign keys', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tactic-library-db-')); tempDirectories.push(directory);
    const db = openDatabase(path.join(directory, 'tactics.db'));
    const source = db.saveTactic(tacticInput()), duplicate = db.duplicateTactic(source.id);
    expect(duplicate.id).not.toBe(source.id);
    expect(duplicate.name).toBe('A execute (copy)');
    expect(duplicate.steps).toEqual(source.steps);
    db.deleteTactic(source.id);
    expect(db.getLibrary().tactics.map(item => item.id)).toEqual([duplicate.id]);
    db.close();
  });
});

describe('.cstactic archive', () => {
  it('round trips tactic metadata, all steps, annotations and routes without embedding the source demo', async () => {
    const input = tacticInput();
    const tactic: LibraryTactic = { ...input, folderId: input.folderId ?? null, thumbnailPath: input.thumbnailPath ?? null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const archive = await exportTacticArchive(tactic, { includeTacticalData: true, includeAnnotations: true, includeSteps: true, includeThumbnail: true, includeProxyVideos: true, includeFullQuality: false });
    const parsed = parseTacticArchive(archive, null);
    expect(parsed.tactic.id).not.toBe(input.id);
    expect(parsed.tactic.demoPath).toBeNull();
    expect(parsed.tactic.name).toBe(input.name);
    expect(parsed.tactic.steps).toEqual(input.steps);
    expect(parsed.tactic.steps[0].annotations).toEqual(input.steps[0].annotations);
    expect(parsed.proxyFiles).toHaveLength(0);
  });

  it('rejects traversal entries, unsupported versions and unexpected payload files', async () => {
    const traversal = zipSync({ '../outside.json': strToU8('{}') });
    expect(() => parseTacticArchive(traversal)).toThrow(/Unsafe|path/i);
    const unsupported = zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'cstactic', version: 99, createdAt: new Date().toISOString(), appVersion: '0.1.0' })) });
    expect(() => parseTacticArchive(unsupported)).toThrow(/manifest/i);
    const extra = zipSync({ 'manifest.json': strToU8('{}'), 'extra.exe': new Uint8Array([1, 2, 3]) });
    expect(() => parseTacticArchive(extra)).toThrow(/manifest|archive/i);
  });
});

describe('optional services and localization', () => {
  it('reports online sharing as not configured without attempting network access', () => {
    expect(new SupabaseShareProvider('', '', '').status()).toMatchObject({ configured: false, state: 'not-configured' });
    expect(normalizeLanguage('zh-Hans')).toBe('zh-CN');
    expect(normalizeLanguage('fr-FR')).toBe('en-US');
  });
});
