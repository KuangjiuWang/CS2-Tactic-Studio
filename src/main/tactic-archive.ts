import fs from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import type { ExportTacticOptions, LibraryTactic, LibraryTacticInput, LibraryVideo, TacticStep } from '../types';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 220 * 1024 * 1024;
const MAX_ENTRY_BYTES = 120 * 1024 * 1024;
const MAX_ENTRIES = 64;
const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value, null, 2));
const portableVideoSchema = z.object({
  playerId: z.string().min(1).max(100), playerName: z.string().max(128),
  proxyEntry: z.string().optional(), fullEntry: z.string().optional(),
  startTick: z.number().int().nonnegative(), endTick: z.number().int().positive(), fps: z.number().positive().max(1000), duration: z.number().positive().max(86400),
});
const tacticSchema = z.object({
  id: z.string().max(80), name: z.string().min(1).max(120), description: z.string().max(4000),
  map: z.string().min(1).max(100), side: z.string().max(32), roundNumber: z.number().int().positive().nullable(),
  startTick: z.number().int().nonnegative().nullable(), endTick: z.number().int().nonnegative().nullable(),
  tickRate: z.number().positive().max(1000), teamId: z.string().max(100), tags: z.array(z.string().max(80)).max(64),
  players: z.array(z.object({ id: z.string(), steamId: z.string(), name: z.string(), teamId: z.string() }).passthrough()).max(16),
  videos: z.array(portableVideoSchema).max(16),
}).superRefine((value, ctx) => {
  if (value.startTick !== null && value.endTick !== null && value.endTick <= value.startTick) ctx.addIssue({ code: 'custom', path: ['endTick'], message: 'Invalid tactic tick range.' });
});
const stepSchema = z.object({ index: z.number().int().min(1).max(4), tick: z.number().finite(), players: z.array(z.unknown()), utility: z.array(z.unknown()), annotations: z.array(z.unknown()), captured: z.boolean() });
const manifestSchema = z.object({ format: z.literal('cstactic'), version: z.literal(1), createdAt: z.string().datetime(), appVersion: z.string().max(40) });
export interface ParsedArchive { tactic: LibraryTacticInput; proxyFiles: Array<{ playerId: string; bytes: Uint8Array }>; fullFiles: Array<{ playerId: string; bytes: Uint8Array }>; thumbnail?: Uint8Array }

function safeArchiveEntry(name: string): boolean {
  if (!name || name.length > 240 || name.startsWith('/') || name.includes('\\') || name.includes(':') || name.includes('\0')) return false;
  return name.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

function validateZipDirectory(bytes: Uint8Array) {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('Archive is empty or exceeds the 128 MiB import limit.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  const floor = Math.max(0, bytes.byteLength - 22 - 65535);
  for (let pos = bytes.byteLength - 22; pos >= floor; pos--) {
    if (view.getUint32(pos, true) === 0x06054b50) { end = pos; break; }
  }
  if (end < 0) throw new Error('Invalid ZIP archive: end record not found.');
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), directoryOffset = view.getUint32(end + 16, true);
  if (!count || count > MAX_ENTRIES || count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff || directoryOffset + directorySize > end) throw new Error('Unsupported or oversized ZIP directory.');
  const listed = new Map<string, number>(); let pos = directoryOffset, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || view.getUint32(pos, true) !== 0x02014b50) throw new Error('Invalid ZIP central directory.');
    const flags = view.getUint16(pos + 8, true), method = view.getUint16(pos + 10, true);
    const compressed = view.getUint32(pos + 20, true), uncompressed = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true), extraLength = view.getUint16(pos + 30, true), commentLength = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true), nameEnd = pos + 46 + nameLength;
    if (nameEnd + extraLength + commentLength > end || flags & 1 || ![0, 8].includes(method) || compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) throw new Error('Encrypted or unsupported ZIP entry.');
    const name = strFromU8(bytes.subarray(pos + 46, nameEnd));
    if (!safeArchiveEntry(name) || listed.has(name)) throw new Error('Unsafe or duplicate path inside .cstactic archive.');
    if (uncompressed > MAX_ENTRY_BYTES || compressed > MAX_ARCHIVE_BYTES) throw new Error('A .cstactic archive entry exceeds the size limit.');
    if (uncompressed > Math.max(compressed * 250, 1024 * 1024)) throw new Error('ZIP compression ratio exceeds the safety limit.');
    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('Invalid ZIP local file header.');
    const localNameLength = view.getUint16(localOffset + 26, true), localExtraLength = view.getUint16(localOffset + 28, true);
    const localName = strFromU8(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== name || localOffset + 30 + localNameLength + localExtraLength + compressed > directoryOffset) throw new Error('ZIP entry headers do not match.');
    listed.set(name, uncompressed); expanded += uncompressed;
    if (expanded > MAX_EXPANDED_BYTES) throw new Error('Uncompressed archive exceeds the 220 MiB safety limit.');
    pos = nameEnd + extraLength + commentLength;
  }
  if (pos !== directoryOffset + directorySize) throw new Error('Malformed ZIP central directory length.');
  return listed;
}

function parseJsonFile<T>(entries: Record<string, Uint8Array>, name: string, schema: z.ZodType<T>): T {
  const bytes = entries[name];
  if (!bytes || bytes.byteLength > 8 * 1024 * 1024) throw new Error(`Missing or oversized ${name}.`);
  let parsed: unknown;
  try { parsed = JSON.parse(strFromU8(bytes)); } catch { throw new Error(`Invalid JSON in ${name}.`); }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid .cstactic ${name}: ${result.error.issues[0]?.message ?? 'schema mismatch'}`);
  return result.data;
}

function validMp4(bytes: Uint8Array) { return bytes.byteLength >= 12 && strFromU8(bytes.subarray(4, 8)) === 'ftyp'; }
function validWebp(bytes: Uint8Array) { return bytes.byteLength >= 12 && strFromU8(bytes.subarray(0, 4)) === 'RIFF' && strFromU8(bytes.subarray(8, 12)) === 'WEBP'; }

export async function exportTacticArchive(tactic: LibraryTactic, options: ExportTacticOptions): Promise<Uint8Array> {
  if (!options.includeTacticalData) throw new Error('Tactical data is required to create a usable .cstactic file.');
  const files: Record<string, Uint8Array> = {};
  const videoEntries: z.infer<typeof portableVideoSchema>[] = [];
  for (let index = 0; index < tactic.videos.length; index++) {
    const video = tactic.videos[index];
    const entry: z.infer<typeof portableVideoSchema> = {
      playerId: video.playerId, playerName: video.playerName, startTick: video.startTick, endTick: video.endTick,
      fps: video.fps, duration: video.duration,
    };
    const slot = index + 1;
    if (options.includeProxyVideos && video.proxyPath) {
      const data = new Uint8Array(await fs.readFile(video.proxyPath));
      if (!validMp4(data)) throw new Error(`POV proxy for ${video.playerName} is not a valid MP4.`);
      if (data.byteLength > MAX_ENTRY_BYTES) throw new Error('A POV proxy is larger than the .cstactic limit.');
      entry.proxyEntry = `media/player${slot}_proxy.mp4`; files[entry.proxyEntry] = data;
    }
    if (options.includeFullQuality && video.fullPath) {
      const data = new Uint8Array(await fs.readFile(video.fullPath));
      if (!validMp4(data)) throw new Error(`Full POV for ${video.playerName} is not a valid MP4.`);
      if (data.byteLength > MAX_ENTRY_BYTES) throw new Error('A full quality POV exceeds the per-file limit.');
      entry.fullEntry = `media/full/player${slot}.mp4`; files[entry.fullEntry] = data;
    }
    videoEntries.push(entry);
  }
  let steps: TacticStep[] = tactic.steps.map(step => structuredClone(step));
  if (!options.includeSteps) steps = steps.map(step => ({ ...step, tick: 0, players: [], utility: [], annotations: [], captured: false }));
  if (!options.includeAnnotations) steps = steps.map(step => ({ ...step, annotations: [] }));
  const portable = {
    id: tactic.id, name: tactic.name, description: tactic.description, map: tactic.map, side: tactic.side,
    roundNumber: tactic.roundNumber, startTick: tactic.startTick, endTick: tactic.endTick,
    tickRate: tactic.tickRate, teamId: tactic.teamId, tags: tactic.tags, players: tactic.players, videos: videoEntries,
  };
  files['manifest.json'] = jsonBytes({ format: 'cstactic', version: 1, createdAt: new Date().toISOString(), appVersion: '0.1.0' });
  files['tactic.json'] = jsonBytes(portable);
  files['steps.json'] = jsonBytes(steps);
  files['annotations.json'] = jsonBytes(options.includeAnnotations ? steps.map(step => ({ index: step.index, annotations: step.annotations })) : []);
  files['paths/step-routes.json'] = jsonBytes(steps.map(step => ({ index: step.index, tick: step.tick, players: step.players.map(player => ({ id: player.id, x: player.x, y: player.y, z: player.z, yaw: player.yaw })) })));
  if (options.includeThumbnail && tactic.thumbnailPath) {
    const thumbnail = new Uint8Array(await fs.readFile(tactic.thumbnailPath));
    if (validWebp(thumbnail)) files['thumbnail.webp'] = thumbnail;
  }
  const archive = zipSync(files, { level: 6 });
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error('Exported .cstactic exceeds the 128 MiB size limit. Disable full quality POVs or export fewer clips.');
  return archive;
}

export function parseTacticArchive(bytes: Uint8Array, folderId: string | null = null): ParsedArchive {
  const directory = validateZipDirectory(bytes);
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(bytes); } catch { throw new Error('Archive could not be decompressed.'); }
  if (Object.keys(entries).length !== directory.size || Object.keys(entries).some(name => !directory.has(name))) throw new Error('ZIP entries do not match the archive directory.');
  for (const [name, data] of Object.entries(entries)) if (data.byteLength !== directory.get(name)) throw new Error('ZIP entry size does not match its header.');
  parseJsonFile(entries, 'manifest.json', manifestSchema);
  const metadata = parseJsonFile(entries, 'tactic.json', tacticSchema);
  const steps = parseJsonFile(entries, 'steps.json', z.array(stepSchema).length(4)) as TacticStep[];
  const annotations = parseJsonFile(entries, 'annotations.json', z.array(z.object({ index: z.number().int().min(1).max(4), annotations: z.array(z.unknown()) })).max(4));
  for (const item of annotations) {
    const step = steps.find(value => value.index === item.index);
    if (!step) throw new Error('Annotation references a missing tactic step.');
    if (step.annotations.length && JSON.stringify(step.annotations) !== JSON.stringify(item.annotations)) throw new Error('Tactic annotation data is inconsistent.');
    step.annotations = item.annotations as TacticStep['annotations'];
  }
  const proxyFiles: ParsedArchive['proxyFiles'] = [], fullFiles: ParsedArchive['fullFiles'] = [];
  const expected = new Set(['manifest.json', 'tactic.json', 'steps.json', 'annotations.json', 'paths/step-routes.json']);
  const players = new Map(metadata.videos.map((video, index) => [video.playerId, { video, slot: index + 1 }]));
  for (const [playerId, { video }] of players) {
    for (const [entry, target] of [[video.proxyEntry, proxyFiles], [video.fullEntry, fullFiles]] as const) {
      if (!entry) continue;
      const allowedPrefix = target === proxyFiles ? 'media/player' : 'media/full/player';
      if (!entry.startsWith(allowedPrefix) || !/^media\/(?:full\/)?player\d+_(?:proxy\.mp4|\d+\.mp4)$/.test(entry) && !/^media\/full\/player\d+\.mp4$/.test(entry)) throw new Error('Invalid POV archive entry name.');
      const data = entries[entry];
      if (!data || !validMp4(data)) throw new Error('POV archive entry is missing or is not an MP4.');
      target.push({ playerId, bytes: data }); expected.add(entry);
    }
  }
  const thumbnail = entries['thumbnail.webp'];
  if (thumbnail) { if (!validWebp(thumbnail)) throw new Error('Thumbnail is not a WebP image.'); expected.add('thumbnail.webp'); }
  parseJsonFile(entries, 'paths/step-routes.json', z.array(z.object({ index: z.number().int().min(1).max(4), tick: z.number().finite(), players: z.array(z.object({ id: z.string(), x: z.number().finite(), y: z.number().finite(), z: z.number().finite(), yaw: z.number().finite() })) })).length(4));
  const unknown = Object.keys(entries).find(name => !expected.has(name));
  if (unknown) throw new Error(`Unsupported file in .cstactic archive: ${unknown}`);
  const videos: LibraryVideo[] = metadata.videos.map(video => ({
    playerId: video.playerId, playerName: video.playerName, startTick: video.startTick, endTick: video.endTick,
    fps: video.fps, duration: video.duration,
  }));
  const tactic: LibraryTacticInput = {
    id: crypto.randomUUID(), folderId, name: metadata.name, description: metadata.description, map: metadata.map, side: metadata.side,
    demoPath: null, roundNumber: metadata.roundNumber, startTick: metadata.startTick, endTick: metadata.endTick,
    thumbnailPath: null, tags: metadata.tags, tickRate: metadata.tickRate, teamId: metadata.teamId,
    players: metadata.players, steps, videos,
  };
  return { tactic, proxyFiles, fullFiles, thumbnail };
}

export const archiveText = (value: unknown) => strFromU8(jsonBytes(value));
export const archiveFromBytes = (value: string) => strToU8(value);
export const resolveLibraryMediaPath = (directory: string, playerId: string, kind: 'proxy' | 'full') => path.join(directory, `${playerId.replace(/[^a-zA-Z0-9_-]/g, '_')}_${kind}.mp4`);
