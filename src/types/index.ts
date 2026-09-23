export type Side = 2 | 3;
export interface Player { id: string; steamId: string; name: string; teamId: string }
export interface Team { id: string; name: string; playerIds: string[] }
export interface Round { number: number; startTick: number; freezeEndTick: number; endTick: number; winner?: number; score: [number, number] }
export interface PlayerFrame { id: string; x: number; y: number; z: number; yaw: number; health: number; armor: number; alive: boolean; side: number; weapon: string; hasBomb: boolean }
export type UtilityKind = 'smoke' | 'flash' | 'he' | 'molotov' | 'decoy' | 'c4';
export interface Utility { id: string; kind: UtilityKind; x: number; y: number; z: number; startTick: number; endTick: number; playerId?: string }
export interface MatchEvent { tick: number; type: string; playerId?: string; targetId?: string; x?: number; y?: number; z?: number }
export interface Match { version: 1; map: string; tickRate: number; startTick: number; endTick: number; sampleInterval: number; players: Player[]; teams: Team[]; rounds: Round[]; events: MatchEvent[]; utility: Utility[]; framesFile: string; warnings: string[] }
export interface ReplayFrame { tick: number; players: PlayerFrame[] }
export interface PovVideo { playerId: string; steamId: string; path: string; proxyPath: string; videoStartTick: number; videoEndTick: number; tickRate: number; duration: number; fps: number; hasAudio: boolean; source: 'hlae' | 'imported'; syncVerified: boolean }
export interface Preferences { cs2Path: string; hlaePath: string; ffmpegPath: string; ffprobePath: string; demoPath: string; outputDirectory: string; resolution: 720 | 1080; fps: 30 | 60; jobTimeoutMinutes: number }
export interface MapSection { name: string; minZ: number; maxZ: number; image: string }
export interface MapOverview { name: string; pos_x: number; pos_y: number; scale: number; rotation: number; image: string; sections?: MapSection[]; provenance: string }
export type DrawKind = 'pen' | 'rectangle' | 'circle' | 'text' | 'line' | 'arrow' | UtilityKind;
export interface Drawing { id: string; kind: DrawKind; color: string; points: [number, number][]; text?: string }
export interface TacticStep { index: number; tick: number; players: PlayerFrame[]; utility: Utility[]; annotations: Drawing[]; captured: boolean }
export interface Tactic { id: string; name: string; map: string; team: string; demoPath: string; steps: TacticStep[] }
export interface Project { version: 1; name: string; directory: string; demoPath: string; matchDataPath: string; selectedTeam: string; pov: PovVideo[]; tactics: Tactic[]; preferences: Preferences; mock: boolean; customMap?: MapOverview }
export interface LoadedProject { project: Project; match: Match; frames: ReplayFrame[] }
export interface RenderJob { id: string; playerId: string; name: string; status: 'queued'|'starting'|'recording'|'encoding'|'completed'|'failed'|'cancelled'; elapsed: number; message: string; log: string[] }
export interface RenderUpdate { jobs: RenderJob[]; video?: PovVideo }
export interface DesktopApi {
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
}
declare global { interface Window { desktop: DesktopApi } }
