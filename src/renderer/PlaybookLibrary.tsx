import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Copy, Download, ExternalLink, FileUp, Folder, FolderPlus, Grid2X2, Link2, MoreHorizontal, Play, Plus, Search, Share2, Trash2, Video, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { maps } from '../maps/catalog';
import { worldToRadar } from '../maps/coordinates';
import type { ExportTacticOptions, LibraryFolder, LibraryTactic, PlaybookLibrary, Project, Match, ShareResult, ShareStatus, SharedTacticPreview, TacticStep } from '../types';
import i18n from './i18n';

type MenuTarget = { kind: 'folder' | 'tactic'; id: string };
type Props = {
  library: PlaybookLibrary; selectedId: string | null; selectedFolderId: string | null;
  onSelectFolder(id: string | null): void; onOpenTactic(id: string): void; onRefresh(): Promise<void>;
  onSaveCurrent(folderId?: string | null): void; onImportFile(folderId?: string | null): Promise<void>; onImportLink(): void;
  onImportBytes(bytes: Uint8Array, name: string, folderId?: string | null): Promise<void>;
  onExportTactic(id: string): void; onShareTactic(id: string): void; onExportFolder(id: string): Promise<void>;
  onError(message: string): void;
};

function safeRun(fn: () => Promise<unknown>, onError: (value: string) => void, onDone: () => void) {
  void fn().then(onDone).catch(error => onError(String(error)));
}

function fileDrop(event: React.DragEvent, folderId: string | null, onImport: Props['onImportBytes'], onError: Props['onError'], onDone: Props['onRefresh']) {
  const file = event.dataTransfer.files[0];
  if (!file) return false;
  event.preventDefault();
  if (!file.name.toLowerCase().endsWith('.cstactic')) { onError(i18n.t('library.chooseArchive')); return true; }
  if (file.size > 128 * 1024 * 1024) { onError(i18n.t('library.archiveTooLarge')); return true; }
  void file.arrayBuffer().then(data => onImport(new Uint8Array(data), file.name, folderId)).then(onDone).catch(error => onError(String(error)));
  return true;
}

function FolderNameDialog({ initial = '', title, close, save }: { initial?: string; title: string; close: () => void; save: (name: string) => void }) {
  const { t } = useTranslation(); const [value, setValue] = useState(initial);
  return <div className="modal-backdrop"><form className="modal library-modal small-modal" onSubmit={event => { event.preventDefault(); if (value.trim()) save(value.trim()); }}>
    <div className="modal-heading"><div><span className="eyebrow">{t('library.myPlaybooks')}</span><h2>{title}</h2></div><button type="button" className="icon-button" aria-label={t('library.cancel')} onClick={close}><X size={17}/></button></div>
    <label className="field"><span>{t('library.name')}</span><input autoFocus maxLength={120} value={value} onChange={event => setValue(event.target.value)}/></label>
    <div className="modal-actions"><button type="button" onClick={close}>{t('library.cancel')}</button><button className="primary" disabled={!value.trim()}>{t('library.createFolder')}</button></div>
  </form></div>;
}

export function PlaybookTree({ library, selectedId, selectedFolderId, onSelectFolder, onOpenTactic, onRefresh, onSaveCurrent, onImportBytes, onExportTactic, onShareTactic, onExportFolder, onError }: Props) {
  const { t } = useTranslation(); const [expanded, setExpanded] = useState<Set<string>>(() => new Set(library.folders.filter(folder => !folder.parentId).map(folder => folder.id)));
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget | null } | null>(null);
  const [folderDialog, setFolderDialog] = useState<{ id: string | null; name?: string } | null>(null);
  const [renameTactic, setRenameTactic] = useState<LibraryTactic | null>(null);
  const foldersByParent = useMemo(() => groupBy(library.folders, folder => folder.parentId ?? ''), [library.folders]);
  const tacticsByFolder = useMemo(() => groupBy(library.tactics, tactic => tactic.folderId ?? ''), [library.tactics]);
  const toggle = (id: string) => setExpanded(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const createFolder = (parentId: string | null) => setFolderDialog({ id: parentId });
  const createTactic = (folderId: string | null) => { setMenu(null); onSelectFolder(folderId); onSaveCurrent(folderId); };
  const dragItem = (event: React.DragEvent) => { try { return JSON.parse(event.dataTransfer.getData('application/x-tacticlab-item')) as { kind: 'folder' | 'tactic'; id: string }; } catch { return null; } };
  const dropOn = (event: React.DragEvent, folderId: string | null) => {
    if (event.dataTransfer.files.length) { fileDrop(event, folderId, onImportBytes, onError, onRefresh); return; }
    event.preventDefault(); const item = dragItem(event); if (!item) return;
    safeRun(() => item.kind === 'folder' ? window.desktop.movePlaybookFolder(item.id, folderId) : window.desktop.moveLibraryTactic(item.id, folderId), onError, () => { onSelectFolder(folderId); void onRefresh(); });
  };
  const context = (event: React.MouseEvent, target: MenuTarget) => { event.preventDefault(); setMenu({ x: Math.min(event.clientX, innerWidth - 215), y: Math.min(event.clientY, innerHeight - 300), target }); };
  const contextActions = (target: MenuTarget | null) => {
    const folder = target?.kind === 'folder', id = target?.id;
    return [
      { label: t('library.newFolder'), icon: FolderPlus, action: () => createFolder(folder && id ? id : null) },
      { label: t('library.newTactic'), icon: Plus, action: () => createTactic(folder && id ? id : null) },
      ...(target?.id ? [{ label: t('library.rename'), icon: MoreHorizontal, action: () => {
        if (folder) { const item = library.folders.find(value => value.id === id); if (item) setFolderDialog({ id: id ?? null, name: item.name }); }
        else { const item = library.tactics.find(value => value.id === id); if (item) setRenameTactic(item); }
      } }] : []),
      ...(folder && id ? [{ label: t('library.exportFolder'), icon: Download, action: () => safeRun(() => onExportFolder(id!), onError, () => setMenu(null)) }] : []),
      ...(!folder && target ? [
        { label: t('library.duplicate'), icon: Copy, action: () => safeRun(() => window.desktop.duplicateLibraryTactic(id!), onError, () => { setMenu(null); void onRefresh(); }) },
        { label: t('library.export'), icon: Download, action: () => { setMenu(null); onExportTactic(id!); } },
        { label: t('library.share'), icon: Share2, action: () => { setMenu(null); onShareTactic(id!); } },
      ] : []),
      ...(target?.id ? [{ label: t('library.delete'), icon: Trash2, action: () => {
        if (folder) {
          if (confirm(t('library.deleteFolderConfirm'))) safeRun(() => window.desktop.deletePlaybookFolder(id!), onError, () => { setMenu(null); onSelectFolder(null); void onRefresh(); });
        } else {
          const item = library.tactics.find(value => value.id === id);
          if (item && confirm(t('library.deleteTacticConfirm', { name: item.name }))) safeRun(() => window.desktop.deleteLibraryTactic(id!), onError, () => { setMenu(null); if (selectedId === id) onOpenTactic(''); void onRefresh(); });
        }
      } }] : []),
    ];
  };
  const renderFolder = (folder: LibraryFolder, depth: number): React.ReactNode => {
    const children = foldersByParent.get(folder.id) ?? [], tactics = tacticsByFolder.get(folder.id) ?? [], isOpen = expanded.has(folder.id);
    return <div className="playbook-branch" key={folder.id}>
      <div className={`playbook-row folder-row ${selectedFolderId === folder.id ? 'selected' : ''}`} style={{ '--tree-depth': depth } as React.CSSProperties}
        draggable onDragStart={event => event.dataTransfer.setData('application/x-tacticlab-item', JSON.stringify({ kind: 'folder', id: folder.id }))}
        onDragOver={event => event.preventDefault()} onDrop={event => dropOn(event, folder.id)}
        onClick={() => { toggle(folder.id); onSelectFolder(folder.id); }} onContextMenu={event => context(event, { kind: 'folder', id: folder.id })}>
        <button className="tree-disclosure" aria-label={isOpen ? t('library.collapse') : t('library.expand')} onClick={event => { event.stopPropagation(); toggle(folder.id); }}>{isOpen ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button>
        <Folder size={15}/><span title={folder.name}>{folder.name}</span><small>{t('library.folderCount', { count: tactics.length + children.length })}</small>
      </div>
      {isOpen && <div className="playbook-children">{children.map(item => renderFolder(item, depth + 1))}{tactics.map(item => renderTactic(item, depth + 1))}</div>}
    </div>;
  };
  const renderTactic = (tactic: LibraryTactic, depth: number) => <div key={tactic.id} className={`playbook-row tactic-row ${selectedId === tactic.id ? 'selected' : ''}`} style={{ '--tree-depth': depth } as React.CSSProperties}
    draggable onDragStart={event => event.dataTransfer.setData('application/x-tacticlab-item', JSON.stringify({ kind: 'tactic', id: tactic.id }))}
    onDragOver={event => event.preventDefault()} onDrop={event => dropOn(event, tactic.folderId)}
    onClick={() => onOpenTactic(tactic.id)} onDoubleClick={() => onOpenTactic(tactic.id)} onContextMenu={event => context(event, { kind: 'tactic', id: tactic.id })}>
    <span className="tree-indent"/><Grid2X2 size={14}/><span title={tactic.name}>{tactic.name}</span>
  </div>;
  return <div className="playbook-tree" onDragOver={event => event.preventDefault()} onDrop={event => dropOn(event, null)} onClick={() => menu && setMenu(null)}>
    <div className="tree-heading"><span>{t('library.myPlaybooks')}</span><button className="icon-button" aria-label={t('library.newFolder')} title={t('library.newFolder')} onClick={() => createFolder(null)}><FolderPlus size={15}/></button></div>
    <div className={`playbook-row root-row ${selectedFolderId === null ? 'selected' : ''}`} onClick={() => onSelectFolder(null)} onContextMenu={event => context(event, { kind: 'folder', id: '' })}>
      <Folder size={15}/><span>{t('library.rootFolder')}</span>
    </div>
    <div className="tree-scroll" onDragOver={event => event.preventDefault()} onDrop={event => dropOn(event, null)}>
      {(foldersByParent.get('') ?? []).map(folder => renderFolder(folder, 0))}
      {(tacticsByFolder.get('') ?? []).map(tactic => renderTactic(tactic, 0))}
      {!library.folders.length && !library.tactics.length && <p className="tree-empty">{t('library.emptyDescription')}</p>}
    </div>
    <p className="tree-hint">{t('library.dragHint')}</p>
    {menu && <div className="tree-menu" style={{ left: menu.x, top: menu.y }} role="menu" aria-label={t('library.contextMenu')} onClick={event => event.stopPropagation()}>
      {contextActions(menu.target).map(({ label, icon: Icon, action }, index) => <button key={`${label}-${index}`} role="menuitem" onClick={() => { action(); setMenu(null); }}><Icon size={14}/>{label}</button>)}
    </div>}
    {folderDialog && <FolderNameDialog title={folderDialog.name ? t('library.rename') : t('library.newFolder')} initial={folderDialog.name} close={() => setFolderDialog(null)} save={name => {
      const task = folderDialog.name ? window.desktop.renamePlaybookFolder(folderDialog.id!, name) : window.desktop.createPlaybookFolder(name, folderDialog.id);
      safeRun(() => task, onError, () => { setFolderDialog(null); if (folderDialog.id) setExpanded(old => new Set(old).add(folderDialog.id!)); void onRefresh(); });
    }}/>}
    {renameTactic && <FolderNameDialog title={t('library.rename')} initial={renameTactic.name} close={() => setRenameTactic(null)} save={name => safeRun(() => window.desktop.updateLibraryTactic(renameTactic.id, { name }), onError, () => { setRenameTactic(null); void onRefresh(); })}/>}
  </div>;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string) { const result = new Map<string, T[]>(); for (const item of items) { const key = keyOf(item), value = result.get(key) ?? []; value.push(item); result.set(key, value); } return result; }

function StepRadar({ tactic, step }: { tactic: LibraryTactic; step: TacticStep }) {
  const canvas = useRef<HTMLCanvasElement>(null), host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = canvas.current, container = host.current; if (!element || !container) return;
    const map = maps[tactic.map]; if (!map) return;
    let alive = true, animation = 0; const image = new Image(); image.src = map.image;
    const ctx = element.getContext('2d'); if (!ctx) return;
    const paint = () => {
      if (!alive) return;
      const size = Math.max(180, Math.floor(Math.min(container.clientWidth, container.clientHeight || container.clientWidth)));
      const dpr = devicePixelRatio || 1; if (element.width !== size * dpr) { element.width = size * dpr; element.height = size * dpr; element.style.width = `${size}px`; element.style.height = `${size}px`; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#101518'; ctx.fillRect(0, 0, size, size);
      if (image.complete && image.naturalWidth) { ctx.globalAlpha = .83; ctx.drawImage(image, 0, 0, size, size); ctx.globalAlpha = 1; }
      const captured = tactic.steps.filter(value => value.captured && value.players.length);
      const ids = tactic.players.map(player => player.id);
      for (const id of ids) {
        const color = tactic.players.find(player => player.id === id)?.teamId === '3' ? '#78c5fa' : '#edc66d';
        ctx.beginPath(); ctx.strokeStyle = `${color}75`; ctx.lineWidth = 2;
        let started = false;
        for (const snapshot of captured) { const player = snapshot.players.find(item => item.id === id); if (!player) { started = false; continue; } const [x, y] = worldToRadar(map, player.x, player.y, player.z); if (!started) { ctx.moveTo(x * size, y * size); started = true; } else ctx.lineTo(x * size, y * size); }
        ctx.stroke();
      }
      for (const item of step.utility) { const [x, y] = worldToRadar(map, item.x, item.y, item.z); const color = item.kind === 'smoke' ? '#b7d5d9' : item.kind === 'flash' ? '#fff4a6' : item.kind === 'he' ? '#f3866e' : '#fb8c53'; ctx.globalAlpha = .3; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x * size, y * size, item.kind === 'smoke' ? 29 : 17, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; ctx.strokeStyle = color; ctx.stroke(); }
      for (const player of step.players) {
        const [u, v] = worldToRadar(map, player.x, player.y, player.z), x = u * size, y = v * size; const color = player.side === 3 ? '#78c5fa' : '#edc66d';
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill(); const direction = (-player.yaw + map.rotation) * Math.PI / 180; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(direction) * 18, y + Math.sin(direction) * 18); ctx.strokeStyle = color; ctx.stroke();
        const name = tactic.players.find(value => value.id === player.id)?.name ?? player.id; ctx.font = '10px Segoe UI'; const width = ctx.measureText(name).width; ctx.fillStyle = '#101518e8'; ctx.fillRect(x - width / 2 - 4, y + 10, width + 8, 17); ctx.fillStyle = '#edf2f3'; ctx.textAlign = 'center'; ctx.fillText(name, x, y + 22);
      }
      for (const drawing of step.annotations) {
        if (!drawing.points.length) continue; const points = drawing.points.map(([x, y]) => [x * size, y * size]); const [x, y] = points[0], [ex, ey] = points.at(-1)!;
        ctx.strokeStyle = drawing.color; ctx.fillStyle = drawing.color; ctx.lineWidth = 2; ctx.beginPath();
        if (drawing.kind === 'rectangle') ctx.strokeRect(x, y, ex - x, ey - y);
        else if (drawing.kind === 'circle') { ctx.ellipse((x + ex) / 2, (y + ey) / 2, Math.max(1, Math.abs(ex - x) / 2), Math.max(1, Math.abs(ey - y) / 2), 0, 0, Math.PI * 2); ctx.stroke(); }
        else if (drawing.kind === 'text') { ctx.fillText(drawing.text ?? '', x, y); }
        else { ctx.moveTo(x, y); points.slice(1).forEach(([px, py]) => ctx.lineTo(px, py)); ctx.stroke(); }
      }
      animation = requestAnimationFrame(paint);
    };
    image.onload = () => { if (alive) paint(); }; image.onerror = () => { if (alive) paint(); }; paint();
    const observer = new ResizeObserver(paint); observer.observe(container);
    return () => { alive = false; cancelAnimationFrame(animation); observer.disconnect(); };
  }, [tactic, step]);
  const { t } = useTranslation();
  return <div className="tactic-radar" ref={host}><canvas ref={canvas} aria-label={t('library.savedSnapshot')}/></div>;
}

function TacticViewer({ tactic, onBack, onExport, onShare, onError }: { tactic: LibraryTactic; onBack: () => void; onExport: () => void; onShare: () => void; onError: (message: string) => void }) {
  const { t } = useTranslation(); const [perspective, setPerspective] = useState<'2d' | string>('2d'), [stepIndex, setStepIndex] = useState(0), [tick, setTick] = useState(tactic.startTick ?? tactic.steps[0]?.tick ?? 0), [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null), step = tactic.steps[stepIndex], activeVideo = tactic.videos.find(video => video.playerId === perspective), totalStart = tactic.startTick ?? Math.min(...tactic.steps.map(value => value.tick)), totalEnd = tactic.endTick ?? Math.max(totalStart + 1, ...tactic.steps.map(value => value.tick));
  useEffect(() => { setPlaying(false); setPerspective('2d'); setStepIndex(0); setTick(tactic.startTick ?? tactic.steps[0]?.tick ?? 0); }, [tactic.id]);
  useEffect(() => { const video = videoRef.current; if (!video || !activeVideo) return; const target = Math.max(0, Math.min(activeVideo.duration || activeVideo.duration, (tick - activeVideo.startTick) / tactic.tickRate)); if (Number.isFinite(target) && Math.abs(video.currentTime - target) > .12) video.currentTime = target; if (playing) void video.play().catch(error => onError(String(error))); else video.pause(); }, [tick, perspective, playing, activeVideo, tactic.tickRate, onError]);
  useEffect(() => { if (!playing) return; const handle = window.setInterval(() => setTick(value => { if (value >= totalEnd) { setPlaying(false); return totalEnd; } return Math.min(totalEnd, value + Math.max(1, Math.round(tactic.tickRate / 10))); }), 100); return () => clearInterval(handle); }, [playing, totalEnd, tactic.tickRate]);
  const selectStep = (index: number) => { setPlaying(false); setStepIndex(index); const target = tactic.steps[index]; if (target.captured) setTick(Math.max(totalStart, Math.min(totalEnd, target.tick))); };
  const minutes = (value: number) => `${Math.floor(Math.max(0, value) / 60).toString().padStart(2, '0')}:${Math.floor(Math.max(0, value) % 60).toString().padStart(2, '0')}`;
  return <div className="playbook-viewer">
    <div className="library-viewer-head"><button onClick={onBack}><ArrowLeft size={15}/>{t('library.backToLibrary')}</button><div className="viewer-title"><h1>{tactic.name}</h1><span>{tactic.map.replace('de_', '').toUpperCase()} · {tactic.side || '—'} · {tactic.roundNumber ? `${t('library.round')} ${tactic.roundNumber}` : t('library.round')} {tactic.roundNumber ?? '—'}</span></div><div className="viewer-actions"><button onClick={onExport}><Download size={14}/>{t('library.export')}</button><button onClick={onShare}><Share2 size={14}/>{t('library.share')}</button></div></div>
    {tactic.description && <p className="viewer-description">{tactic.description}</p>}
    <div className="perspective-tabs"><button className={perspective === '2d' ? 'active' : ''} onClick={() => setPerspective('2d')}><Grid2X2 size={14}/>{t('library.tacticalView')}</button>{tactic.players.slice(0, 5).map((player, index) => <button key={player.id} className={perspective === player.id ? 'active' : ''} onClick={() => setPerspective(player.id)}><Video size={13}/><span>{index + 1}. {player.name}</span></button>)}</div>
    <div className={`library-viewer-stage ${perspective === '2d' ? 'radar-mode' : 'video-mode'}`}>
      {perspective === '2d' ? <StepRadar tactic={tactic} step={step}/> : activeVideo?.proxyPath || activeVideo?.fullPath ? <video ref={videoRef} className="library-pov-video" src={window.desktop.mediaUrl(activeVideo.proxyPath || activeVideo.fullPath!)} controls playsInline muted/> : <div className="library-no-video"><Video size={30}/><span>{t('library.noVideo')}</span><small>{t('library.sourceDemoMissing')}</small></div>}
    </div>
    <div className="viewer-steps"><span>{t('library.steps')}</span>{tactic.steps.map((item, index) => <button key={item.index} aria-label={t('tactics.step', { number: index + 1 })} title={t('library.stepDetail', { number: index + 1, tick: item.tick })} className={`${stepIndex === index ? 'active' : ''} ${item.captured ? 'captured' : ''}`} onClick={() => selectStep(index)}>{index + 1}{item.captured && <i/>}</button>)}<span className="viewer-step-caption">{t('library.stepDetail', { number: stepIndex + 1, tick: step.tick })}</span><button className="viewer-play" aria-label={playing ? t('timeline.pause') : t('timeline.play')} onClick={() => setPlaying(value => !value)}>{playing ? 'Ⅱ' : <Play size={13}/>}</button></div>
    <div className="viewer-timeline"><input aria-label={t('timeline.global')} type="range" min={totalStart} max={Math.max(totalStart + 1, totalEnd)} step="1" value={Math.max(totalStart, Math.min(totalEnd, tick))} onChange={event => { setPlaying(false); setTick(+event.target.value); }}/><span>{minutes((tick - totalStart) / tactic.tickRate)} / {minutes((totalEnd - totalStart) / tactic.tickRate)}</span><span>Tick {tick}</span></div>
    <div className="viewer-detail-grid"><article><h3>{t('library.description')}</h3><p>{tactic.description || '—'}</p>{tactic.tags.length > 0 && <div className="tag-list">{tactic.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}</article><article><h3>{t('library.povs', { count: tactic.videos.length })}</h3><p>{t('library.sourceDemoMissing')}</p></article></div>
  </div>;
}

export function PlaybookMain({ library, selectedId, selectedFolderId, onOpenTactic, onRefresh, onSaveCurrent, onImportFile, onImportBytes, onExportTactic, onShareTactic, onError, onImportLink }: Props) {
  const { t } = useTranslation(); const [query, setQuery] = useState(''), [mapFilter, setMapFilter] = useState(''), [sideFilter, setSideFilter] = useState('');
  const selected = library.tactics.find(tactic => tactic.id === selectedId) ?? null;
  const folderPath = (id: string | null) => { const parts: string[] = []; let current = library.folders.find(folder => folder.id === id); while (current) { parts.unshift(current.name); current = library.folders.find(folder => folder.id === current!.parentId); } return parts.join(' / '); };
  const results = useMemo(() => library.tactics.filter(tactic => {
    const haystack = [tactic.name, tactic.description, tactic.map, tactic.side, ...tactic.tags, folderPath(tactic.folderId)].join(' ').toLocaleLowerCase();
    return (!query || haystack.includes(query.toLocaleLowerCase())) && (!mapFilter || tactic.map === mapFilter) && (!sideFilter || tactic.side === sideFilter) && (selectedFolderId === null || tactic.folderId === selectedFolderId);
  }), [library, query, mapFilter, sideFilter, selectedFolderId]);
  const mapsList = [...new Set(library.tactics.map(tactic => tactic.map))].sort(); const sides = [...new Set(library.tactics.map(tactic => tactic.side).filter(Boolean))].sort();
  const handleDrop = (event: React.DragEvent) => {
    if (fileDrop(event, selectedFolderId, onImportBytes, onError, onRefresh)) return;
  };
  if (selected) return <TacticViewer tactic={selected} onBack={() => onOpenTactic('')} onExport={() => onExportTactic(selected.id)} onShare={() => onShareTactic(selected.id)} onError={onError}/>;
  return <div className="playbook-main" onDragOver={event => event.preventDefault()} onDrop={handleDrop}>
    <header className="library-page-header"><div><span className="eyebrow">{t('library.libraryPage')}</span><h1>{t('library.myPlaybooks')}</h1><p>{t('library.dragHint')}</p></div><div className="library-header-actions"><button onClick={() => onSaveCurrent(selectedFolderId)}><Plus size={15}/>{t('library.newTactic')}</button><button onClick={() => void onImportFile(selectedFolderId)}><FileUp size={15}/>{t('library.import')}</button><button onClick={onImportLink}><Link2 size={14}/>{t('library.importFromLink')}</button></div></header>
    <div className="library-filter-bar"><label className="library-search"><Search size={15}/><input aria-label={t('library.search')} placeholder={t('library.search')} value={query} onChange={event => setQuery(event.target.value)}/></label><select aria-label={t('library.mapFilter')} value={mapFilter} onChange={event => setMapFilter(event.target.value)}><option value="">{t('library.mapFilter')}</option>{mapsList.map(map => <option key={map} value={map}>{map.replace('de_', '')}</option>)}</select><select aria-label={t('library.sideFilter')} value={sideFilter} onChange={event => setSideFilter(event.target.value)}><option value="">{t('library.sideFilter')}</option>{sides.map(side => <option key={side} value={side}>{side}</option>)}</select><span>{t('library.searchResults', { count: results.length })}</span></div>
    <div className="library-card-grid">
      {results.map(tactic => <button key={tactic.id} className="library-tactic-card" onClick={() => onOpenTactic(tactic.id)} onDoubleClick={() => onOpenTactic(tactic.id)} onContextMenu={event => event.preventDefault()} draggable onDragStart={event => event.dataTransfer.setData('application/x-tacticlab-item', JSON.stringify({ kind: 'tactic', id: tactic.id }))}>
        <div className="tactic-card-radar"><Grid2X2 size={21}/><span>{tactic.map.replace('de_', '').toUpperCase()}</span></div><div className="tactic-card-content"><div className="tactic-card-meta"><span className={tactic.side.toUpperCase().startsWith('CT') ? 'ct-tag' : 't-tag'}>{tactic.side || '—'}</span><span>{tactic.map.replace('de_', '')}</span><span>{t('library.round')} {tactic.roundNumber ?? '—'}</span></div><h2>{tactic.name}</h2><p>{tactic.description || '—'}</p><div className="tactic-card-footer"><span>{t('library.steps')}: {tactic.steps.filter(step => step.captured).length}/4</span><span>{t('library.povs', { count: tactic.videos.filter(video => !!video.proxyPath).length })}</span><span title={folderPath(tactic.folderId)}>{folderPath(tactic.folderId) || t('library.all')}</span></div></div>
      </button>)}
      {!results.length && <div className="library-empty"><Folder size={28}/><h2>{query || selectedFolderId ? t('library.emptyFolder') : t('library.empty')}</h2><p>{t('library.emptyDescription')}</p><button onClick={() => onSaveCurrent(selectedFolderId)}><Plus size={15}/>{t('library.saveAsTactic')}</button></div>}
    </div>
  </div>;
}

export function SaveTacticDialog({ project, match, folders, selectedRound, activeTacticIndex, defaultFolderId = null, close, saved, onError }: { project: Project; match: Match; folders: LibraryFolder[]; selectedRound: number; activeTacticIndex: number; defaultFolderId?: string | null; close: () => void; saved: (tactic: LibraryTactic) => void; onError: (message: string) => void }) {
  const { t } = useTranslation(); const active = project.tactics[activeTacticIndex]; const round = match.rounds.find(value => value.number === selectedRound) ?? match.rounds[0];
  const [name, setName] = useState(active?.name ?? ''), [description, setDescription] = useState(''), [map, setMap] = useState(active?.map ?? match.map), [side, setSide] = useState(project.selectedTeam), [roundNumber, setRoundNumber] = useState(round?.number ?? 1), [start, setStart] = useState(active?.steps.filter(step => step.captured).map(step => step.tick).sort((a,b)=>a-b)[0] ?? round?.freezeEndTick ?? match.startTick), [end, setEnd] = useState(round?.endTick ?? match.endTick), [folderId, setFolderId] = useState<string | null>(defaultFolderId), [tags, setTags] = useState('');
  const team = match.teams.find(value => value.id === side); const currentRound = match.rounds.find(value => value.number === roundNumber);
  return <div className="modal-backdrop"><section className="modal library-modal"><div className="modal-heading"><div><span className="eyebrow">{t('library.myPlaybooks')}</span><h2>{t('library.saveAsTactic')}</h2></div><button className="icon-button" aria-label={t('library.cancel')} onClick={close}><X size={16}/></button></div>
    <label className="field"><span>{t('library.name')}</span><input autoFocus maxLength={120} value={name} onChange={event => setName(event.target.value)}/></label><label className="field"><span>{t('library.description')}</span><textarea rows={3} maxLength={4000} value={description} onChange={event => setDescription(event.target.value)}/></label>
    <div className="field-row"><label>{t('library.map')}<select value={map} onChange={event => setMap(event.target.value)}>{[...new Set([...Object.keys(maps), match.map])].map(value => <option value={value} key={value}>{value.replace('de_', '')}</option>)}</select></label><label>{t('library.side')}<select value={side} onChange={event => setSide(event.target.value)}>{match.teams.map(value => <option value={value.id} key={value.id}>{value.name}</option>)}</select></label><label>{t('library.round')}<select value={roundNumber} onChange={event => { const next = +event.target.value; setRoundNumber(next); const value = match.rounds.find(item => item.number === next); if (value) { setStart(value.freezeEndTick); setEnd(value.endTick); } }}>{match.rounds.map(value => <option value={value.number} key={value.number}>{value.number}</option>)}</select></label></div>
    <div className="field-row"><label>{t('render.start')}<input type="number" value={start} min={match.startTick} max={match.endTick} onChange={event => setStart(+event.target.value)}/></label><label>{t('render.end')}<input type="number" value={end} min={match.startTick} max={match.endTick} onChange={event => setEnd(+event.target.value)}/></label><label>{t('library.folderDestination')}<select value={folderId ?? ''} onChange={event => setFolderId(event.target.value || null)}><option value="">{t('library.rootFolder')}</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label></div>
    <label className="field"><span>{t('library.tags')}</span><input value={tags} onChange={event => setTags(event.target.value)} placeholder={t('library.tagsPlaceholder')}/></label>
    {project.mock && <p className="notice">{t('pov.mockEmpty')}</p>}
    <div className="modal-actions"><button onClick={close}>{t('library.cancel')}</button><button className="primary" disabled={!name.trim() || end <= start || !team} onClick={() => {
      const players = team?.playerIds.map(id => match.players.find(player => player.id === id)).filter((player): player is NonNullable<typeof player> => !!player) ?? [];
      const steps = active?.steps.map(step => structuredClone(step)) ?? [1,2,3,4].map(index => ({ index, tick: 0, players: [], utility: [], annotations: [], captured: false }));
      const videos = (team?.playerIds ?? []).flatMap(id => { const player = match.players.find(value => value.id === id), video = project.pov.find(value => value.playerId === id); return player && video ? [{ playerId: id, playerName: player.name, proxyPath: video.proxyPath, fullPath: video.path, startTick: video.videoStartTick, endTick: video.videoEndTick, fps: video.fps, duration: video.duration }] : []; });
      const selectedSide = currentRound?.teamASide === undefined ? team?.name ?? '' : ((side === match.teams[0]?.id ? currentRound.teamASide : currentRound.teamASide === 2 ? 3 : 2) === 2 ? 'T' : 'CT');
      const input = { id: crypto.randomUUID(), folderId, name: name.trim(), description, map, side: selectedSide, demoPath: project.mock ? null : project.demoPath, roundNumber, startTick: start, endTick: end, thumbnailPath: null, tags: tags.split(',').map(value => value.trim()).filter(Boolean), tickRate: match.tickRate, teamId: side, players, steps, videos };
      void window.desktop.createLibraryTactic(input).then(saved).catch(error => onError(String(error)));
    }}>{t('library.saveTactic')}</button></div>
  </section></div>;
}

export function ImportTacticDialog({ folders, close, imported, onError }: { folders: LibraryFolder[]; close: () => void; imported: () => void; onError: (message: string) => void }) {
  const { t } = useTranslation(); const [folderId, setFolderId] = useState<string | null>(null), [busy, setBusy] = useState(false);
  return <div className="modal-backdrop"><section className="modal library-modal small-modal"><div className="modal-heading"><div><span className="eyebrow">.CSTACTIC</span><h2>{t('library.import')}</h2></div><button className="icon-button" aria-label={t('library.cancel')} onClick={close}><X size={16}/></button></div><p className="muted">{t('messages.selectDestination')}</p>
    <label className="field"><span>{t('library.folderDestination')}</span><select value={folderId ?? ''} onChange={event => setFolderId(event.target.value || null)}><option value="">{t('library.rootFolder')}</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
    <div className="modal-actions"><button onClick={close}>{t('library.cancel')}</button><button disabled={busy} className="primary" onClick={() => { setBusy(true); void window.desktop.importTacticFile(folderId).then(result => { if (result) imported(); }).catch(error => onError(String(error))).finally(() => setBusy(false)); }}><FileUp size={14}/>{t('library.importFromFile')}</button></div>
  </section></div>;
}

export function ExportTacticDialog({ tactic, close, exported, onError }: { tactic: LibraryTactic; close: () => void; exported: () => void; onError: (message: string) => void }) {
  const { t } = useTranslation(); const [options, setOptions] = useState<ExportTacticOptions>({ includeTacticalData: true, includeAnnotations: true, includeSteps: true, includeThumbnail: true, includeProxyVideos: true, includeFullQuality: false });
  const toggle = (key: keyof ExportTacticOptions) => setOptions(value => ({ ...value, [key]: !value[key] }));
  return <div className="modal-backdrop"><section className="modal library-modal small-modal"><div className="modal-heading"><div><span className="eyebrow">{tactic.name}</span><h2>{t('export.title')}</h2></div><button className="icon-button" aria-label={t('library.cancel')} onClick={close}><X size={16}/></button></div>
    {([['includeTacticalData','tacticalData',true],['includeAnnotations','annotations',false],['includeSteps','steps',false],['includeThumbnail','thumbnail',false],['includeProxyVideos','proxy',false],['includeFullQuality','full',false]] as const).map(([key,label,required])=><label className="check-row" key={key}><input type="checkbox" checked={options[key]} disabled={required} onChange={() => toggle(key)}/><span>{t(`export.${label}`)}</span></label>)}
    <div className="modal-actions"><button onClick={close}>{t('library.cancel')}</button><button className="primary" onClick={() => void window.desktop.exportTactic(tactic.id, options).then(path => { if (path) exported(); }).catch(error => onError(String(error)))}><Download size={14}/>{t('export.exportButton')}</button></div>
  </section></div>;
}

export function ShareTacticDialog({ tactic, onClose, onExport, onRefresh, onError }: { tactic: LibraryTactic; onClose: () => void; onExport: () => void; onRefresh: () => Promise<void>; onError: (message: string) => void }) {
  const { t } = useTranslation(); const [status, setStatus] = useState<ShareStatus | null>(null), [mode, setMode] = useState<'none'|'optimized'|'full'>('optimized'), [result, setResult] = useState<ShareResult | null>(null), [busy, setBusy] = useState(false), [activeShare, setActiveShare] = useState(false);
  useEffect(() => { void window.desktop.getShareStatus().then(setStatus).catch(error => onError(String(error))); }, [onError]);
  return <div className="modal-backdrop"><section className="modal library-modal small-modal"><div className="modal-heading"><div><span className="eyebrow">{tactic.name}</span><h2>{t('library.shareTitle')}</h2></div><button className="icon-button" aria-label={t('library.cancel')} onClick={onClose}><X size={16}/></button></div>
    {result ? <><div className="share-success"><Share2 size={19}/><strong>{t('library.shareSuccess')}</strong></div><label className="field"><span>{t('library.copyLink')}</span><div><input readOnly value={result.shareUrl}/><button onClick={() => void window.desktop.copyText(result.shareUrl).then(() => setActiveShare(true)).catch(error => onError(String(error)))}><Copy size={14}/>{t('library.copyLink')}</button></div></label><div className="share-actions"><button onClick={() => void window.desktop.openExternal(result.shareUrl).catch(error => onError(String(error)))}><ExternalLink size={14}/>{t('library.openLink')}</button>{activeShare && <span>{t('messages.linkCopied')}</span>}</div><div className="modal-actions"><button className="danger" onClick={() => { if (!confirm(t('library.revokeLink'))) return; setBusy(true); void window.desktop.revokeTacticShare(tactic.id).then(() => { setResult(null); void onRefresh(); }).catch(error => onError(String(error))).finally(() => setBusy(false)); }}>{t('library.revokeLink')}</button><button onClick={onClose}>{t('library.cancel')}</button></div></> : <>
      <div className={`share-status ${status?.configured ? 'ready' : ''}`}><span className="status-dot"/>{status?.configured ? t('library.shareConfigured') : t('library.shareNotConfigured')}</div>
      <div className="share-option-list"><label><input type="radio" name="pov-share" checked={mode==='none'} onChange={() => setMode('none')}/><span>{t('library.noPov')}</span></label><label><input type="radio" name="pov-share" checked={mode==='optimized'} onChange={() => setMode('optimized')}/><span>{t('library.optimizedPov')}</span></label><label><input type="radio" name="pov-share" checked={mode==='full'} onChange={() => setMode('full')}/><span>{t('library.fullPov')}</span></label></div>
      <p className="muted">{t('library.shareData')} · {t('library.shareSteps')} · {t('library.shareAnnotations')} · {t('library.shareRoutes')} · {t('library.shareGrenades')} · {t('library.shareThumbnail')}<br/>{t('library.trimExplanation')}</p>
      {!status?.configured && <div className="share-fallback"><p>{t('library.shareUnavailable')} {t('messages.notConfigured')}</p><button onClick={onExport}><Download size={14}/>{t('library.exportInstead')}</button></div>}
      <div className="modal-actions"><button onClick={onClose}>{t('library.cancel')}</button><button disabled={!status?.configured || busy} className="primary" onClick={() => { setBusy(true); void window.desktop.shareTactic(tactic.id, mode).then(value => setResult(value)).catch(error => onError(String(error))).finally(() => setBusy(false)); }}><Link2 size={14}/>{t('library.createLink')}</button></div>
    </>}
  </section></div>;
}

export function ImportFromLinkDialog({ folders, close, onError, imported }: { folders: LibraryFolder[]; close: () => void; onError: (message: string) => void; imported: () => void }) {
  const { t } = useTranslation(); const [url, setUrl] = useState(''), [preview, setPreview] = useState<SharedTacticPreview | null>(null), [folderId, setFolderId] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const previewLink = async () => { setBusy(true); try { setPreview(await window.desktop.previewSharedTactic(url)); } catch (error) { onError(String(error)); } finally { setBusy(false); } };
  return <div className="modal-backdrop"><section className="modal library-modal small-modal"><div className="modal-heading"><div><span className="eyebrow">{t('library.myPlaybooks')}</span><h2>{t('library.importLink')}</h2></div><button className="icon-button" aria-label={t('library.cancel')} onClick={close}><X size={16}/></button></div>
    {!preview ? <><label className="field"><span>{t('library.importLink')}</span><input autoFocus value={url} onChange={event => setUrl(event.target.value)} placeholder={t('library.linkPlaceholder')}/></label><div className="modal-actions"><button onClick={close}>{t('library.cancel')}</button><button className="primary" disabled={!url.trim() || busy} onClick={() => void previewLink()}>{t('library.importPreview')}</button></div></> : <><div className="share-preview"><h3>{preview.name}</h3><p>{preview.description || '—'}</p><span>{preview.map} · {preview.side || '—'} · {t('library.round')} {preview.roundNumber ?? '—'}</span><div>{preview.stepCount} {t('library.steps')} · {preview.povCount} POV</div></div><label className="field"><span>{t('library.folderDestination')}</span><select value={folderId ?? ''} onChange={event => setFolderId(event.target.value || null)}><option value="">{t('library.rootFolder')}</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label><div className="modal-actions"><button onClick={() => setPreview(null)}>{t('library.cancel')}</button><button className="primary" disabled={busy} onClick={() => { setBusy(true); void window.desktop.importSharedTactic(preview.previewId, folderId).then(imported).catch(error => onError(String(error))).finally(() => setBusy(false)); }}>{t('library.importToLibrary')}</button></div></>}
  </section></div>;
}
