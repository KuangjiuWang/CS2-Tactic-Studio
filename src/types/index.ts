export type Side = 2 | 3;
export interface Player { id: string; steamId: string; name: string; teamId: string }
export interface Team { id: string; name: string; playerIds: string[] }
export interface Round { number: number; startTick: number; freezeEndTick: number; endTick: number; winner?: number; teamASide?: Side; score: [number, number] }
export interface PlayerFrame { id: string; x: number; y: number; z: number; yaw: number; health: number; armor: number; alive: boolean; side: number; weapon: string; hasBomb: boolean }
export type UtilityKind = 'smoke' | 'flash' | 'he' | 'molotov' | 'decoy' | 'c4';
export interface Utility { id: string; kind: UtilityKind; x: number; y: number; z: number; startTick: number; endTick: number; playerId?: string }
export interface MatchEvent { tick: number; type: string; playerId?: string; targetId?: string; x?: number; y?: number; z?: number }
export interface Match { version: 1; map: string; tickRate: number; startTick: number; endTick: number; sampleInterval: number; players: Player[]; teams: Team[]; rounds: Round[]; events: MatchEvent[]; utility: Utility[]; framesFile: string; warnings: string[] }
export interface ReplayFrame { tick: number; players: PlayerFrame[] }
export interface PovVideo { playerId: string; steamId: string; path: string; proxyPath: string; videoStartTick: number; videoEndTick: number; tickRate: number; duration: number; fps: number; hasAudio: boolean; source: 'hlae' | 'imported'; syncVerified: boolean; revision?: number }
export interface POVMetadata { playerId: string; steamId: string; startTick: number; endTick: number; tickRate: number; fps: number; duration: number; videoPath: string; proxyPath: string; hasAudio: true; source: 'hlae' }
export interface HLAERenderJob { demoPath: string; playerId: string; steamId: string; playerName: string; startTick: number; endTick: number; outputPath: string; resolution: 720 | 1080; fps: 30 | 60 }
export interface Preferences { cs2Path: string; hlaePath: string; ffmpegPath: string; ffprobePath: string; demoPath: string; outputDirectory: string; resolution: 720 | 1080; fps: 30 | 60; jobTimeoutMinutes: number }
export interface MapSection { name: string; minZ: number; maxZ: number; image: string }
export interface MapOverview { name: string; pos_x: number; pos_y: number; scale: number; rotation: number; image: string; sections?: MapSection[]; provenance: string }
export type DrawKind = 'pen' | 'rectangle' | 'circle' | 'text' | 'line' | 'arrow' | UtilityKind;
export interface Drawing { id: string; kind: DrawKind; color: string; points: [number, number][]; text?: string }
export interface TacticStep { index: number; tick: number; players: PlayerFrame[]; utility: Utility[]; annotations: Drawing[]; captured: boolean }
export interface Tactic { id: string; name: string; map: string; team: string; demoPath: string; steps: TacticStep[] }
export interface LibraryFolder { id: string; parentId: string | null; name: string; sortOrder: number; createdAt: string; updatedAt: string }
export interface LibraryVideo { playerId: string; playerName: string; proxyPath?: string; fullPath?: string; startTick: number; endTick: number; fps: number; duration: number }
export interface LibraryTactic {
  id: string; folderId: string | null; name: string; description: string; map: string; side: string;
  demoPath: string | null; roundNumber: number | null; startTick: number | null; endTick: number | null;
  thumbnailPath: string | null; tags: string[]; tickRate: number; teamId: string; players: Player[];
  steps: TacticStep[]; videos: LibraryVideo[]; createdAt: string; updatedAt: string;
}
export interface PlaybookLibrary { folders: LibraryFolder[]; tactics: LibraryTactic[] }
export interface LibraryTacticInput extends Omit<LibraryTactic, 'createdAt' | 'updatedAt' | 'folderId' | 'thumbnailPath'> {
  folderId?: string | null; thumbnailPath?: string | null;
}
export interface ExportTacticOptions { includeTacticalData: boolean; includeAnnotations: boolean; includeSteps: boolean; includeThumbnail: boolean; includeProxyVideos: boolean; includeFullQuality: boolean }
export interface ShareStatus { configured: boolean; state: 'not-configured' | 'configured'; message: string }
export interface ShareResult { shareToken: string; shareUrl: string; expiresAt: string | null }
export interface SharedTacticPreview { previewId: string; name: string; description: string; map: string; side: string; roundNumber: number | null; stepCount: number; povCount: number; duration: number | null }
export interface Project { version: 1; name: string; directory: string; demoPath: string; matchDataPath: string; selectedTeam: string; pov: PovVideo[]; tactics: Tactic[]; preferences: Preferences; mock: boolean; customMap?: MapOverview }
export interface LoadedProject { project: Project; match: Match; frames: ReplayFrame[] }
export interface RenderJob { id: string; playerId: string; name: string; status: 'waiting'|'launching'|'loading'|'recording'|'encoding'|'verifying'|'completed'|'failed'|'cancelled'; elapsed: number; message: string; log: string[] }
export interface RenderUpdate { jobs: RenderJob[]; video?: PovVideo }
export interface DesktopApi {
  setDirty(dirty: boolean): void;
  detect(): Promise<Preferences>;
  pickFile(kind: 'demo'|'exe'|'video'|'overview'): Promise<string|null>;
  pickDirectory(): Promise<string|null>;
  importDemo(path?: string): Promise<LoadedProject|null>;
  openProject(path?: string): Promise<LoadedProject|null>;
  saveProject(project: Project, mockData?: {match:Match;frames:ReplayFrame[]}): Promise<Project|null>;
  render(project: Project, match: Match, startTick: number, endTick: number): Promise<void>;
  cancelRender(): Promise<void>;
  importVideo(project: Project, playerId: string, startTick: number): Promise<PovVideo|null>;
  onRender(callback: (update: RenderUpdate)=>void): ()=>void;
  onProgress(callback: (message: string)=>void): ()=>void;
  mediaUrl(path: string): string;
  importOverview(): Promise<MapOverview|null>;
  getLanguage(): Promise<string | null>;
  setLanguage(language: 'zh-CN' | 'en-US'): Promise<void>;
  getPlaybookLibrary(): Promise<PlaybookLibrary>;
  createPlaybookFolder(name: string, parentId?: string | null): Promise<LibraryFolder>;
  renamePlaybookFolder(id: string, name: string): Promise<void>;
  movePlaybookFolder(id: string, parentId: string | null): Promise<void>;
  deletePlaybookFolder(id: string): Promise<void>;
  createLibraryTactic(input: LibraryTacticInput): Promise<LibraryTactic>;
  updateLibraryTactic(id: string, patch: Partial<LibraryTacticInput>): Promise<LibraryTactic>;
  moveLibraryTactic(id: string, folderId: string | null): Promise<void>;
  deleteLibraryTactic(id: string): Promise<void>;
  duplicateLibraryTactic(id: string, folderId?: string | null): Promise<LibraryTactic>;
  importTacticFile(folderId?: string | null): Promise<LibraryTactic | null>;
  importTacticBytes(bytes: Uint8Array, name: string, folderId?: string | null): Promise<LibraryTactic>;
  exportTactic(id: string, options: ExportTacticOptions): Promise<string | null>;
  exportPlaybookFolder(id: string): Promise<number>;
  getShareStatus(): Promise<ShareStatus>;
  shareTactic(id: string, mode: 'none' | 'optimized' | 'full'): Promise<ShareResult>;
  previewSharedTactic(url: string): Promise<SharedTacticPreview>;
  importSharedTactic(previewId: string, folderId?: string | null): Promise<LibraryTactic>;
  revokeTacticShare(id: string): Promise<void>;
  copyText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}
declare global { interface Window { desktop: DesktopApi } }
