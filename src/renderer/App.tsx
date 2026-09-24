import { useCallback, useEffect, useRef, useState, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Download, FolderOpen, Grid2X2, Layers, Maximize, Pause, Play, Plus, Save, Settings, Shield, Video, Volume2, X, BookOpen, Languages } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useStore, getReplay } from './store';
import { playback } from '../video/PlaybackController';
import { coversTick } from '../video/clock';
import { Radar } from './Radar';
import { TacticalToolbar, TacticHeader } from './TacticalControls';
import { maps } from '../maps/catalog';
import type { LibraryTactic, LoadedProject, PlaybookLibrary, PovVideo, Preferences } from '../types';
import { ImportFromLinkDialog, ImportTacticDialog, PlaybookMain, PlaybookTree, SaveTacticDialog, ShareTacticDialog, ExportTacticDialog } from './PlaybookLibrary';
import i18n, { normalizeLanguage } from './i18n';
import './playbook.css';

const time = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60).toString().padStart(2, '0')}:${Math.floor(Math.max(0, seconds) % 60).toString().padStart(2, '0')}`;
const fail = (error: unknown) => useStore.getState().set({ error: String(error), busy: '' });
async function task(label: string, fn: () => Promise<unknown>) { useStore.getState().set({ busy: label, error: '' }); try { await fn(); } catch (error) { fail(error); } finally { useStore.getState().set({ busy: '' }); } }
async function save() { const state = useStore.getState(); if (!window.desktop) { state.set({ error: 'Project saving is available in the Electron desktop application.' }); return; } await task(i18n.t('app.savingProject'), async () => { const project = await window.desktop.saveProject(state.project, state.project.mock ? { match: state.match, frames: getReplay().frames } : undefined); if (project) useStore.getState().set({ project, dirty: false }); }); }

function IconButton({ icon: Icon, label, onClick, active = false, disabled = false }: { icon: LucideIcon; label: string; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return <button className={`icon-button ${active ? 'active' : ''}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}><Icon size={17} /></button>;
}

const VideoElement = memo(function VideoElement({ video, proxy = false, visible = true }: { video: PovVideo; proxy?: boolean; visible?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => playback.register(video.playerId, ref.current!, video, proxy), [video, proxy]);
  return <video ref={ref} className={`${proxy ? 'proxy' : 'main-video'} ${visible ? '' : 'hidden-video'}`} src={`${window.desktop?.mediaUrl(proxy ? video.proxyPath : video.path)}?rev=${video.revision ?? 0}`} preload="auto" playsInline muted={proxy} onEnded={() => { if (!proxy) useStore.getState().set({ playing: false }); }} onError={() => { if (!proxy) fail(i18n.t('app.videoDecodeFailed')); }} />;
});

interface PlaybookProps {
  library: PlaybookLibrary; selectedId: string | null; selectedFolderId: string | null;
  onSelectFolder(id: string | null): void; onOpenTactic(id: string): void; onRefresh(): Promise<void>;
  onSaveCurrent(folderId?: string | null): void; onImportFile(folderId?: string | null): Promise<void>;
  onImportBytes(bytes: Uint8Array, name: string, folderId?: string | null): Promise<void>; onImportLink(): void;
  onExportTactic(id: string): void; onShareTactic(id: string): void; onExportFolder(id: string): Promise<void>; onError(message: string): void;
}

function Sidebar({ libraryProps }: { libraryProps: PlaybookProps }) {
  const { t } = useTranslation(); const project = useStore(state => state.project), match = useStore(state => state.match), selected = useStore(state => state.selectedPlayer), mode = useStore(state => state.viewMode);
  const team = match.teams.find(value => value.id === project.selectedTeam);
  return <aside className={`sidebar ${mode === 'library' ? 'sidebar-library' : ''}`}>
    <nav className="side-navigation" aria-label={t('nav.analysis')}>
      <div className="side-nav-label">{t('nav.analysis')}</div>
      <button className={mode !== 'library' ? 'active' : ''} onClick={() => useStore.getState().set({ viewMode: 'tactical' })}><Grid2X2 size={14}/>{t('nav.replay')}</button>
      <button className={mode === 'library' ? 'active' : ''} onClick={() => { useStore.getState().set({ viewMode: 'library' }); void libraryProps.onRefresh(); }}><BookOpen size={14}/>{t('nav.playbooks')}</button>
    </nav>
    {mode === 'library' ? <PlaybookTree {...libraryProps}/> : <>
      <div className="section-label">{t('nav.teamPerspectives')} <span>5</span></div>
      <div className="pov-list">{team?.playerIds.slice(0, 5).map((id, index) => {
        const player = match.players.find(value => value.id === id)!; const video = project.pov.find(value => value.playerId === id);
        return <button aria-label={t('pov.playerAria', { number: index + 1, name: player.name })} className={`pov-tile ${selected === id && mode === 'pov' ? 'selected' : ''}`} key={id} onClick={() => useStore.getState().selectPlayer(id)}>
          <div className="tile-preview">{video ? <VideoElement video={video} proxy/> : <><Video size={24}/><span>{project.mock ? t('pov.mockNoVideo') : t('pov.notRendered')}</span></>}<kbd>{index + 1}</kbd>{video && <span className="ready-dot"/>}</div>
          <div className="tile-caption"><span>{player.name}</span><span className="tile-role">{t('pov.label', { number: String(index + 1).padStart(2, '0') })}</span></div>
        </button>;
      })}</div>
      <button aria-label={t('pov.tacticalView')} className={`tactical-tile ${mode === 'tactical' ? 'selected' : ''}`} onClick={() => useStore.getState().set({ viewMode: 'tactical' })}><Grid2X2 size={23}/><span>{t('pov.tacticalView')}<small>{t('pov.oneTimeline')}</small></span><kbd>6</kbd></button>
      <button className="create-playbook-shortcut" onClick={() => { useStore.getState().set({ viewMode: 'library' }); void libraryProps.onRefresh(); libraryProps.onSaveCurrent(null); }}><Plus size={14}/>{t('nav.createPlaybook')}</button>
      <div className="sidebar-footer"><span className="live-dot"/>{t('nav.localWorkspace')}<Shield size={13}/></div>
    </>}
  </aside>;
}

function Timeline() {
  const { t } = useTranslation(); const tick = useStore(state => state.currentTick), match = useStore(state => state.match), playing = useStore(state => state.playing), rate = useStore(state => state.playbackRate), volume = useStore(state => state.volume), roundNumber = useStore(state => state.selectedRound);
  const duration = (match.endTick - match.startTick) / match.tickRate;
  return <footer className="timeline"><div className="rounds"><span className="section-label">{t('timeline.rounds')}</span>{match.rounds.map(round => <button key={round.number} className={roundNumber === round.number ? 'active' : ''} onClick={() => { useStore.getState().set({ editing: false }); playback.seek(round.startTick); }}>R{round.number}</button>)}</div>
    <div className="scrubber"><div className="event-markers">{match.events.filter(event => ['player_death', 'bomb_planted', 'smokegrenade_detonate', 'inferno_startburn'].includes(event.type)).map((event, index) => <span key={index} title={`${event.type} · tick ${event.tick}`} className={event.type === 'player_death' ? 'kill' : event.type === 'bomb_planted' ? 'plant' : 'nade'} style={{ left: `${(event.tick - match.startTick) / (match.endTick - match.startTick) * 100}%` }} />)}</div><input aria-label={t('timeline.global')} type="range" min={match.startTick} max={match.endTick} step="1" value={tick} onChange={event => { useStore.getState().set({ editing: false }); playback.seek(+event.target.value); }} /></div>
    <div className="transport"><IconButton icon={ChevronLeft} label={t('timeline.back')} onClick={() => playback.seek(tick - match.tickRate)}/><button className="play-button" aria-label={playing ? t('timeline.pause') : t('timeline.play')} onClick={() => useStore.getState().set({ playing: !playing, editing: false })}>{playing ? <Pause size={18} fill="currentColor"/> : <Play size={18} fill="currentColor"/>}</button><IconButton icon={ChevronRight} label={t('timeline.forward')} onClick={() => playback.seek(tick + match.tickRate)}/>
      <span className="time-code">{time((tick - match.startTick) / match.tickRate)}<span> / {time(duration)}</span></span><span className="tick-code">{t('timeline.tick', { tick: tick.toLocaleString() })}</span><div className="transport-right"><Volume2 size={15}/><input aria-label={t('timeline.volume')} type="range" min="0" max="1" step=".01" value={volume} onChange={event => useStore.getState().set({ volume: +event.target.value })}/><select aria-label={t('timeline.speed')} value={rate} onChange={event => useStore.getState().set({ playbackRate: +event.target.value })}>{[.25, .5, 1, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select><IconButton icon={Maximize} label={t('timeline.fullscreen')} onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen(); }}/></div>
    </div>
  </footer>;
}

function PovStage({ hidden }: { hidden: boolean }) {
  const { t } = useTranslation(); const project = useStore(state => state.project), selected = useStore(state => state.selectedPlayer), tick = useStore(state => state.currentTick);
  const active = project.pov.find(video => video.playerId === selected), available = active && coversTick(tick, active);
  return <div className={`pov-stage ${hidden ? 'pov-stage-hidden' : ''}`} aria-hidden={hidden}>{project.pov.map(video => <VideoElement key={video.path} video={video} visible={video.playerId === selected && !!available}/>)}{!available && <div className="empty"><div className="empty-icon"><Video size={36}/></div><h2>{project.mock ? t('pov.mockEmpty') : active ? t('pov.outsideRange') : t('pov.prepareTeam')}</h2><p>{project.mock ? t('pov.openDemoToRender') : active ? t('pov.availableTicks', { start: active.videoStartTick, end: active.videoEndTick }) : t('pov.prepareDescription')}</p>{active && <button onClick={() => playback.seek(active.videoStartTick)}>{t('pov.recordingStart')}</button>}</div>}</div>;
}

function Status() { const tick = useStore(state => state.currentTick), match = useStore(state => state.match), round = match.rounds.find(value => tick >= value.startTick && tick <= value.endTick); return <><span className="score">{round?.score[0] ?? 0}<b>:</b>{round?.score[1] ?? 0}</span><span className="match-clock">{round ? time(Math.max(0, (round.freezeEndTick + 115 * match.tickRate - tick) / match.tickRate)) : '—'}</span></>; }

function PreferencesDialog({ close, onLanguage }: { close: () => void; onLanguage: (language: 'zh-CN' | 'en-US') => void }) {
  const { t } = useTranslation(); const project = useStore(state => state.project); const [preferences, setPreferences] = useState<Preferences>({ ...project.preferences });
  const fields: [keyof Preferences, string][] = [['cs2Path', t('settings.cs2')], ['hlaePath', t('settings.hlae')], ['ffmpegPath', t('settings.ffmpeg')], ['ffprobePath', t('settings.ffprobe')], ['demoPath', t('settings.demo')], ['outputDirectory', t('settings.output')]];
  return <div className="modal-backdrop"><section className="modal"><div className="modal-heading"><div><span className="eyebrow">{t('settings.engine')}</span><h2>{t('settings.title')}</h2></div><IconButton icon={X} label={t('settings.close')} onClick={close}/></div><p className="muted">{t('settings.description')}</p>
    <label className="field"><span>{t('settings.language')}</span><select value={normalizeLanguage(i18n.language)} onChange={event => onLanguage(event.target.value as 'zh-CN'|'en-US')}><option value="zh-CN">{t('language.zh')}</option><option value="en-US">{t('language.en')}</option></select></label>
    {fields.map(([key, label]) => <label className="field" key={key}><span>{label}</span><div><input aria-label={label} value={String(preferences[key])} onChange={event => setPreferences({ ...preferences, [key]: event.target.value })}/><button onClick={() => void task(t('app.selectingPath'), async () => { const file = key === 'outputDirectory' ? await window.desktop.pickDirectory() : await window.desktop.pickFile(key === 'demoPath' ? 'demo' : 'exe'); if (file) setPreferences(value => ({ ...value, [key]: file })); })}>{t('settings.browse')}</button></div></label>)}
    <div className="field-row"><label>{t('settings.resolution')}<select value={preferences.resolution} onChange={event => setPreferences({ ...preferences, resolution: +event.target.value as 720 | 1080 })}><option value="720">1280 × 720</option><option value="1080">1920 × 1080</option></select></label><label>{t('settings.frameRate')}<select value={preferences.fps} onChange={event => setPreferences({ ...preferences, fps: +event.target.value as 30 | 60 })}><option>30</option><option>60</option></select></label><label>{t('settings.timeout')}<input type="number" min="1" max="240" value={preferences.jobTimeoutMinutes} onChange={event => setPreferences({ ...preferences, jobTimeoutMinutes: +event.target.value })}/></label></div>
    <div className="modal-actions"><button onClick={() => void task(t('app.detectingTools'), async () => setPreferences({ ...preferences, ...await window.desktop.detect() }))}>{t('settings.autoDetect')}</button><button onClick={() => void task(t('app.importingOverview'), async () => { const map = await window.desktop.importOverview(); if (map) useStore.getState().patchProject({ customMap: map }); })}>{t('settings.importOverview')}</button><button className="primary" onClick={() => { useStore.getState().preferences(preferences); close(); }}>{t('settings.apply')}</button></div>
  </section></div>;
}

function RenderDialog({ close }: { close: () => void }) {
  const { t } = useTranslation(); const match = useStore(state => state.match), tick = useStore(state => state.currentTick), jobs = useStore(state => state.jobs), project = useStore(state => state.project); const round = match.rounds.find(value => tick >= value.startTick && tick <= value.endTick) ?? match.rounds[0];
  const [start, setStart] = useState(Math.max(round.freezeEndTick, match.startTick)), [end, setEnd] = useState(round.endTick); const active = jobs.some(job => ['waiting', 'launching', 'loading', 'recording', 'encoding', 'verifying'].includes(job.status));
  const statuses = { waiting: t('render.waiting'), launching: t('render.launching'), loading: t('render.loading'), recording: t('render.recording'), encoding: t('render.encoding'), verifying: t('render.verifying'), completed: t('render.complete'), failed: t('render.failed'), cancelled: t('render.cancelled') } as const;
  return <div className="modal-backdrop"><section className="modal render-modal"><div className="modal-heading"><div><span className="eyebrow">{t('render.eyebrow')}</span><h2>{t('render.title')}</h2></div><IconButton icon={X} label={t('render.close')} onClick={close}/></div><p className="muted">{t('render.description')}<br/>{t('render.compatibility')}</p>
    <div className="field-row"><label>{t('render.start')}<input aria-label={t('render.start')} type="number" min={match.startTick} max={match.endTick} value={start} onChange={event => setStart(+event.target.value)}/></label><label>{t('render.end')}<input aria-label={t('render.end')} type="number" value={end} onChange={event => setEnd(+event.target.value)}/></label><span>{t('render.playerSeconds', { seconds: ((end - start) / match.tickRate).toFixed(1) })}</span></div>
    <div className="render-jobs">{jobs.map((job, index) => <div className="render-job" key={job.id}><b>{index + 1}</b><div><strong>{job.name}</strong><small>{job.message}</small></div><span className={job.status}>{statuses[job.status]}</span><small>{time(job.elapsed)}</small></div>)}</div>{jobs.length > 0 && <details><summary>{t('render.log')}</summary><pre>{jobs.flatMap(job => job.log).join('\n')}</pre></details>}
    <div className="modal-actions"><button disabled={active || project.mock} onClick={() => void task(t('app.importingPov'), async () => { const state = useStore.getState(), video = await window.desktop.importVideo(state.project, state.selectedPlayer, start); if (video) state.patchProject({ pov: state.project.pov.filter(item => item.playerId !== video.playerId).concat(video) }); })}><Download size={15}/>{t('render.importVideo')}</button>{active ? <button className="danger" onClick={() => void window.desktop.cancelRender()}>{t('render.cancelRecording')}</button> : <button className="primary" disabled={project.mock || end <= start} onClick={() => { const state = useStore.getState(); state.set({ error: '' }); void window.desktop.render(state.project, state.match, start, end).catch(fail); }}><Video size={16}/>{t('render.renderFive')}</button>}</div>
    {project.mock && <p className="notice">{t('render.mockNotice')}</p>}
  </section></div>;
}

function LanguageSwitcher({ onChange }: { onChange: (language: 'zh-CN' | 'en-US') => void }) {
  const { t } = useTranslation(); const current = normalizeLanguage(i18n.language);
  return <label className="language-switcher" title={t('language.label')}><Languages size={14}/><select aria-label={t('language.label')} value={current} onChange={event => onChange(event.target.value as 'zh-CN' | 'en-US')}><option value="zh-CN">{t('language.zh')}</option><option value="en-US">{t('language.en')}</option></select></label>;
}

export function App() {
  const { t } = useTranslation(); const project = useStore(state => state.project), match = useStore(state => state.match), mode = useStore(state => state.viewMode), error = useStore(state => state.error), busy = useStore(state => state.busy), dirty = useStore(state => state.dirty), activeTacticIndex = useStore(state => state.activeTactic), selectedRound = useStore(state => state.selectedRound);
  const [modal, setModal] = useState<'preferences'|'render'|'save-tactic'|'import-tactic'|'export-tactic'|'share-tactic'|'import-link'|null>(null), [teamDialog, setTeamDialog] = useState(false), [library, setLibrary] = useState<PlaybookLibrary>({ folders: [], tactics: [] }), [libraryTacticId, setLibraryTacticId] = useState<string | null>(null), [libraryFolderId, setLibraryFolderId] = useState<string | null>(null), [targetTacticId, setTargetTacticId] = useState<string | null>(null), [targetFolderId, setTargetFolderId] = useState<string | null>(null);
  const refreshLibrary = useCallback(async () => { if (!window.desktop) return; setLibrary(await window.desktop.getPlaybookLibrary()); }, []);
  const openLibraryTactic = (id: string) => { setLibraryTacticId(id || null); if (id) { const item = library.tactics.find(value => value.id === id); if (item) setLibraryFolderId(item.folderId); } };
  const saveCurrentTactic = (folderId: string | null = libraryFolderId) => { setTargetFolderId(folderId); setModal('save-tactic'); };
  const importFile = async (folderId: string | null = libraryFolderId) => { setTargetFolderId(folderId); setModal('import-tactic'); };
  const importBytes = async (bytes: Uint8Array, name: string, folderId?: string | null) => { const tactic = await window.desktop.importTacticBytes(bytes, name, folderId); await refreshLibrary(); setLibraryTacticId(tactic.id); };
  const exportTactic = (id: string) => { setTargetTacticId(id); setModal('export-tactic'); };
  const shareTactic = (id: string) => { setTargetTacticId(id); setModal('share-tactic'); };
  const exportFolder = async (id: string) => { const count = await window.desktop.exportPlaybookFolder(id); if (count) await refreshLibrary(); };
  const onError = useCallback((message: string) => useStore.getState().set({ error: message }), []);
  const playbookProps: PlaybookProps = { library, selectedId: libraryTacticId, selectedFolderId: libraryFolderId, onSelectFolder: setLibraryFolderId, onOpenTactic: openLibraryTactic, onRefresh: refreshLibrary, onSaveCurrent: saveCurrentTactic, onImportFile: importFile, onImportBytes: importBytes, onImportLink: () => setModal('import-link'), onExportTactic: exportTactic, onShareTactic: shareTactic, onExportFolder: exportFolder, onError };

  useEffect(() => {
    const stop = playback.start();
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).matches('input,textarea,select') || modal || teamDialog || useStore.getState().viewMode === 'library') return;
      const state = useStore.getState();
      if (event.code === 'Space') { event.preventDefault(); state.set({ playing: !state.playing, editing: false }); }
      else if (/^[1-5]$/.test(event.key)) { const id = state.match.teams.find(team => team.id === state.project.selectedTeam)?.playerIds[+event.key - 1]; if (id) state.selectPlayer(id); }
      else if (event.key === '6' || event.key.toLowerCase() === 'm') state.set({ viewMode: 'tactical' });
      else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); state.set({ editing: false }); playback.seek(state.currentTick + (event.key === 'ArrowLeft' ? -1 : 1) * state.match.tickRate * (event.shiftKey ? 10 : 1)); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) state.redo(); else state.undo(); }
      else if (event.key === 'Delete' && state.selectedObject) state.editStep(step => ({ ...step, annotations: step.annotations.filter(drawing => drawing.id !== state.selectedObject) }));
    };
    window.addEventListener('keydown', key); return () => { stop(); window.removeEventListener('keydown', key); };
  }, [modal, teamDialog]);
  useEffect(() => { if (!window.desktop) return; void window.desktop.detect().then(preferences => { const state = useStore.getState(); if (state.project.mock) state.set({ project: { ...state.project, preferences } }); }).catch(fail); void refreshLibrary().catch(fail); void window.desktop.getLanguage().then(language => { if (language) return i18n.changeLanguage(normalizeLanguage(language)); }).catch(fail); const removeProgress = window.desktop.onProgress(message => useStore.getState().set({ busy: message })); const removeRender = window.desktop.onRender(({ jobs, video }) => { const state = useStore.getState(); state.set({ jobs }); if (video) state.patchProject({ pov: state.project.pov.filter(item => item.playerId !== video.playerId).concat(video) }); }); return () => { removeProgress(); removeRender(); }; }, [refreshLibrary]);
  useEffect(() => { window.desktop?.setDirty(dirty); }, [dirty]);
  const changeLanguage = async (language: 'zh-CN'|'en-US') => { await i18n.changeLanguage(language); await window.desktop.setLanguage(language); };
  const accept = (data: LoadedProject | null, choose = false) => { if (data) { useStore.getState().load(data); setTeamDialog(choose); } };
  const map = project.customMap ?? maps[match.map];
  const selectedTactic = library.tactics.find(item => item.id === targetTacticId);
  const finishSaveTactic = async (tactic: LibraryTactic) => { setModal(null); await refreshLibrary(); setLibraryTacticId(tactic.id); };
  const finishImport = async () => { setModal(null); await refreshLibrary(); };
  const finishExport = () => setModal(null);
  const statusText = mode === 'library' ? t('nav.playbooks') : project.mock ? t('app.localStatus') : t('app.roundSummary', { players: match.players.length, rounds: match.rounds.length, povs: project.pov.length });

  return <div className="app">
    <header className="header"><div className="brand"><div className="brand-mark"><Layers size={21}/></div><div>TACTIC<span>LAB</span><small>{t('brand.subtitle')}</small></div></div><div className="header-divider"/><span className="project-name" title={project.name}>{project.mock ? t('app.practiceWorkspace') : project.name}{dirty && <em/>}</span><div className="header-actions"><span className={`badge ${project.mock ? 'mock' : ''}`}>{project.mock ? t('app.mockOnly') : t('app.localDemo')}</span><button onClick={() => void task(t('app.openingDemo'), async () => accept(await window.desktop.importDemo(), true))}><Plus size={16}/>{t('app.openDemo')}</button><IconButton icon={FolderOpen} label={t('app.openProject')} onClick={() => void task(t('app.openingProject'), async () => accept(await window.desktop.openProject()))}/><IconButton icon={Save} label={t('app.saveProject')} onClick={() => void save()}/><LanguageSwitcher onChange={language => void changeLanguage(language).catch(fail)}/><IconButton icon={Settings} label={t('app.settings')} onClick={() => setModal('preferences')}/></div></header>
    <div className="workspace"><Sidebar libraryProps={playbookProps}/><main className={`main ${mode}-view`}>
      {mode === 'library' ? <PlaybookMain {...playbookProps}/> : <>
        <div className="match-bar"><div><span className="map-pill">{match.map.replace('de_', '').toUpperCase()}</span><button className="team-name" onClick={() => setTeamDialog(true)}>{match.teams.find(team => team.id === project.selectedTeam)?.name}<ChevronRight size={14}/></button><Status/></div><div className="match-actions"><span>{match.tickRate} TICK</span><button className="prepare" onClick={() => setModal('render')}><Video size={15}/>{t('app.preparePovs')}</button></div></div>
        <div className="view-header"><div><span className="eyebrow">{mode === 'tactical' ? t('app.planRound') : t('app.playerPerspective')}</span><h1>{mode === 'tactical' ? t('app.tacticalWorkspace') : match.players.find(player => player.id === useStore.getState().selectedPlayer)?.name}</h1></div><div className="view-tabs"><button className={mode === 'pov' ? 'active' : ''} onClick={() => useStore.getState().set({ viewMode: 'pov', editing: false })}><Video size={14}/>{t('app.pov')}</button><button className={mode === 'tactical' ? 'active' : ''} onClick={() => useStore.getState().set({ viewMode: 'tactical' })}><Grid2X2 size={14}/>{t('app.tactical')}</button></div></div>
        <div className="stage">{mode === 'tactical' && <><TacticHeader map={map}/><Radar/><TacticalToolbar onSave={() => void save()} onOpen={() => void task(t('app.openingProject'), async () => accept(await window.desktop.openProject()))} onSettings={() => setModal('preferences')}/></>}<PovStage hidden={mode === 'tactical'}/></div>
        <Timeline/>
      </>}
    </main></div>
    <div className="statusbar"><span><span className="live-dot"/>{statusText}</span>{mode !== 'library' && <span>{t('app.keyboardShortcuts')}</span>}</div>
    {busy && <div className="busy"><span className="spinner"/>{busy}</div>}{error && <div className="error-toast" role="alert"><strong>{t('app.actionFailed')}</strong><p>{error}</p><button aria-label={t('app.dismissError')} onClick={() => useStore.getState().set({ error: '' })}><X size={16}/></button></div>}
    {modal === 'preferences' && <PreferencesDialog close={() => setModal(null)} onLanguage={language => void changeLanguage(language).catch(fail)}/>} {modal === 'render' && <RenderDialog close={() => setModal(null)}/>}
    {modal === 'save-tactic' && <SaveTacticDialog project={project} match={match} folders={library.folders} selectedRound={selectedRound} activeTacticIndex={activeTacticIndex} defaultFolderId={targetFolderId} close={() => setModal(null)} saved={finishSaveTactic} onError={onError}/>}
    {modal === 'import-tactic' && <ImportTacticDialog folders={library.folders} close={() => setModal(null)} imported={() => void finishImport()} onError={onError}/>}
    {modal === 'export-tactic' && selectedTactic && <ExportTacticDialog tactic={selectedTactic} close={() => setModal(null)} exported={finishExport} onError={onError}/>}
    {modal === 'share-tactic' && selectedTactic && <ShareTacticDialog tactic={selectedTactic} onClose={() => setModal(null)} onExport={() => setModal('export-tactic')} onRefresh={refreshLibrary} onError={onError}/>}
    {modal === 'import-link' && <ImportFromLinkDialog folders={library.folders} close={() => setModal(null)} imported={() => void finishImport()} onError={onError}/>}
    {teamDialog && <div className="modal-backdrop"><section className="modal team-modal"><span className="eyebrow">{t('team.eyebrow')}</span><h2>{t('team.title')}</h2><p className="muted">{t('team.description')}</p><div className="team-choices">{match.teams.map(team => <button key={team.id} onClick={() => { const state = useStore.getState(); state.patchProject({ selectedTeam: team.id }); state.set({ selectedPlayer: team.playerIds[0], editing: false }); setTeamDialog(false); }}><Shield size={25}/><h3>{team.name}</h3>{team.playerIds.map(id => <span key={id}>{match.players.find(player => player.id === id)?.name}</span>)}</button>)}</div><button onClick={() => setTeamDialog(false)}>{t('team.close')}</button></section></div>}
  </div>;
}
