import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useT";
import { API_BASE_URL } from "../../api/api";
import { tickToPovSeconds } from "./povClock";

function syncPreview(video, pov, tick, tickRate, playing, speed, forceSeek = false) {
  video.muted = true;
  video.playbackRate = Number(speed) || 1;
  if (forceSeek || video.readyState >= 1) {
    const target = tickToPovSeconds(tick, pov.coverage_start_tick, tickRate, video.duration || Infinity);
    if (forceSeek || Math.abs(video.currentTime - target) > (playing ? 0.75 : 0.08)) video.currentTime = target;
  }
  if (playing) {
    if (video.paused) {
      try { void video.play()?.catch(() => {}); } catch { /* A preview may be blocked before it has a decodable frame. */ }
    }
  } else if (!video.paused) video.pause();
}

export default function POVSelector({ players, batch, selected, selectView, tick, tickRate, playing, speed }) {
  const t = useT();
  const previewVideos = useRef(new Map());
  const [lowResource, setLowResource] = useState(() => {
    try { return localStorage.getItem("tacticalPovLowResource") !== "false"; }
    catch { return true; }
  });
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  useEffect(() => {
    players.forEach((player, index) => {
      const video = previewVideos.current.get(index);
      const pov = batch?.players?.find((item) => item.steam_id64 === player.steam_id64);
      if (!video) return;
      if (!pageVisible || (lowResource && selected !== String(index))) {
        if (!video.paused) video.pause();
        return;
      }
      if (pov?.status === "Complete") syncPreview(video, pov, tick, tickRate, playing, speed);
      else if (!video.paused) video.pause();
    });
  }, [batch?.players, lowResource, pageVisible, players, playing, selected, speed, tick, tickRate]);

  const changeResourceMode = (enabled) => {
    setLowResource(enabled);
    try { localStorage.setItem("tacticalPovLowResource", String(enabled)); } catch { /* Preference storage is optional. */ }
  };

  return <aside className="tactical-pov-rail" aria-label={t("playbook.povViews")}>
        <label className="tactical-preview-mode"><input type="checkbox" aria-label={t("playbook.lowResourcePreview")} checked={lowResource} onChange={(event) => changeResourceMode(event.target.checked)} /><span>{t("playbook.lowResourcePreview")}</span></label>
        {players.map((player, index) => {
          const pov = batch?.players?.find((item) => item.steam_id64 === player.steam_id64);
          const handlePreviewMetadata = (event) => {
            if (!pageVisible) {
              event.currentTarget.pause();
              return;
            }
            const previewPlaying = playing && (!lowResource || selected === String(index));
            syncPreview(event.currentTarget, pov, tick, tickRate, previewPlaying, speed, true);
          };
          return <button type="button" key={player.steam_id64 || player.name} data-testid={`pov-${index + 1}`} aria-pressed={selected === String(index)} onClick={() => selectView(String(index))} className={`tactical-pov-tile ${selected === String(index) ? "is-selected" : ""}`}>
            <span className="tactical-pov-preview">{pov?.status === "Complete" ? <video data-testid={`pov-preview-${index + 1}`} ref={(element) => { if (element) previewVideos.current.set(index, element); else previewVideos.current.delete(index); }} muted playsInline preload="metadata" src={`${API_BASE_URL}${pov.proxy_url}`} onLoadedMetadata={handlePreviewMetadata} /> : <span className="tactical-pov-status">{pov?.status || t("playbook.waiting")}</span>}</span>
            <span className="tactical-pov-caption"><span className="tactical-pov-number">{index + 1}</span><strong title={player.name}>{player.name}</strong><small className="tactical-pov-state">{pov?.status || ""}</small></span>
          </button>;
        })}
        <button type="button" data-testid="pov-2d" aria-pressed={selected === "2d"} onClick={() => selectView("2d")} className={`tactical-pov-tile tactical-pov-tile--map ${selected === "2d" ? "is-selected" : ""}`}><span className="tactical-pov-map-icon">◎</span><span className="tactical-pov-caption"><strong>{t("playbook.viewer7")}</strong></span></button>
      </aside>;
}
