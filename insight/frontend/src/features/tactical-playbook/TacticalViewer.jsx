import POVSelector from "./POVSelector";
import UtilityFeed from "./UtilityFeed";
import TacticTimeline from "./TacticTimeline";
import { clock } from "./viewerEvents";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Maximize2, Pause, Play, Plus, Save, Volume2, VolumeX } from "lucide-react";
import API, { API_BASE_URL } from "../../api/api";
import { useAppShell } from "../../context/AppShellContext";
import { useT } from "../../i18n/useT";
import Demo2DReplayPreview from "../demo-analysis/replay/Demo2DReplayPreview";
import { povSecondsToTick, tickToPovSeconds } from "./povClock";
import "./tacticalPlaybook.css";

function Viewer({ initialTactic = null }) {
  const t = useT();
  const shell = useAppShell();
  const workspace = initialTactic?.metadata?.analysis_workspace || shell.analysisWorkspace;
  const demoPath = initialTactic?.source_demo_path || shell.uploadedDemos?.[shell.currentMatchIndex]?.path;
  const rounds = workspace?.rounds || [];
  const [roundNumber, setRoundNumber] = useState(initialTactic?.round_number || null);
  const [side, setSide] = useState(initialTactic?.side || "T");
  const [recordingMode, setRecordingMode] = useState("obs");
  const [selected, setSelected] = useState("0");
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
  const [tacticName, setTacticName] = useState(initialTactic?.name || "");
  const [savedTactic, setSavedTactic] = useState(initialTactic);
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
  const mapLabel = String(workspace?.map_name || "").replace(/^de_/, "").replace(/^./, (letter) => letter.toUpperCase());

  useEffect(() => {
    const initialTick = Number(activeRound?.freeze_end_tick || activeRound?.start_tick || 0);
    setTick(initialTick);
    setReplaySeek(initialTick);
    setSelected("0");
    setPlaying(false);
    setBatch(null);
  }, [demoPath, actualRound]);

  useEffect(() => {
    const id = initialTactic?.metadata?.pov_batch_id;
    if (!id) return;
    let active = true;
    API.get(`/tactical/prepare-povs/${id}`).then(({ data }) => { if (active) setBatch(data); })
      .catch((reason) => { if (active) setError(String(reason?.response?.data?.detail || reason.message)); });
    return () => { active = false; };
  }, [initialTactic]);

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
      if (savedTactic) {
        await API.patch(`/tactical/tactics/${savedTactic.id}/name`, { name: tacticName.trim() || savedTactic.name });
        if (batch?.id && batch.id !== savedTactic.metadata?.pov_batch_id) await API.put(`/tactical/tactics/${savedTactic.id}/recording`, { batch_id: batch.id });
        const { data } = await API.get(`/tactical/tactics/${savedTactic.id}`);
        setSavedTactic(data);
        return;
      }
      const { data } = await API.post("/tactical/tactics", {
        name: tacticName.trim() || `${workspace.map_name} R${actualRound} ${side}`,
        pov_batch_id: batch?.id || null,
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

  if (!workspace || !demoPath || !rounds.length || (initialTactic && !initialTactic.metadata?.analysis_workspace && initialTactic.source_demo_path !== shell.uploadedDemos?.[shell.currentMatchIndex]?.path)) {
    return <div className="p-8 text-cs2-text-primary"><p>{t("playbook.sourceMissing")}</p><Link to="/analysis">{t("playbook.goAnalysis")}</Link> · <Link to="/tactics">{t("playbook.back")}</Link></div>;
  }

  return <div className="tactical-workspace" data-testid="tactical-playbook">
    <header className="tactical-header">
      <div className="tactical-round-controls"><select aria-label={t("playbook.round")} value={actualRound} onChange={(event) => { setSavedTactic(null); setRoundNumber(Number(event.target.value)); }}>{rounds.map((row) => <option key={row.round_number} value={row.round_number}>R{row.round_number}</option>)}</select><select aria-label={t("playbook.side")} value={side} onChange={(event) => { setSavedTactic(null); setSide(event.target.value); setBatch(null); setSelected("2d"); }}><option value="T">T</option><option value="CT">CT</option></select></div>
      <div className="tactical-match">
        <div className="tactical-score"><strong>{workspace.team_a_name || "Team A"}</strong><span>{activeRound?.team_a_score_before ?? "–"} : {activeRound?.team_b_score_before ?? "–"}</span><strong>{workspace.team_b_name || "Team B"}</strong></div>
        <div className="tactical-match-meta">{mapLabel} <span>│</span> R{actualRound} <span>│</span> {side} {t("playbook.viewer1")}</div>
      </div>
      <div className="tactical-header-actions">
        <div className="tactical-recording-mode" role="group" aria-label={t("playbook.viewer2")}>
          <button type="button" data-testid="record-mode-obs" aria-pressed={recordingMode === "obs"} disabled={preparing || (batch && !["Complete", "Failed"].includes(batch.status))} className={recordingMode === "obs" ? "is-selected" : ""} onClick={() => setRecordingMode("obs")}>OBS</button>
          <button type="button" data-testid="record-mode-hlae" aria-pressed={recordingMode === "hlae"} title={t("playbook.viewer3")} disabled={preparing || (batch && !["Complete", "Failed"].includes(batch.status))} className={recordingMode === "hlae" ? "is-selected" : ""} onClick={() => setRecordingMode("hlae")}>HLAE</button>
        </div>
        {recordingMode === "hlae" && <span className="tactical-mode-hint">{t("playbook.viewer4")}</span>}
        <Link to="/tactics" className="tactical-action"><ArrowLeft size={15} />{t("playbook.back")}</Link>
        <button type="button" className="tactical-action tactical-action--primary" onClick={prepare} disabled={preparing || players.length !== 5 || (batch && !["Complete", "Failed"].includes(batch.status))}>{t("playbook.viewer5")}</button>
      </div>
    </header>
    {error && <div role="alert" className="tactical-error">{error}</div>}
    {batch?.status === "Failed" && <div role="alert" className="tactical-error">{batch.error || batch.players?.filter((item) => item.status === "Failed").map((item) => `${item.player_name}: ${item.error}`).join("；") || (t("playbook.viewer6"))}</div>}
    <div className="tactical-body">
      <POVSelector players={players} batch={batch} selected={selected} selectView={selectView} tick={tick} tickRate={tickRate} />
      <main className={`tactical-stage ${selected === "2d" ? "is-2d" : ""}`} ref={stageRef}>
        <div className="tactical-video-pane">
          {selected !== "2d" && (videoUrl ? <video key={videoUrl} ref={videoRef} src={videoUrl} playsInline className="tactical-main-video" onTimeUpdate={(event) => { const nextTick = povSecondsToTick(event.currentTarget.currentTime, selectedPov.coverage_start_tick, tickRate); setTick(nextTick); setReplaySeek(nextTick); }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onRateChange={(event) => setSpeed(event.currentTarget.playbackRate)} onVolumeChange={(event) => setVolume(event.currentTarget.volume)} /> : <div className="tactical-video-empty"><span>{selectedPov?.status === "Failed" ? selectedPov.error : t("playbook.viewer8")}</span><small>{batch?.status || "Waiting"}</small></div>)}
          {selected !== "2d" && <div className="tactical-video-overlay"><span>{selectedPlayer?.name}</span></div>}
        </div>
        <section className="tactical-radar-pane"><div className="tactical-panel-heading"><strong>{t("playbook.viewer9")}</strong><button onClick={() => selectView(selected === "2d" ? "0" : "2d")} title={t("playbook.expandMap")}><Maximize2 size={14} /></button></div><div className="tactical-radar-canvas"><Demo2DReplayPreview key={`${demoPath}:${actualRound}`} compact workspace={workspace} demoPath={demoPath} players={workspace.players} teamAName={workspace.team_a_name} teamBName={workspace.team_b_name} initialRound={actualRound} externalSeekTick={replaySeek} externalPlaying={selected === "2d" ? playing : false} externalSpeed={speed} onPlayhead={onReplayTick} onPlaybackChange={onReplayPlaying} annotations={selectedStep?.annotations || []} annotationMode={selectedStep ? annotationMode : "select"} annotationColor={annotationColor} onAnnotationCommit={(item) => void commitAnnotation(item)} onAnnotationDelete={(id) => void removeAnnotation(id)} /></div><div className="tactical-map-legend"><span className="tactical-legend-t">● T</span><span className="tactical-legend-ct">● CT</span><span>☁ {t("playbook.viewer10")}</span><span>✦ {t("playbook.viewer11")}</span></div></section>
        <UtilityFeed visibleEvents={visibleEvents} tick={tick} tickRate={tickRate} startTick={startTick} seekToTick={seekToTick} />
      </main>
    </div>
    <section className="tactical-bottom" aria-label={t("playbook.viewer14")}>
      <div className="tactical-controls">
        <button type="button" aria-label={playing ? t("playbook.pause") : t("playbook.play")} className="tactical-play-button" onClick={togglePlayback}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
        <span className="tactical-time-readout">{clock((tick - startTick) / tickRate)} <span>/ {clock((endTick - startTick) / tickRate)}</span></span>
        <select aria-label={t("playbook.playbackSpeed")} value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>{[0.25, 0.5, 1, 1.5, 2, 4].map((rate) => <option key={rate} value={rate}>{rate}x</option>)}</select>
        <label className="tactical-volume">{volume ? <Volume2 size={16} /> : <VolumeX size={16} />}<input aria-label="Volume" type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></label>
        <div className="tactical-control-spacer" />
        <span className="tactical-batch-status">{batch?.status || t("playbook.waiting")} · {t("playbook.tick")} {Math.round(tick)}</span>
        <label className="tactical-quality"><input type="checkbox" checked={fullQuality} onChange={(event) => setFullQuality(event.target.checked)} />{t("playbook.viewer15")}</label>
        <button type="button" aria-label={t("playbook.fullscreen")} className="tactical-icon-button" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void stageRef.current?.requestFullscreen?.(); }}><Maximize2 size={16} /></button>
      </div>
      <div className="tactical-stepbar"><div className="tactical-stepbar-label">{t("playbook.viewer16")}</div>{(savedTactic?.steps || []).map((step) => <button type="button" key={step.id} onClick={() => { setSelectedStepId(step.id); setStepTitle(step.title); setStepNote(step.note); seekToTick(step.tick); }} className={`tactical-step-chip ${selectedStepId === step.id ? "is-selected" : ""}`}>Step {step.step_number}<span>{step.title}</span></button>)}<button type="button" onClick={() => void captureStep()} disabled={!savedTactic} className="tactical-add-step"><Plus size={14} />{t("playbook.viewer17")}</button><div className="tactical-control-spacer" /><input aria-label="Tactic name" value={tacticName} onChange={(event) => setTacticName(event.target.value)} placeholder={t("playbook.viewer18")} className="tactical-name-input" /><button type="button" className="tactical-save-button" onClick={() => void saveTactic()}><Save size={14} />{t("playbook.viewer19")}</button></div>
      <TacticTimeline startTick={startTick} endTick={endTick} tickRate={tickRate} tick={tick} visibleEvents={visibleEvents} workspace={workspace} activeRound={activeRound} seekToTick={seekToTick} />
      {selected === "2d" && <div className="tactical-annotation-toolbar">{["select", "pen", "eraser", "rectangle", "circle", "note", "line", "arrow", "smoke", "flash", "he", "molotov", "c4"].map((mode) => <button type="button" key={mode} disabled={mode !== "select" && !selectedStep} onClick={() => setAnnotationMode(mode)} className={annotationMode === mode ? "is-selected" : ""}>{t(`playbook.annotation.${mode}`)}</button>)}<button type="button" aria-label={t("playbook.colorCt")} onClick={() => setAnnotationColor("#38bdf8")}>CT</button><button type="button" aria-label={t("playbook.colorT")} onClick={() => setAnnotationColor("#fbbf24")}>T</button>{annotationMode === "note" && <input aria-label={t("playbook.annotationText")} value={annotationText} onChange={(event) => setAnnotationText(event.target.value)} placeholder={t("playbook.viewer24")} />}<button type="button" disabled={!annotationUndo.length} onClick={() => void changeAnnotationHistory("undo")}>↶</button><button type="button" disabled={!annotationRedo.length} onClick={() => void changeAnnotationHistory("redo")}>↷</button><button type="button" disabled={!selectedStep} onClick={() => { if (window.confirm(t("playbook.viewer25"))) { setAnnotationUndo((items) => [...items, selectedStep.annotations || []]); void persistAnnotations([]); } }}>{t("playbook.viewer26")}</button></div>}
      {selectedStepId && <div className="tactical-step-edit"><input aria-label="Step title" value={stepTitle} onChange={(event) => setStepTitle(event.target.value)} /><input aria-label="Step note" value={stepNote} onChange={(event) => setStepNote(event.target.value)} /><button type="button" onClick={() => void saveStep()}>{t("playbook.viewer27")}</button><button type="button" onClick={() => void deleteStep()}>{t("playbook.viewer28")}</button></div>}
    </section>
  </div>;
}

export default function TacticalViewer() {
  const { tacticId } = useParams();
  const t = useT();
  const [state, setState] = useState({ id: null, tactic: null, error: "" });
  useEffect(() => {
    if (!tacticId) return;
    let active = true;
    API.get(`/tactical/tactics/${tacticId}`).then(({ data }) => {
      if (active) setState({ id: tacticId, tactic: data, error: "" });
    }).catch((error) => { if (active) setState({ id: tacticId, tactic: null, error: String(error?.response?.data?.detail || error.message) }); });
    return () => { active = false; };
  }, [tacticId]);
  if (tacticId && state.id !== tacticId) return <p className="p-8 text-cs2-text-primary">{t("playbook.loading")}</p>;
  if (tacticId && !state.tactic) return <div role="alert" className="p-8 text-cs2-text-primary">{t("playbook.notFound")} {state.error} <Link to="/tactics">{t("playbook.back")}</Link></div>;
  return <Viewer key={tacticId || "new"} initialTactic={tacticId ? state.tactic : null} />;
}
