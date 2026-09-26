import POVSelector from "./POVSelector";
import UtilityFeed from "./UtilityFeed";
import TacticTimeline from "./TacticTimeline";
import { clock } from "./viewerEvents";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Maximize2, Pause, Play, Plus, Save, Volume2, VolumeX } from "lucide-react";
import API, { API_BASE_URL } from "../../api/api";
import { desktopBridge } from "../../desktop/desktopBridge.js";
import { useAppShell } from "../../context/AppShellContext";
import { useT } from "../../i18n/useT";
import Demo2DReplayPreview from "../demo-analysis/replay/Demo2DReplayPreview";
import { povSecondsToTick, tickToPovSeconds } from "./povClock";
import TacticalMultiView from "./TacticalMultiView";
import "./tacticalPlaybook.css";

function normalizeDemoPath(path) {
  const raw = String(path || "").replaceAll("\\", "/");
  const isUncPath = raw.startsWith("//");
  const normalized = `${isUncPath ? "/" : ""}${raw.replace(/\/{2,}/g, "/")}`.replace(/\/$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function Viewer({ initialTactic = null }) {
  const t = useT();
  const shell = useAppShell();
  const shellDemoPath = shell.uploadedDemos?.[shell.currentMatchIndex]?.path || "";
  const [demoPath, setDemoPath] = useState(initialTactic?.source_demo_path || shellDemoPath);
  const workspace = initialTactic?.metadata?.analysis_workspace || (demoPath === shellDemoPath ? shell.analysisWorkspace : null);
  const rounds = workspace?.rounds || [];
  const [roundNumber, setRoundNumber] = useState(initialTactic?.round_number || null);
  const [side, setSide] = useState(initialTactic?.side || "T");
  const [recordingMode, setRecordingMode] = useState("obs");
  const [selected, setSelected] = useState("0");
  const [batch, setBatch] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [autoSaveState, setAutoSaveState] = useState({ status: "idle", batchId: null, error: "" });
  const [multiView, setMultiView] = useState(false);
  const [relinkingDemo, setRelinkingDemo] = useState(false);
  const [sourceDemoAvailable, setSourceDemoAvailable] = useState(initialTactic?.source_demo_available !== false);
  const prepareLock = useRef(false);
  const autoSaveBatchRef = useRef(null);
  const recordingContextRef = useRef(0);
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
  const players = useMemo(() => (workspace?.players || []).filter((player) => player.team_key === teamKey), [workspace?.players, teamKey]);
  const tickRate = Number(workspace?.tick_rate || 64);
  const startTick = Number(activeRound?.freeze_end_tick || activeRound?.start_tick || 0);
  const endTick = Math.max(startTick + 1, Number(activeRound?.record_end_tick || activeRound?.round_end_tick || activeRound?.end_tick || startTick + tickRate * 115));
  const roundEvents = useMemo(() => (activeRound?.events || [])
    .filter((event) => Number(event?.tick) >= startTick && Number(event?.tick) <= endTick)
    .sort((left, right) => Number(left.tick) - Number(right.tick)), [activeRound, startTick, endTick]);
  const visibleEvents = useMemo(() => roundEvents.filter((event) => ["kill", "grenade", "plant", "defuse", "explode", "bomb_pickup", "bomb_drop"].includes(event.type)), [roundEvents]);
  const mapLabel = String(workspace?.map_name || "").replace(/^de_/, "").replace(/^./, (letter) => letter.toUpperCase());
  const defaultTacticName = `${mapLabel || workspace?.map_name || "CS2"} ${side}`;

  useEffect(() => {
    if (!initialTactic && !demoPath && shellDemoPath) setDemoPath(shellDemoPath);
  }, [demoPath, initialTactic, shellDemoPath]);

  useEffect(() => {
    const initialTick = Number(activeRound?.freeze_end_tick || activeRound?.start_tick || 0);
    setTick(initialTick);
    setReplaySeek(initialTick);
    setSelected("0");
    setPlaying(false);
    setBatch(null);
  }, [actualRound]);

  useEffect(() => {
    const id = initialTactic?.metadata?.pov_batch_id;
    if (!id) return;
    let active = true;
    const recordingContext = recordingContextRef.current;
    API.get(`/tactical/prepare-povs/${id}`).then(({ data }) => {
      if (active && recordingContextRef.current === recordingContext) setBatch(data);
    })
      .catch((reason) => {
        if (active && recordingContextRef.current === recordingContext) setError(String(reason?.response?.data?.detail || reason.message));
      });
    return () => { active = false; };
  }, [initialTactic]);

  useEffect(() => {
    if (!batch?.id || ["Complete", "Failed"].includes(batch.status)) return undefined;
    let active = true;
    const poll = setInterval(async () => {
      try {
        const { data } = await API.get(`/tactical/prepare-povs/${batch.id}`);
        if (active) setBatch(data);
      } catch (reason) {
        if (active) setError(String(reason?.response?.data?.detail || reason.message));
      }
    }, 1000);
    return () => { active = false; clearInterval(poll); };
  }, [batch?.id, batch?.status]);

  const resetRecordingContext = () => {
    recordingContextRef.current += 1;
    autoSaveBatchRef.current = null;
    setSavedTactic(null);
    setBatch(null);
    setAutoSaveState({ status: "idle", batchId: null, error: "" });
    setError("");
    setMultiView(false);
  };

  const createDraftTactic = async (fallbackName = defaultTacticName) => {
    const { data } = await API.post("/tactical/tactics", {
      name: tacticName.trim() || fallbackName,
      selection: { demo_path: demoPath, analysis_workspace: workspace, round_number: actualRound, side },
    });
    setSavedTactic(data);
    setTacticName(data.name);
    return data;
  };

  const prepare = async () => {
    if (!demoPath || !workspace || prepareLock.current || ["saving", "failed"].includes(autoSaveState.status)) return;
    prepareLock.current = true;
    setPreparing(true);
    setError("");
    setAutoSaveState({ status: "idle", batchId: null, error: "" });
    try {
      const tactic = savedTactic || await createDraftTactic();
      const { data } = await API.post("/tactical/prepare-povs", {
        demo_path: demoPath, analysis_workspace: workspace,
        round_number: actualRound, side, recording_mode: recordingMode,
        tactic_id: tactic.id,
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

  const relinkSourceDemo = async () => {
    if (!savedTactic || !desktopBridge?.showOpenDialog || relinkingDemo) return;
    setError("");
    let selection;
    try {
      selection = await desktopBridge.showOpenDialog({
        title: t("playbook.relinkDemo"),
        filters: [{ name: "CS2 Demo", extensions: ["dem"] }],
        properties: ["openFile"],
      });
    } catch (reason) {
      setError(String(reason?.message || reason));
      return;
    }
    const nextPath = selection?.filePaths?.[0];
    if (selection?.canceled || !nextPath) return;

    setRelinkingDemo(true);
    try {
      let result;
      try {
        result = await API.patch(`/tactical/tactics/${savedTactic.id}/source-demo`, { demo_path: nextPath });
      } catch (reason) {
        const detail = reason?.response?.data?.detail;
        if (detail?.code !== "DEMO_UNVERIFIED" || !window.confirm(t("playbook.unverifiedDemoConfirm"))) throw reason;
        result = await API.patch(`/tactical/tactics/${savedTactic.id}/source-demo`, {
          demo_path: nextPath, allow_unverified: true,
        });
      }
      setDemoPath(result.data.source_demo_path);
      setSourceDemoAvailable(true);
      setSavedTactic(result.data);
      setBatch((current) => current ? { ...current, demo_path: result.data.source_demo_path } : current);
    } catch (reason) {
      const detail = reason?.response?.data?.detail;
      setError(typeof detail === "object" ? detail.message || JSON.stringify(detail) : String(detail || reason.message));
    } finally {
      setRelinkingDemo(false);
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
        if (batch?.status === "Complete" && batch.players?.length === 5 && batch.players.every((player) => player.status === "Complete")) {
          autoSaveBatchRef.current = batch.id;
          setAutoSaveState({ status: "saved", batchId: batch.id, error: "" });
        }
        return;
      }
      const { data } = await API.post("/tactical/tactics", {
        name: tacticName.trim() || `${workspace.map_name} R${actualRound} ${side}`,
        pov_batch_id: batch?.id || null,
        selection: { demo_path: demoPath, analysis_workspace: workspace, round_number: actualRound, side },
      });
      setSavedTactic(data);
      if (batch?.status === "Complete" && batch.players?.length === 5 && batch.players.every((player) => player.status === "Complete")) {
        autoSaveBatchRef.current = batch.id;
        setAutoSaveState({ status: "saved", batchId: batch.id, error: "" });
      }
    } catch (reason) {
      setError(String(reason?.response?.data?.detail || reason.message));
    }
  };

  const retryFailedPovs = async () => {
    if (!batch?.id || !workspace || !batch.players?.some((player) => player.status !== "Complete") || prepareLock.current) return;
    prepareLock.current = true;
    setPreparing(true);
    setError("");
    try {
      const { data } = await API.post(`/tactical/prepare-povs/${batch.id}/retry`, {
        demo_path: batch.demo_path || demoPath,
        analysis_workspace: workspace,
        round_number: batch.round_number || actualRound,
        side: batch.side || side,
        recording_mode: batch.recording_mode || recordingMode,
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

  const persistCompletedBatch = useCallback(async (target = batch) => {
    if (target?.status !== "Complete" || target.players?.length !== 5 || target.players.some((player) => player.status !== "Complete")) return;
    if (Number(target.round_number) !== actualRound
      || String(target.side || "").toUpperCase() !== String(side).toUpperCase()
      || normalizeDemoPath(target.demo_path) !== normalizeDemoPath(demoPath)) return;
    if (target.id === savedTactic?.metadata?.pov_batch_id) {
      setAutoSaveState({ status: "saved", batchId: target.id, error: "" });
      return;
    }
    if (autoSaveBatchRef.current === target.id) return;
    const recordingContext = recordingContextRef.current;
    autoSaveBatchRef.current = target.id;
    setAutoSaveState({ status: "saving", batchId: target.id, error: "" });
    setError("");
    try {
      let data;
      if (savedTactic) {
        await API.put(`/tactical/tactics/${savedTactic.id}/recording`, { batch_id: target.id });
        ({ data } = await API.get(`/tactical/tactics/${savedTactic.id}`));
      } else {
        ({ data } = await API.post("/tactical/tactics", {
          name: tacticName.trim() || defaultTacticName,
          pov_batch_id: target.id,
          selection: { demo_path: demoPath, analysis_workspace: workspace, round_number: actualRound, side },
        }));
      }
      if (recordingContextRef.current !== recordingContext) return;
      setSavedTactic(data);
      setTacticName(data.name);
      setAutoSaveState({ status: "saved", batchId: target.id, error: "" });
    } catch (reason) {
      if (recordingContextRef.current !== recordingContext) return;
      autoSaveBatchRef.current = null;
      const detail = reason?.response?.data?.detail;
      setAutoSaveState({ status: "failed", batchId: target.id, error: typeof detail === "object" ? detail.message || JSON.stringify(detail) : String(detail || reason.message) });
    }
  }, [actualRound, batch, defaultTacticName, demoPath, savedTactic, side, tacticName, workspace]);

  useEffect(() => {
    if (batch?.status !== "Complete" || batch.players?.length !== 5 || batch.players.some((player) => player.status !== "Complete")) return;
    void persistCompletedBatch(batch);
  }, [batch, persistCompletedBatch]);

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
    if (next === "2d") { setReplaySeek(tick); setMultiView(false); }
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
  const jumpToAdjacentEvent = (direction) => {
    const events = [...visibleEvents].sort((left, right) => Number(left.tick) - Number(right.tick));
    const next = direction > 0
      ? events.find((event) => Number(event.tick) > tick + 1)
      : [...events].reverse().find((event) => Number(event.tick) < tick - 1);
    if (next) seekToTick(next.tick);
  };
  const orderedSteps = [...(savedTactic?.steps || [])].sort((left, right) => Number(left.tick) - Number(right.tick));
  const jumpToAdjacentStep = (direction) => {
    if (!orderedSteps.length) return;
    const index = orderedSteps.findIndex((step) => step.id === selectedStepId);
    const next = index >= 0
      ? orderedSteps[index + direction]
      : direction > 0
        ? orderedSteps.find((step) => Number(step.tick) > tick)
        : [...orderedSteps].reverse().find((step) => Number(step.tick) < tick);
    if (!next) return;
    setSelectedStepId(next.id);
    setStepTitle(next.title || "");
    setStepNote(next.note || "");
    seekToTick(next.tick);
  };
  const hasPreviousEvent = visibleEvents.some((event) => Number(event.tick) < tick - 1);
  const hasNextEvent = visibleEvents.some((event) => Number(event.tick) > tick + 1);
  const selectedStepIndex = orderedSteps.findIndex((step) => step.id === selectedStepId);
  const hasPreviousStep = selectedStepIndex >= 0 ? selectedStepIndex > 0 : orderedSteps.some((step) => Number(step.tick) < tick);
  const hasNextStep = selectedStepIndex >= 0 ? selectedStepIndex < orderedSteps.length - 1 : orderedSteps.some((step) => Number(step.tick) > tick);
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

  const changeRound = (value) => {
    resetRecordingContext();
    setRoundNumber(Number(value));
  };
  const changeSide = (value) => {
    resetRecordingContext();
    setSide(value);
    setSelected("2d");
  };
  const recordingContextLocked = preparing
    || (batch && !["Complete", "Failed"].includes(batch.status))
    || ["saving", "failed"].includes(autoSaveState.status);

  if (!workspace || !demoPath || !rounds.length) {
    return <div className="p-8 text-cs2-text-primary"><p>{t("playbook.sourceMissing")}</p><Link to="/analysis">{t("playbook.goAnalysis")}</Link> · <Link to="/tactics">{t("playbook.back")}</Link></div>;
  }

  return <div className="tactical-workspace" data-testid="tactical-playbook">
    <header className="tactical-header">
      <div className="tactical-round-controls"><select aria-label={t("playbook.round")} value={actualRound} disabled={recordingContextLocked} onChange={(event) => changeRound(event.target.value)}>{rounds.map((row) => <option key={row.round_number} value={row.round_number}>R{row.round_number}</option>)}</select><select aria-label={t("playbook.side")} value={side} disabled={recordingContextLocked} onChange={(event) => changeSide(event.target.value)}>{["T", "CT"].map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
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
        {batch && ["Complete", "Failed"].includes(batch.status) && batch.players?.some((player) => player.status !== "Complete") && <button type="button" className="tactical-action" onClick={retryFailedPovs} disabled={preparing}>{t("playbook.retryFailedPovs")}</button>}
        <Link to="/tactics" className="tactical-action"><ArrowLeft size={15} />{t("playbook.back")}</Link>
        {savedTactic && <button type="button" className="tactical-action" onClick={() => void relinkSourceDemo()} disabled={relinkingDemo || !desktopBridge?.showOpenDialog} data-testid="relink-demo">{relinkingDemo ? t("playbook.relinkingDemo") : sourceDemoAvailable ? t("playbook.relinkDemo") : t("playbook.sourceMissingRelink")}</button>}
        <button type="button" className="tactical-action tactical-action--primary" onClick={prepare} disabled={preparing || ["saving", "failed"].includes(autoSaveState.status) || players.length !== 5 || (batch && !["Complete", "Failed"].includes(batch.status))}>{t("playbook.viewer5")}</button>
      </div>
    </header>
    {autoSaveState.status !== "idle" && <div className={`tactical-autosave tactical-autosave--${autoSaveState.status}`} role={autoSaveState.status === "failed" ? "alert" : "status"}><span>{t(`playbook.autosave.${autoSaveState.status}`)}</span>{autoSaveState.error && <small>{autoSaveState.error}</small>}{autoSaveState.status === "failed" && <button type="button" onClick={() => void persistCompletedBatch(batch)}>{t("playbook.autosave.retry")}</button>}</div>}
    {savedTactic && !sourceDemoAvailable && <div role="alert" className="tactical-error">{t("playbook.sourceFileMissing")}</div>}
    {error && <div role="alert" className="tactical-error">{error}</div>}
    {batch?.status === "Failed" && <div role="alert" className="tactical-error">{batch.error || batch.players?.filter((item) => item.status === "Failed").map((item) => `${item.player_name}: ${item.error}`).join("；") || (t("playbook.viewer6"))}</div>}
    <div className={`tactical-body ${multiView ? "is-multiview" : ""}`}>
      {!multiView && <POVSelector players={players} batch={batch} selected={selected} selectView={selectView} tick={tick} tickRate={tickRate} playing={playing} speed={speed} />}
      <main className={`tactical-stage ${selected === "2d" ? "is-2d" : ""} ${multiView ? "is-multiview" : ""}`} ref={stageRef}>
        <div className="tactical-video-pane">
          <div className="tactical-view-modes" role="group" aria-label={t("playbook.viewMode")}>
            <button type="button" aria-pressed={!multiView} onClick={() => setMultiView(false)}>{t("playbook.view.single")}</button>
            <button type="button" data-testid="toggle-multiview" aria-pressed={multiView} onClick={() => setMultiView(true)} disabled={!batch?.players?.length}>{t("playbook.view.grid")}</button>
          </div>
          {selected !== "2d" && (multiView
            ? <TacticalMultiView players={players} batch={batch} selected={selected} selectView={selectView} tick={tick} tickRate={tickRate} playing={playing} speed={speed} onPlayhead={setTick} />
            : videoUrl ? <video key={videoUrl} ref={videoRef} src={videoUrl} playsInline className="tactical-main-video" onTimeUpdate={(event) => { const nextTick = povSecondsToTick(event.currentTarget.currentTime, selectedPov.coverage_start_tick, tickRate); setTick(nextTick); }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onRateChange={(event) => setSpeed(event.currentTarget.playbackRate)} onVolumeChange={(event) => setVolume(event.currentTarget.volume)} /> : <div className="tactical-video-empty"><span>{selectedPov?.status === "Failed" ? selectedPov.error : t("playbook.viewer8")}</span><small>{batch?.status || "Waiting"}</small></div>)}
          {selected !== "2d" && !multiView && <div className="tactical-video-overlay"><span>{selectedPlayer?.name}</span></div>}
        </div>
        <section className="tactical-radar-pane"><div className="tactical-panel-heading"><strong>{t("playbook.viewer9")}</strong><button onClick={() => selectView(selected === "2d" ? "0" : "2d")} title={t("playbook.expandMap")}><Maximize2 size={14} /></button></div><div className="tactical-radar-canvas"><Demo2DReplayPreview key={`${demoPath}:${actualRound}`} compact workspace={workspace} demoPath={demoPath} players={workspace.players} teamAName={workspace.team_a_name} teamBName={workspace.team_b_name} initialRound={actualRound} externalSeekTick={replaySeek} externalPlayheadTick={selected === "2d" ? null : tick} externalPlaying={playing} externalSpeed={speed} onPlayhead={onReplayTick} onPlaybackChange={onReplayPlaying} annotations={selectedStep?.annotations || []} annotationMode={selectedStep ? annotationMode : "select"} annotationColor={annotationColor} onAnnotationCommit={(item) => void commitAnnotation(item)} onAnnotationDelete={(id) => void removeAnnotation(id)} /></div><div className="tactical-map-legend"><span className="tactical-legend-t">● T</span><span className="tactical-legend-ct">● CT</span><span>☁ {t("playbook.viewer10")}</span><span>✦ {t("playbook.viewer11")}</span></div></section>
        <UtilityFeed visibleEvents={visibleEvents} tick={tick} tickRate={tickRate} startTick={startTick} seekToTick={seekToTick} />
      </main>
    </div>
    <section className="tactical-bottom" aria-label={t("playbook.viewer14")}>
      <div className="tactical-controls">
        <button type="button" aria-label={playing ? t("playbook.pause") : t("playbook.play")} className="tactical-play-button" onClick={togglePlayback}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
        <span className="tactical-time-readout">{clock((tick - startTick) / tickRate)} <span>/ {clock((endTick - startTick) / tickRate)}</span></span>
        <button type="button" className="tactical-jump-button" aria-label={t("playbook.event.previous")} title={t("playbook.event.previous")} disabled={!hasPreviousEvent} onClick={() => jumpToAdjacentEvent(-1)}>‹ {t("playbook.event.previous")}</button>
        <button type="button" className="tactical-jump-button" aria-label={t("playbook.event.next")} title={t("playbook.event.next")} disabled={!hasNextEvent} onClick={() => jumpToAdjacentEvent(1)}>{t("playbook.event.next")} ›</button>
        <select aria-label={t("playbook.playbackSpeed")} value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>{[0.25, 0.5, 1, 1.5, 2, 4].map((rate) => <option key={rate} value={rate}>{rate}x</option>)}</select>
        <label className="tactical-volume">{volume ? <Volume2 size={16} /> : <VolumeX size={16} />}<input aria-label="Volume" type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></label>
        <div className="tactical-control-spacer" />
        <span className="tactical-batch-status">{batch?.status || t("playbook.waiting")} · {t("playbook.tick")} {Math.round(tick)}</span>
        {!multiView && <label className="tactical-quality"><input type="checkbox" checked={fullQuality} onChange={(event) => setFullQuality(event.target.checked)} />{t("playbook.viewer15")}</label>}
        <button type="button" aria-label={t("playbook.fullscreen")} className="tactical-icon-button" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void stageRef.current?.requestFullscreen?.(); }}><Maximize2 size={16} /></button>
      </div>
      <div className="tactical-stepbar"><div className="tactical-stepbar-label">{t("playbook.viewer16")}</div><button type="button" className="tactical-step-nav" aria-label={t("playbook.step.previous")} title={t("playbook.step.previous")} disabled={!hasPreviousStep} onClick={() => jumpToAdjacentStep(-1)}>‹</button><button type="button" className="tactical-step-nav" aria-label={t("playbook.step.next")} title={t("playbook.step.next")} disabled={!hasNextStep} onClick={() => jumpToAdjacentStep(1)}>›</button>{orderedSteps.map((step) => <button type="button" key={step.id} onClick={() => { setSelectedStepId(step.id); setStepTitle(step.title); setStepNote(step.note); seekToTick(step.tick); }} className={`tactical-step-chip ${selectedStepId === step.id ? "is-selected" : ""}`}>Step {step.step_number}<span>{step.title}</span></button>)}<button type="button" onClick={() => void captureStep()} disabled={!savedTactic} className="tactical-add-step"><Plus size={14} />{t("playbook.viewer17")}</button><div className="tactical-control-spacer" /><input aria-label="Tactic name" value={tacticName} onChange={(event) => setTacticName(event.target.value)} placeholder={t("playbook.viewer18")} className="tactical-name-input" /><button type="button" className="tactical-save-button" onClick={() => void saveTactic()}><Save size={14} />{t("playbook.viewer19")}</button></div>
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
