import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Bomb, ChevronRight, CircleHelp, Crosshair, Flame, Folder, FolderOpen, Maximize2, Pause, Play, Plus, Save, Search, Swords, Volume2, VolumeX, Zap } from "lucide-react";
import API, { API_BASE_URL } from "../../api/api";
import { useAppShell } from "../../context/AppShellContext";
import { useLocaleStore } from "../../i18n/localeStore";
import Demo2DReplayPreview from "../demo-analysis/replay/Demo2DReplayPreview";
import { povSecondsToTick, tickToPovSeconds } from "./povClock";
import "./tacticalPlaybook.css";

function clock(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function eventVisual(event) {
  const kind = String(event?.kind || "").toLowerCase();
  if (event?.type === "kill") return { icon: Swords, label: "击杀", tone: "kill" };
  if (["plant", "defuse", "explode", "bomb_pickup", "bomb_drop"].includes(event?.type)) return { icon: Bomb, label: "C4", tone: "bomb" };
  if (/smoke|烟/.test(kind)) return { icon: CircleHelp, label: "烟雾弹", tone: "smoke" };
  if (/flash|闪/.test(kind)) return { icon: Zap, label: "闪光弹", tone: "flash" };
  if (/molotov|incendiary|燃|火/.test(kind)) return { icon: Flame, label: "燃烧弹", tone: "fire" };
  return { icon: Crosshair, label: event?.kind || "道具", tone: "utility" };
}

export default function TacticalPlaybookPage() {
  const shell = useAppShell();
  const zh = useLocaleStore((state) => state.effectiveLocale) !== "en";
  const workspace = shell.analysisWorkspace;
  const demoPath = shell.uploadedDemos?.[shell.currentMatchIndex]?.path;
  const rounds = workspace?.rounds || [];
  const [roundNumber, setRoundNumber] = useState(null);
  const [side, setSide] = useState("T");
  const [recordingMode, setRecordingMode] = useState("obs");
  const [selected, setSelected] = useState("2d");
  const [batch, setBatch] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const prepareLock = useRef(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [fullQuality, setFullQuality] = useState(true);
  const [replaySeek, setReplaySeek] = useState(null);
  const [tacticName, setTacticName] = useState("");
  const [savedTactic, setSavedTactic] = useState(null);
  const [playbooks, setPlaybooks] = useState([]);
  const [folders, setFolders] = useState([]);
  const [librarySearch, setLibrarySearch] = useState("");
  const [collapsedFolderIds, setCollapsedFolderIds] = useState(() => new Set());
  const [folderName, setFolderName] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState(null);
  const [selectedStepId, setSelectedStepId] = useState(null);
  const [stepTitle, setStepTitle] = useState("");
  const [stepNote, setStepNote] = useState("");
  const [annotationMode, setAnnotationMode] = useState("select");
  const [annotationColor, setAnnotationColor] = useState("#fbbf24");
  const [annotationText, setAnnotationText] = useState("");
  const [annotationUndo, setAnnotationUndo] = useState([]);
  const [annotationRedo, setAnnotationRedo] = useState([]);
  useEffect(() => { setAnnotationUndo([]); setAnnotationRedo([]); }, [selectedStepId]);
  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const activeRound = useMemo(() => rounds.find((row) => Number(row.round_number) === Number(roundNumber)) || rounds[0], [rounds, roundNumber]);
  const actualRound = Number(activeRound?.round_number || 0);
  const teamKey = activeRound?.team_a_side === side ? "a" : activeRound?.team_b_side === side ? "b" : null;
  const players = (workspace?.players || []).filter((player) => player.team_key === teamKey);
  const tickRate = Number(workspace?.tick_rate || 64);
  const startTick = Number(activeRound?.freeze_end_tick || activeRound?.start_tick || 0);
  const endTick = Math.max(startTick + 1, Number(activeRound?.record_end_tick || activeRound?.round_end_tick || activeRound?.end_tick || startTick + tickRate * 115));
  const roundEvents = useMemo(() => (activeRound?.events || [])
    .filter((event) => Number(event?.tick) >= startTick && Number(event?.tick) <= endTick)
    .sort((left, right) => Number(left.tick) - Number(right.tick)), [activeRound, startTick, endTick]);
  const visibleEvents = useMemo(() => roundEvents.filter((event) => ["kill", "grenade", "plant", "defuse", "explode", "bomb_pickup", "bomb_drop"].includes(event.type)), [roundEvents]);
  const eventPosition = (eventTick) => `${Math.max(0, Math.min(100, (Number(eventTick) - startTick) / (endTick - startTick) * 100))}%`;
  const mapLabel = String(workspace?.map_name || "").replace(/^de_/, "").replace(/^./, (letter) => letter.toUpperCase());

  useEffect(() => {
    const initialTick = Number(activeRound?.freeze_end_tick || activeRound?.start_tick || 0);
    setTick(initialTick);
    setReplaySeek(initialTick);
    setSelected("2d");
    setPlaying(false);
    setBatch(null);
  }, [demoPath, actualRound]);

  const refreshTree = useCallback(async () => {
    const { data } = await API.get("/tactical/playbooks");
    setFolders(data.folders || []);
    setPlaybooks(data.tactics || []);
  }, []);
  useEffect(() => { void refreshTree().catch(() => {}); }, [refreshTree, savedTactic]);

  useEffect(() => {
    if (!batch?.id || ["Complete", "Failed"].includes(batch.status)) return undefined;
    const poll = setInterval(async () => {
      try {
        const { data } = await API.get(`/tactical/prepare-povs/${batch.id}`);
        setBatch(data);
      } catch (reason) {
        setError(String(reason?.response?.data?.detail || reason.message));
      }
    }, 1000);
    return () => clearInterval(poll);
  }, [batch?.id, batch?.status]);

  const prepare = async () => {
    if (!demoPath || !workspace || prepareLock.current) return;
    prepareLock.current = true;
    setPreparing(true);
    setError("");
    try {
      const { data } = await API.post("/tactical/prepare-povs", {
        demo_path: demoPath, analysis_workspace: workspace,
        round_number: actualRound, side, recording_mode: recordingMode,
      });
      setBatch(data);
    } catch (reason) {
      const detail = reason?.response?.data?.detail;
      setError(typeof detail === "object" ? detail.message || JSON.stringify(detail) : String(detail || reason.message));
    } finally {
      prepareLock.current = false;
      setPreparing(false);
    }
  };

  const saveTactic = async () => {
    setError("");
    try {
      const { data } = await API.post("/tactical/tactics", {
        name: tacticName.trim() || `${workspace.map_name} R${actualRound} ${side}`,
        pov_batch_id: batch?.id || null,
        folder_id: selectedFolderId,
        selection: { demo_path: demoPath, analysis_workspace: workspace, round_number: actualRound, side },
      });
      setSavedTactic(data);
    } catch (reason) {
      setError(String(reason?.response?.data?.detail || reason.message));
    }
  };

  const captureStep = async () => {
    if (!savedTactic) return;
    setError("");
    try {
      const { data } = await API.post(`/tactical/tactics/${savedTactic.id}/steps`, { tick: Math.round(tick) });
      setSavedTactic((current) => ({ ...current, steps: [...(current.steps || []), data] }));
      setSelectedStepId(data.id);
      setStepTitle(data.title);
      setStepNote(data.note);
    } catch (reason) {
      setError(String(reason?.response?.data?.detail || reason.message));
    }
  };

  const openTactic = async (id) => {
    const { data } = await API.get(`/tactical/tactics/${id}`);
    if (data.source_demo_path !== demoPath) {
      setError(zh ? "请先在 Demo 分析中打开该战术的源 Demo。" : "Open this tactic's source demo in Demo Analysis first.");
      return;
    }
    setRoundNumber(data.round_number);
    setSide(data.side);
    setSavedTactic(data);
    setSelectedFolderId(data.folder_id || null);
    setSelectedStepId(null);
    setSelected("2d");
    setReplaySeek(data.freeze_end_tick);
    if (data.metadata?.pov_batch_id) {
      try {
        const response = await API.get(`/tactical/prepare-povs/${data.metadata.pov_batch_id}`);
        setBatch(response.data);
      } catch {
        setBatch(null);
      }
    }
  };

  const createFolder = async () => {
    if (!folderName.trim()) return;
    try {
      const { data } = await API.post("/tactical/folders", { name: folderName.trim(), parent_id: selectedFolderId });
      setFolderName("");
      setSelectedFolderId(data.id);
      await refreshTree();
    } catch (reason) {
      setError(String(reason?.response?.data?.detail || reason.message));
    }
  };

  const moveItem = async (event, folderId) => {
    event.preventDefault();
    event.stopPropagation();
    const tacticId = event.dataTransfer.getData("application/x-tactic-id");
    const sourceFolderId = event.dataTransfer.getData("application/x-folder-id");
    try {
      if (tacticId) await API.patch(`/tactical/tactics/${tacticId}/folder`, { folder_id: folderId });
      else if (sourceFolderId) await API.patch(`/tactical/folders/${sourceFolderId}/parent`, { parent_id: folderId });
      await refreshTree();
    } catch (reason) {
      setError(String(reason?.response?.data?.detail || reason.message));
    }
  };

  const saveStep = async () => {
    if (!savedTactic || !selectedStepId) return;
    const old = savedTactic.steps?.find((step) => step.id === selectedStepId);
    try {
      const { data } = await API.put(`/tactical/tactics/${savedTactic.id}/steps/${selectedStepId}`, {
        title: stepTitle, note: stepNote, annotations: old?.annotations || [],
      });
      setSavedTactic((current) => ({ ...current, steps: current.steps.map((step) => step.id === data.id ? data : step) }));
    } catch (reason) {
      setError(String(reason?.response?.data?.detail || reason.message));
    }
  };

  const deleteStep = async () => {
    if (!savedTactic || !selectedStepId) return;
    try {
      await API.delete(`/tactical/tactics/${savedTactic.id}/steps/${selectedStepId}`);
      setSavedTactic((current) => ({ ...current, steps: current.steps.filter((step) => step.id !== selectedStepId) }));
      setSelectedStepId(null);
    } catch (reason) {
      setError(String(reason?.response?.data?.detail || reason.message));
    }
  };

  const selectedStep = savedTactic?.steps?.find((step) => step.id === selectedStepId);
  const persistAnnotations = async (annotations) => {
    if (!savedTactic || !selectedStep) return;
    const { data } = await API.put(`/tactical/tactics/${savedTactic.id}/steps/${selectedStep.id}`, {
      title: selectedStep.title, note: selectedStep.note, annotations,
    });
    setSavedTactic((current) => ({ ...current, steps: current.steps.map((step) => step.id === data.id ? data : step) }));
  };
  const commitAnnotation = async (annotation) => {
    if (!selectedStep) return;
    const previous = selectedStep.annotations || [];
    setAnnotationUndo((items) => [...items, previous]);
    setAnnotationRedo([]);
    try { await persistAnnotations([...previous, { ...annotation, text: annotation.type === "note" ? annotationText.trim() : annotation.text, stepId: selectedStep.id }]); }
    catch (reason) { setError(String(reason?.response?.data?.detail || reason.message)); }
  };
  const removeAnnotation = async (id) => {
    if (!selectedStep) return;
    const previous = selectedStep.annotations || [];
    setAnnotationUndo((items) => [...items, previous]);
    setAnnotationRedo([]);
    try { await persistAnnotations(previous.filter((item) => item.id !== id)); }
    catch (reason) { setError(String(reason?.response?.data?.detail || reason.message)); }
  };
  const changeAnnotationHistory = async (direction) => {
    if (!selectedStep) return;
    const source = direction === "undo" ? annotationUndo : annotationRedo;
    if (!source.length) return;
    const next = source.at(-1);
    const current = selectedStep.annotations || [];
    if (direction === "undo") { setAnnotationUndo(source.slice(0, -1)); setAnnotationRedo((items) => [...items, current]); }
    else { setAnnotationRedo(source.slice(0, -1)); setAnnotationUndo((items) => [...items, current]); }
    try { await persistAnnotations(next); }
    catch (reason) { setError(String(reason?.response?.data?.detail || reason.message)); }
  };

  const tacticButton = (item, depth = 0) => <button key={item.id} type="button" draggable onDragStart={(event) => event.dataTransfer.setData("application/x-tactic-id", item.id)} onClick={() => void openTactic(item.id)} style={{ paddingLeft: `${12 + depth * 12}px` }} className={`tactical-library-item ${savedTactic?.id === item.id ? "is-selected" : ""}`}><span className="tactical-document-icon">▤</span><span className="truncate">{item.name}</span></button>;
  const renderFolder = (folder, depth = 0) => {
    const collapsed = collapsedFolderIds.has(folder.id) && !librarySearch.trim();
    return <div key={folder.id}>
      <button type="button" draggable onDragStart={(event) => event.dataTransfer.setData("application/x-folder-id", folder.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => void moveItem(event, folder.id)} onClick={() => { setSelectedFolderId(folder.id); setCollapsedFolderIds((current) => { const next = new Set(current); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); return next; }); }} style={{ paddingLeft: `${8 + depth * 12}px` }} className={`tactical-library-item tactical-folder ${selectedFolderId === folder.id ? "is-selected" : ""}`}><ChevronRight size={12} className={collapsed ? "" : "rotate-90"} /><Folder size={14} /><span className="truncate">{folder.name}</span></button>
      {!collapsed && <div>{folders.filter((child) => child.parent_id === folder.id).map((child) => renderFolder(child, depth + 1))}{playbooks.filter((item) => item.folder_id === folder.id && item.name.toLowerCase().includes(librarySearch.toLowerCase())).map((item) => tacticButton(item, depth + 1))}</div>}
    </div>;
  };

  const selectView = (next) => {
    if (selected === "2d") setReplaySeek(null);
    setSelected(next);
    if (next === "2d") setReplaySeek(tick);
  };

  const selectedIndex = Number(selected);
  const selectedPlayer = Number.isInteger(selectedIndex) ? players[selectedIndex] : null;
  const selectedPov = selectedPlayer ? batch?.players?.find((item) => item.steam_id64 === selectedPlayer.steam_id64) : null;
  const videoUrl = selectedPov?.status === "Complete" ? `${API_BASE_URL}${fullQuality ? selectedPov.stream_url : selectedPov.proxy_url}` : null;
  const seekToTick = (nextTick) => {
    const next = Math.max(startTick, Math.min(endTick, Math.round(Number(nextTick) || startTick)));
    setTick(next);
    setReplaySeek(next);
    if (selectedPov && videoRef.current) videoRef.current.currentTime = tickToPovSeconds(next, selectedPov.coverage_start_tick, tickRate, videoRef.current.duration || Infinity);
  };
  const togglePlayback = () => {
    if (selected !== "2d" && videoRef.current) {
      if (videoRef.current.paused) void videoRef.current.play().catch(() => setPlaying(false));
      else videoRef.current.pause();
    } else setPlaying((current) => !current);
  };
  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.playbackRate = speed;
    videoRef.current.volume = volume;
  }, [speed, volume, videoUrl]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !selectedPov || !videoUrl) return;
    const seek = () => {
      const seconds = tickToPovSeconds(tick, selectedPov.coverage_start_tick, tickRate, video.duration || Infinity);
      video.currentTime = seconds;
      video.playbackRate = speed;
      video.volume = volume;
      if (playing) void video.play().catch(() => setPlaying(false));
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
    return () => video.removeEventListener("loadedmetadata", seek);
    // Seek once when switching sources; timeupdate owns subsequent clock updates.
  }, [selected, videoUrl]);

  const onReplayTick = useCallback((nextTick) => {
    if (selected === "2d") setTick(nextTick);
  }, [selected]);
  const onReplayPlaying = useCallback((next) => {
    if (selected === "2d") setPlaying(next);
  }, [selected]);

  if (!workspace || !demoPath || !rounds.length) {
    return <div className="p-8 text-cs2-text-primary">{zh ? "先在 Demo 分析中导入并解析 Demo，再进入战术工作台。" : "Import and parse a demo in Demo Analysis first."}</div>;
  }

  return <div className="tactical-workspace" data-testid="tactical-playbook">
    <header className="tactical-header">
      <div className="tactical-round-controls"><select aria-label="Round" value={actualRound} onChange={(event) => { setSavedTactic(null); setRoundNumber(Number(event.target.value)); }}>{rounds.map((row) => <option key={row.round_number} value={row.round_number}>R{row.round_number}</option>)}</select><select aria-label="Side" value={side} onChange={(event) => { setSavedTactic(null); setSide(event.target.value); setBatch(null); setSelected("2d"); }}><option value="T">T</option><option value="CT">CT</option></select></div>
      <div className="tactical-match">
        <div className="tactical-score"><strong>{workspace.team_a_name || "Team A"}</strong><span>{activeRound?.team_a_score_before ?? "–"} : {activeRound?.team_b_score_before ?? "–"}</span><strong>{workspace.team_b_name || "Team B"}</strong></div>
        <div className="tactical-match-meta">{mapLabel} <span>│</span> R{actualRound} <span>│</span> {side} {zh ? "方战术" : "side"}</div>
      </div>
      <div className="tactical-header-actions">
        <div className="tactical-recording-mode" role="group" aria-label={zh ? "POV 录制方式" : "POV recording method"}>
          <button type="button" data-testid="record-mode-obs" aria-pressed={recordingMode === "obs"} disabled={preparing || (batch && !["Complete", "Failed"].includes(batch.status))} className={recordingMode === "obs" ? "is-selected" : ""} onClick={() => setRecordingMode("obs")}>OBS</button>
          <button type="button" data-testid="record-mode-hlae" aria-pressed={recordingMode === "hlae"} title={zh ? "HLAE 需在设置 → 路径中配置 HLAE.exe、CS2 和 FFmpeg" : "Configure HLAE.exe, CS2 and FFmpeg in Settings → Paths before using HLAE"} disabled={preparing || (batch && !["Complete", "Failed"].includes(batch.status))} className={recordingMode === "hlae" ? "is-selected" : ""} onClick={() => setRecordingMode("hlae")}>HLAE</button>
        </div>
        {recordingMode === "hlae" && <span className="tactical-mode-hint">{zh ? "备用引擎" : "Alternate engine"}</span>}
        <Link to="/analysis" className="tactical-action"><ArrowLeft size={15} />{zh ? "返回 Demo" : "Back to Demo"}</Link>
        <button type="button" className="tactical-action tactical-action--primary" onClick={prepare} disabled={preparing || players.length !== 5 || (batch && !["Complete", "Failed"].includes(batch.status))}>{zh ? "生成五个真实 POV" : "Generate 5 real POVs"}</button>
      </div>
    </header>
    {error && <div role="alert" className="tactical-error">{error}</div>}
    {batch?.status === "Failed" && <div role="alert" className="tactical-error">{batch.error || batch.players?.filter((item) => item.status === "Failed").map((item) => `${item.player_name}: ${item.error}`).join("；") || (zh ? "POV 生成失败，请重试。" : "POV generation failed. Please retry.")}</div>}
    <div className="tactical-body">
      <aside className="tactical-library" aria-label={zh ? "战术库" : "Playbook library"}>
        <div className="tactical-panel-heading"><strong>{zh ? "战术库" : "Playbook library"}</strong><FolderOpen size={15} /></div>
        <label className="tactical-library-search"><Search size={14} /><input aria-label="Search tactics" value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} placeholder={zh ? "搜索战术..." : "Search tactics..."} /></label>
        <div className="tactical-library-tree" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void moveItem(event, null)}>
          <button type="button" onClick={() => setSelectedFolderId(null)} className={`tactical-library-item tactical-folder ${selectedFolderId === null ? "is-selected" : ""}`}><Folder size={14} /><span>{zh ? "全部战术" : "All tactics"}</span></button>
          {folders.filter((folder) => folder.parent_id === null).map((folder) => renderFolder(folder))}
          {playbooks.filter((item) => item.folder_id === null && item.name.toLowerCase().includes(librarySearch.toLowerCase())).map((item) => tacticButton(item))}
        </div>
        <div className="tactical-library-new"><input aria-label="Folder name" value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder={zh ? "新建文件夹" : "New folder"} /><button type="button" aria-label={zh ? "创建文件夹" : "Create folder"} onClick={() => void createFolder()}><Plus size={16} /></button></div>
      </aside>
      <aside className="tactical-pov-rail" aria-label="POV views">
        {players.map((player, index) => {
          const pov = batch?.players?.find((item) => item.steam_id64 === player.steam_id64);
          return <button type="button" key={player.steam_id64 || player.name} data-testid={`pov-${index + 1}`} aria-pressed={selected === String(index)} onClick={() => selectView(String(index))} className={`tactical-pov-tile ${selected === String(index) ? "is-selected" : ""}`}>
            <span className="tactical-pov-preview">{pov?.status === "Complete" ? <video muted playsInline preload="metadata" src={`${API_BASE_URL}${pov.proxy_url}`} onLoadedMetadata={(event) => { event.currentTarget.currentTime = tickToPovSeconds(tick, pov.coverage_start_tick, tickRate, event.currentTarget.duration || Infinity); }} /> : <span className="tactical-pov-status">{pov?.status || "Waiting"}</span>}</span>
            <span className="tactical-pov-caption"><span className="tactical-pov-number">{index + 1}</span><strong title={player.name}>{player.name}</strong><small className="tactical-pov-state">{pov?.status || ""}</small></span>
          </button>;
        })}
        <button type="button" data-testid="pov-2d" aria-pressed={selected === "2d"} onClick={() => selectView("2d")} className={`tactical-pov-tile tactical-pov-tile--map ${selected === "2d" ? "is-selected" : ""}`}><span className="tactical-pov-map-icon">◎</span><span className="tactical-pov-caption"><strong>{zh ? "2D 战术视图" : "2D Tactical"}</strong></span></button>
      </aside>
      <main className={`tactical-stage ${selected === "2d" ? "is-2d" : ""}`} ref={stageRef}>
        <div className="tactical-video-pane">
          {selected !== "2d" && (videoUrl ? <video key={videoUrl} ref={videoRef} src={videoUrl} playsInline className="tactical-main-video" onTimeUpdate={(event) => { const nextTick = povSecondsToTick(event.currentTarget.currentTime, selectedPov.coverage_start_tick, tickRate); setTick(nextTick); setReplaySeek(nextTick); }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onRateChange={(event) => setSpeed(event.currentTarget.playbackRate)} onVolumeChange={(event) => setVolume(event.currentTarget.volume)} /> : <div className="tactical-video-empty"><span>{selectedPov?.status === "Failed" ? selectedPov.error : zh ? "真实 POV 尚未录制完成" : "Real POV is not ready"}</span><small>{batch?.status || "Waiting"}</small></div>)}
          {selected !== "2d" && <div className="tactical-video-overlay"><span>{selectedPlayer?.name}</span></div>}
        </div>
        <section className="tactical-radar-pane"><div className="tactical-panel-heading"><strong>{zh ? "2D 战术地图" : "2D tactical map"}</strong><span>{mapLabel}</span></div><div className="tactical-radar-canvas"><Demo2DReplayPreview key={`${demoPath}:${actualRound}`} compact workspace={workspace} demoPath={demoPath} players={workspace.players} teamAName={workspace.team_a_name} teamBName={workspace.team_b_name} initialRound={actualRound} externalSeekTick={replaySeek} externalPlaying={selected === "2d" ? playing : false} externalSpeed={speed} onPlayhead={onReplayTick} onPlaybackChange={onReplayPlaying} annotations={selectedStep?.annotations || []} annotationMode={selectedStep ? annotationMode : "select"} annotationColor={annotationColor} onAnnotationCommit={(item) => void commitAnnotation(item)} onAnnotationDelete={(id) => void removeAnnotation(id)} /></div><div className="tactical-map-legend"><span className="tactical-legend-t">● T</span><span className="tactical-legend-ct">● CT</span><span>☁ {zh ? "烟雾" : "Smoke"}</span><span>✦ {zh ? "闪光" : "Flash"}</span></div></section>
        <section className="tactical-events-pane"><div className="tactical-panel-heading"><strong>{zh ? "事件列表" : "Events"}</strong><span>{visibleEvents.length}</span></div><div className="tactical-events-list">{visibleEvents.length ? visibleEvents.map((event, index) => { const visual = eventVisual(event); const Icon = visual.icon; return <button type="button" key={`${event.type}-${event.tick}-${index}`} className={`tactical-event tactical-tone-${visual.tone} ${Math.abs(Number(event.tick) - tick) < tickRate ? "is-current" : ""}`} onClick={() => seekToTick(event.tick)}><span className="tactical-event-time">{clock((Number(event.tick) - startTick) / tickRate)}</span><Icon size={14} /><span className="tactical-event-actor">{event.actor || "—"}</span><span className="tactical-event-kind">{visual.label}{event.target ? ` → ${event.target}` : ""}</span></button>; }) : <p className="tactical-events-empty">{zh ? "当前回合没有解析到事件" : "No parsed events in this round"}</p>}</div></section>
      </main>
    </div>
    <section className="tactical-bottom" aria-label={zh ? "回合时间轴" : "Round timeline"}>
      <div className="tactical-controls">
        <button type="button" aria-label={playing ? "Pause" : "Play"} className="tactical-play-button" onClick={togglePlayback}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
        <span className="tactical-time-readout">{clock((tick - startTick) / tickRate)} <span>/ {clock((endTick - startTick) / tickRate)}</span></span>
        <select aria-label="Playback speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>{[0.25, 0.5, 1, 1.5, 2, 4].map((rate) => <option key={rate} value={rate}>{rate}x</option>)}</select>
        <label className="tactical-volume">{volume ? <Volume2 size={16} /> : <VolumeX size={16} />}<input aria-label="Volume" type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></label>
        <div className="tactical-control-spacer" />
        <span className="tactical-batch-status">{batch?.status || "Waiting"} · Tick {Math.round(tick)}</span>
        <label className="tactical-quality"><input type="checkbox" checked={fullQuality} onChange={(event) => setFullQuality(event.target.checked)} />{zh ? "原画质 / 声音" : "Full quality / audio"}</label>
        <button type="button" aria-label="Fullscreen" className="tactical-icon-button" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void stageRef.current?.requestFullscreen?.(); }}><Maximize2 size={16} /></button>
      </div>
      <div className="tactical-stepbar"><div className="tactical-stepbar-label">{zh ? "步骤" : "Steps"}</div>{(savedTactic?.steps || []).map((step) => <button type="button" key={step.id} onClick={() => { setSelectedStepId(step.id); setStepTitle(step.title); setStepNote(step.note); seekToTick(step.tick); }} className={`tactical-step-chip ${selectedStepId === step.id ? "is-selected" : ""}`}>Step {step.step_number}<span>{step.title}</span></button>)}<button type="button" onClick={() => void captureStep()} disabled={!savedTactic} className="tactical-add-step"><Plus size={14} />{zh ? "捕获步骤" : "Capture step"}</button><div className="tactical-control-spacer" /><input aria-label="Tactic name" value={tacticName} onChange={(event) => setTacticName(event.target.value)} placeholder={zh ? "战术名称" : "Tactic name"} className="tactical-name-input" /><button type="button" className="tactical-save-button" onClick={() => void saveTactic()}><Save size={14} />{zh ? "保存战术" : "Save tactic"}</button></div>
      <div className="tactical-ruler"><span>{clock(0)}</span><span>{clock((endTick - startTick) / tickRate / 4)}</span><span>{clock((endTick - startTick) / tickRate / 2)}</span><span>{clock((endTick - startTick) / tickRate * 3 / 4)}</span><span>{clock((endTick - startTick) / tickRate)}</span></div>
      <div className="tactical-timeline"><div className="tactical-track-labels">{["T", "CT", zh ? "烟雾" : "Smoke", zh ? "闪光" : "Flash", zh ? "燃烧" : "Fire", "C4", zh ? "击杀" : "Kills"].map((label) => <span key={label}>{label}</span>)}</div><div className="tactical-track-canvas"><div className="tactical-playhead" style={{ left: eventPosition(tick) }} />{["T", "CT", "smoke", "flash", "fire", "bomb", "kill"].map((row) => <div key={row} className="tactical-track-row">{visibleEvents.filter((event) => { const tone = eventVisual(event).tone; if (row === "T" || row === "CT") { const actor = (workspace.players || []).find((player) => player.name === event.actor); const actorSide = actor?.team_key === "a" ? activeRound.team_a_side : actor?.team_key === "b" ? activeRound.team_b_side : null; return actorSide === row; } return row === tone; }).map((event, index) => <button type="button" key={`${event.type}-${event.tick}-${index}`} className={`tactical-marker tactical-tone-${row === "T" ? "t" : row === "CT" ? "ct" : eventVisual(event).tone}`} style={{ left: eventPosition(event.tick) }} title={`${clock((Number(event.tick) - startTick) / tickRate)} · ${event.actor || ""} ${eventVisual(event).label}`} aria-label={`Seek to ${eventVisual(event).label} at tick ${event.tick}`} onClick={() => seekToTick(event.tick)} />)}</div>)}<input aria-label="Tactical timeline" type="range" min={startTick} max={endTick} step="1" value={Math.max(startTick, Math.min(endTick, tick))} onChange={(event) => seekToTick(event.target.value)} /></div></div>
      {selected === "2d" && <div className="tactical-annotation-toolbar">{[["select", "选择"], ["pen", "画笔"], ["eraser", "删除"], ["rectangle", "矩形"], ["circle", "圆形"], ["note", "注释"], ["line", "直线"], ["arrow", "箭头"], ["smoke", "烟"], ["flash", "闪"], ["he", "雷"], ["molotov", "火"], ["c4", "C4"]].map(([mode, label]) => <button type="button" key={mode} disabled={mode !== "select" && !selectedStep} onClick={() => setAnnotationMode(mode)} className={annotationMode === mode ? "is-selected" : ""}>{label}</button>)}<button type="button" aria-label="CT color" onClick={() => setAnnotationColor("#38bdf8")}>CT</button><button type="button" aria-label="T color" onClick={() => setAnnotationColor("#fbbf24")}>T</button>{annotationMode === "note" && <input aria-label="Annotation text" value={annotationText} onChange={(event) => setAnnotationText(event.target.value)} placeholder={zh ? "标注文字" : "Note text"} />}<button type="button" disabled={!annotationUndo.length} onClick={() => void changeAnnotationHistory("undo")}>↶</button><button type="button" disabled={!annotationRedo.length} onClick={() => void changeAnnotationHistory("redo")}>↷</button><button type="button" disabled={!selectedStep} onClick={() => { if (window.confirm(zh ? "清空当前步骤的全部标注？" : "Clear all annotations in this step?")) { setAnnotationUndo((items) => [...items, selectedStep.annotations || []]); void persistAnnotations([]); } }}>{zh ? "清空" : "Clear"}</button></div>}
      {selectedStepId && <div className="tactical-step-edit"><input aria-label="Step title" value={stepTitle} onChange={(event) => setStepTitle(event.target.value)} /><input aria-label="Step note" value={stepNote} onChange={(event) => setStepNote(event.target.value)} /><button type="button" onClick={() => void saveStep()}>{zh ? "保存步骤" : "Save step"}</button><button type="button" onClick={() => void deleteStep()}>{zh ? "删除" : "Delete"}</button></div>}
    </section>
  </div>;
}
