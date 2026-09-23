import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import API, { API_BASE_URL } from "../../api/api";
import { useAppShell } from "../../context/AppShellContext";
import { useLocaleStore } from "../../i18n/localeStore";
import Demo2DReplayPreview from "../demo-analysis/replay/Demo2DReplayPreview";
import { povSecondsToTick, tickToPovSeconds } from "./povClock";

export default function TacticalPlaybookPage() {
  const shell = useAppShell();
  const zh = useLocaleStore((state) => state.effectiveLocale) !== "en";
  const workspace = shell.analysisWorkspace;
  const demoPath = shell.uploadedDemos?.[shell.currentMatchIndex]?.path;
  const rounds = workspace?.rounds || [];
  const [roundNumber, setRoundNumber] = useState(null);
  const [side, setSide] = useState("T");
  const [selected, setSelected] = useState("2d");
  const [batch, setBatch] = useState(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [fullQuality, setFullQuality] = useState(false);
  const [replaySeek, setReplaySeek] = useState(null);
  const [tacticName, setTacticName] = useState("");
  const [savedTactic, setSavedTactic] = useState(null);
  const [playbooks, setPlaybooks] = useState([]);
  const [folders, setFolders] = useState([]);
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
  const activeRound = useMemo(() => rounds.find((row) => Number(row.round_number) === Number(roundNumber)) || rounds[0], [rounds, roundNumber]);
  const actualRound = Number(activeRound?.round_number || 0);
  const teamKey = activeRound?.team_a_side === side ? "a" : activeRound?.team_b_side === side ? "b" : null;
  const players = (workspace?.players || []).filter((player) => player.team_key === teamKey);
  const tickRate = Number(workspace?.tick_rate || 64);

  useEffect(() => {
    setTick(Number(activeRound?.freeze_end_tick || activeRound?.start_tick || 0));
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
    if (!demoPath || !workspace) return;
    setError("");
    try {
      const { data } = await API.post("/tactical/prepare-povs", {
        demo_path: demoPath, analysis_workspace: workspace,
        round_number: actualRound, side,
      });
      setBatch(data);
    } catch (reason) {
      setError(String(reason?.response?.data?.detail || reason.message));
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

  const tacticButton = (item, depth = 0) => <button key={item.id} type="button" draggable onDragStart={(event) => event.dataTransfer.setData("application/x-tactic-id", item.id)} onClick={() => void openTactic(item.id)} style={{ paddingLeft: `${8 + depth * 12}px` }} className="block w-full truncate rounded py-1 text-left hover:bg-zinc-800">{item.name}</button>;
  const renderFolder = (folder, depth = 0) => <div key={folder.id}>
    <button type="button" draggable onDragStart={(event) => event.dataTransfer.setData("application/x-folder-id", folder.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => void moveItem(event, folder.id)} onClick={() => setSelectedFolderId(folder.id)} style={{ paddingLeft: `${8 + depth * 12}px` }} className={`w-full truncate rounded py-1 text-left ${selectedFolderId === folder.id ? "bg-zinc-700" : "hover:bg-zinc-800"}`}>▸ {folder.name}</button>
    {folders.filter((child) => child.parent_id === folder.id).map((child) => renderFolder(child, depth + 1))}
    {playbooks.filter((item) => item.folder_id === folder.id).map((item) => tacticButton(item, depth + 1))}
  </div>;

  const selectView = (next) => {
    if (selected === "2d") setReplaySeek(null);
    setSelected(next);
    if (next === "2d") setReplaySeek(tick);
  };

  const selectedIndex = Number(selected);
  const selectedPov = Number.isInteger(selectedIndex) ? batch?.players?.[selectedIndex] : null;
  const videoUrl = selectedPov?.status === "Complete" ? `${API_BASE_URL}${fullQuality ? selectedPov.stream_url : selectedPov.proxy_url}` : null;
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

  return <div className="flex h-full min-h-0 flex-col bg-[#101215] text-zinc-100" data-testid="tactical-playbook">
    <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
      <h1 className="mr-4 text-lg font-semibold">{zh ? "战术工作台" : "Tactical Playbook"}</h1>
      <select aria-label="Round" className="rounded bg-zinc-800 p-2" value={actualRound} onChange={(event) => { setSavedTactic(null); setRoundNumber(Number(event.target.value)); }}>
        {rounds.map((row) => <option key={row.round_number} value={row.round_number}>Round {row.round_number}</option>)}
      </select>
      <select aria-label="Side" className="rounded bg-zinc-800 p-2" value={side} onChange={(event) => { setSavedTactic(null); setSide(event.target.value); setBatch(null); setSelected("2d"); }}>
        <option value="T">T</option><option value="CT">CT</option>
      </select>
      <span className="text-sm text-zinc-400">{workspace.map_name} · {teamKey === "a" ? workspace.team_a_name : workspace.team_b_name}</span>
      <button type="button" onClick={prepare} disabled={players.length !== 5 || (batch && !["Complete", "Failed"].includes(batch.status))} className="ml-auto rounded bg-amber-500 px-4 py-2 font-semibold text-black disabled:opacity-50">
        {zh ? "生成五个真实 POV" : "Generate 5 real POVs"}
      </button>
    </div>
    {error && <div role="alert" className="bg-red-950 px-4 py-2 text-red-200">{error}</div>}
    <div className="flex min-h-0 flex-1 gap-3 p-3">
      <aside className="flex w-[210px] shrink-0 flex-col gap-2 overflow-y-auto">
        <div className="rounded border border-zinc-800 bg-zinc-900 p-2 text-sm">
          <div className="mb-2 font-semibold">{zh ? "我的战术" : "My Playbooks"}</div>
          <div onDragOver={(event) => event.preventDefault()} onDrop={(event) => void moveItem(event, null)}>
            <button type="button" onClick={() => setSelectedFolderId(null)} className={`w-full rounded px-2 py-1 text-left ${selectedFolderId === null ? "bg-zinc-700" : "hover:bg-zinc-800"}`}>{zh ? "全部 / 根目录" : "Root"}</button>
            {folders.filter((folder) => folder.parent_id === null).map((folder) => renderFolder(folder))}
            {playbooks.filter((item) => item.folder_id === null).map((item) => tacticButton(item))}
          </div>
          <div className="mt-2 flex gap-1"><input aria-label="Folder name" value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder={zh ? "文件夹" : "Folder"} className="min-w-0 flex-1 rounded bg-zinc-800 px-1" /><button type="button" onClick={() => void createFolder()} className="rounded bg-zinc-700 px-2">+</button></div>
        </div>
        {players.map((player, index) => {
          const pov = batch?.players?.find((item) => item.steam_id64 === player.steam_id64);
          return <button type="button" key={player.steam_id64 || player.name} data-testid={`pov-${index + 1}`} onClick={() => selectView(String(index))} className={`rounded border p-2 text-left ${selected === String(index) ? "border-amber-400 bg-zinc-800" : "border-zinc-800 bg-zinc-900"}`}>
            <div className="flex aspect-video items-center justify-center bg-black text-sm text-zinc-500">{pov?.status === "Complete" ? <video muted preload="metadata" src={`${API_BASE_URL}${pov.proxy_url}`} className="h-full w-full object-contain" /> : pov?.status || "Waiting"}</div>
            <div className="mt-1 flex justify-between text-sm"><span>{index + 1}. {player.name}</span><span className="text-zinc-500">{pov?.status || "—"}</span></div>
          </button>;
        })}
        <button type="button" data-testid="pov-2d" onClick={() => selectView("2d")} className={`rounded border p-3 text-left ${selected === "2d" ? "border-amber-400 bg-zinc-800" : "border-zinc-800 bg-zinc-900"}`}>2D Replay</button>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden rounded bg-black">
        <div className={selected === "2d" ? "h-full" : "hidden"}>
          <Demo2DReplayPreview key={`${demoPath}:${actualRound}`} workspace={workspace} demoPath={demoPath} players={workspace.players} teamAName={workspace.team_a_name} teamBName={workspace.team_b_name} initialRound={actualRound} externalSeekTick={replaySeek} externalPlaying={selected === "2d" ? playing : false} onPlayhead={onReplayTick} onPlaybackChange={onReplayPlaying} annotations={selectedStep?.annotations || []} annotationMode={selectedStep ? annotationMode : "select"} annotationColor={annotationColor} onAnnotationCommit={(item) => void commitAnnotation(item)} onAnnotationDelete={(id) => void removeAnnotation(id)} />
        </div>
        {selected !== "2d" && <div className="flex h-full flex-col items-center justify-center">
          {videoUrl ? <video key={videoUrl} ref={videoRef} src={videoUrl} controls className="max-h-full max-w-full" onTimeUpdate={(event) => setTick(povSecondsToTick(event.currentTarget.currentTime, selectedPov.coverage_start_tick, tickRate))} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onRateChange={(event) => setSpeed(event.currentTarget.playbackRate)} onVolumeChange={(event) => setVolume(event.currentTarget.volume)} /> : <span className="text-zinc-500">{selectedPov?.status === "Failed" ? selectedPov.error : zh ? "真实 POV 尚未录制完成" : "Real POV is not ready"}</span>}
        </div>}
      </main>
    </div>
    {selected === "2d" && <div className="flex justify-center px-3 pb-2"><div className="flex max-w-full gap-1 overflow-x-auto rounded-full border border-zinc-700 bg-zinc-900 p-1 text-xs shadow-lg">
      {[["select", "Select"], ["pen", "Pen"], ["eraser", "Erase"], ["line", "Line"], ["arrow", "Arrow"], ["rectangle", "Rect"], ["circle", "Circle"], ["note", "Note"], ["smoke", "Smoke"], ["flash", "Flash"], ["he", "HE"], ["molotov", "Molly"], ["c4", "C4"]].map(([mode, label]) => <button type="button" key={mode} disabled={mode !== "select" && !selectedStep} onClick={() => setAnnotationMode(mode)} className={`shrink-0 rounded-full px-2 py-1 disabled:opacity-40 ${annotationMode === mode ? "bg-amber-500 text-black" : "hover:bg-zinc-700"}`}>{label}</button>)}
      <button type="button" aria-label="CT color" onClick={() => setAnnotationColor("#38bdf8")} className="shrink-0 rounded-full bg-sky-500 px-2 text-black">CT</button>
      <button type="button" aria-label="T color" onClick={() => setAnnotationColor("#fbbf24")} className="shrink-0 rounded-full bg-amber-400 px-2 text-black">T</button>
      {annotationMode === "note" && <input aria-label="Annotation text" value={annotationText} onChange={(event) => setAnnotationText(event.target.value)} placeholder={zh ? "标注文字" : "Note text"} className="w-28 shrink-0 rounded bg-zinc-700 px-2 text-white" />}
      <button type="button" disabled={!annotationUndo.length} onClick={() => void changeAnnotationHistory("undo")} className="shrink-0 px-2 disabled:opacity-40">Undo</button>
      <button type="button" disabled={!annotationRedo.length} onClick={() => void changeAnnotationHistory("redo")} className="shrink-0 px-2 disabled:opacity-40">Redo</button>
      <button type="button" disabled={!selectedStep} onClick={() => { if (window.confirm(zh ? "清空当前步骤的全部标注？" : "Clear all annotations in this step?")) { setAnnotationUndo((items) => [...items, selectedStep.annotations || []]); void persistAnnotations([]); } }} className="shrink-0 px-2 disabled:opacity-40">Clear</button>
    </div></div>}
    <div className="flex items-center gap-3 border-t border-zinc-800 px-4 py-2 text-sm text-zinc-400">
      <span>{batch?.status || "Waiting"} · Tick {Math.round(tick)} · {Math.round((tick - Number(activeRound?.freeze_end_tick || 0)) / tickRate)}s</span>
      <label className="flex items-center gap-1"><input type="checkbox" checked={fullQuality} onChange={(event) => setFullQuality(event.target.checked)} />{zh ? "原画质/声音" : "Full quality/audio"}</label>
      <input aria-label="Tactic name" value={tacticName} onChange={(event) => setTacticName(event.target.value)} placeholder={zh ? "战术名称" : "Tactic name"} className="ml-auto w-40 rounded bg-zinc-800 px-2 py-1 text-zinc-100" />
      <button type="button" onClick={() => void saveTactic()} className="rounded bg-zinc-700 px-3 py-1 text-white">{zh ? "保存战术" : "Save tactic"}</button>
      <button type="button" onClick={() => void captureStep()} disabled={!savedTactic} className="rounded bg-zinc-700 px-3 py-1 text-white disabled:opacity-40">{zh ? "捕获步骤" : "Capture step"} {savedTactic?.steps?.length || 0}</button>
      {(savedTactic?.steps || []).map((step) => <button type="button" key={step.id} onClick={() => { setSelectedStepId(step.id); setStepTitle(step.title); setStepNote(step.note); setTick(step.tick); setReplaySeek(step.tick); if (videoRef.current && selectedPov) videoRef.current.currentTime = tickToPovSeconds(step.tick, selectedPov.coverage_start_tick, tickRate, videoRef.current.duration || Infinity); }} className={`rounded border px-2 py-1 ${selectedStepId === step.id ? "border-amber-400" : "border-zinc-700"}`}>{step.step_number}</button>)}
    </div>
    {selectedStepId && <div className="flex gap-2 border-t border-zinc-800 px-4 py-2"><input aria-label="Step title" value={stepTitle} onChange={(event) => setStepTitle(event.target.value)} className="w-40 rounded bg-zinc-800 px-2" /><input aria-label="Step note" value={stepNote} onChange={(event) => setStepNote(event.target.value)} className="min-w-0 flex-1 rounded bg-zinc-800 px-2" /><button type="button" onClick={() => void saveStep()}>{zh ? "保存步骤" : "Save step"}</button><button type="button" onClick={() => void deleteStep()}>{zh ? "删除" : "Delete"}</button></div>}
  </div>;
}
