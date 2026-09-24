import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LibraryTactic, LibraryVideo } from '../types';
import { exportTacticArchive } from './tactic-archive';
import { probe } from '../video/encode';
import { run } from './process';

export type PovShareMode = 'none' | 'optimized' | 'full';

export async function createShareArchive(tactic: LibraryTactic, mode: PovShareMode, ffmpegPath: string, ffprobePath: string): Promise<Uint8Array> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'tacticlab-share-'));
  try {
    let shareTactic: LibraryTactic = { ...tactic, videos: [] };
    if (mode !== 'none') {
      if (tactic.startTick === null || tactic.endTick === null || tactic.endTick <= tactic.startTick || tactic.tickRate <= 0) throw new Error('Set a valid tactic tick range before sharing POV clips.');
      if (!ffmpegPath || !ffprobePath) throw new Error('FFmpeg and FFprobe must be configured to trim POV clips for sharing.');
      const rangeStart = tactic.startTick, rangeEnd = tactic.endTick;
      const videos: LibraryVideo[] = [];
      for (const [index, video] of tactic.videos.entries()) {
        if (video.startTick > rangeStart || video.endTick < rangeEnd) throw new Error(`POV for ${video.playerName} does not cover the complete saved tactic range.`);
        const startTick = rangeStart, endTick = rangeEnd;
        const source = mode === 'full' ? video.fullPath : (video.proxyPath || video.fullPath);
        if (!source) throw new Error(`${mode === 'full' ? 'Full-quality' : 'Optimized'} POV for ${video.playerName} is missing.`);
        const expectedDuration = (endTick - startTick) / tactic.tickRate;
        const offset = (startTick - video.startTick) / tactic.tickRate;
        const output = path.join(scratch, `player${index + 1}-${mode}.mp4`);
        const args = ['-y', '-v', 'error', '-ss', offset.toFixed(6), '-i', source, '-t', expectedDuration.toFixed(6), '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
        if (mode === 'optimized') args.push('-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-an');
        else args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-b:a', '160k');
        args.push('-movflags', '+faststart', output);
        await run(ffmpegPath, args);
        const metadata = await probe(output, { ffmpegPath, ffprobePath } as never);
        if (Math.abs(metadata.duration - expectedDuration) > Math.max(.25, 2 / Math.max(metadata.fps, 1))) throw new Error(`Trimmed POV duration mismatch for ${video.playerName}.`);
        await run(ffmpegPath, ['-v', 'error', '-xerror', '-err_detect', 'explode', '-i', output, '-map', '0:v:0', '-f', 'null', '-']);
        const clipped: LibraryVideo = { ...video, startTick, endTick, fps: metadata.fps, duration: metadata.duration };
        if (mode === 'optimized') clipped.proxyPath = output;
        else clipped.fullPath = output;
        videos.push(clipped);
      }
      if (tactic.videos.length && !videos.length) throw new Error('No POV clips overlap the saved tactic tick range.');
      if (!tactic.videos.length) throw new Error('No local POV clips are available. Choose “No POV” or render/import POVs first.');
      if (videos.length !== tactic.videos.length) throw new Error('POV share is incomplete; no partial share was uploaded.');
      shareTactic = { ...tactic, videos };
    }
    return await exportTacticArchive(shareTactic, {
      includeTacticalData: true, includeAnnotations: true, includeSteps: true,
      includeThumbnail: !!tactic.thumbnailPath, includeProxyVideos: mode === 'optimized', includeFullQuality: mode === 'full',
    });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
