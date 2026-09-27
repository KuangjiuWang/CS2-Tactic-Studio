import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useT";
import { API_BASE_URL } from "../../api/api";
import { syncPovVideo } from "./povPlayback";

function syncPreview(video, pov, tick, tickRate, playing, speed, forceSeek = false) {
  syncPovVideo(video, pov, {
    tick, tickRate, playing, speed, forceSeek, muted: true, role: "follower",
  });
}

export default function POVSelector({ players, batch, selected, selectView, tick, tickRate, playing, speed }) {
  const t = useT();
  const previewVideos = useRef(new Map());
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
      if (!pageVisible) {
        if (!video.paused) video.pause();
        return;
      }
      if (pov?.status === "Complete") syncPreview(video, pov, tick, tickRate, playing, speed);
      else if (!video.paused) video.pause();
    });
  }, [batch?.players, pageVisible, players, playing, speed, tick, tickRate]);

  return <aside className="tactical-pov-rail" aria-label={t("playbook.povViews")}>
        {players.map((player, index) => {
          const pov = batch?.players?.find((item) => item.steam_id64 === player.steam_id64);
          const handlePreviewMetadata = (event) => {
            if (!pageVisible) {
              event.currentTarget.pause();
              return;
            }
            if (pov?.status === "Complete") syncPreview(event.currentTarget, pov, tick, tickRate, playing, speed, true);
          };
          return <button type="button" key={player.steam_id64 || player.name} data-testid={`pov-${index + 1}`} aria-pressed={selected === String(index)} onClick={() => selectView(String(index))} className={`tactical-pov-tile ${selected === String(index) ? "is-selected" : ""}`}>
            <span className="tactical-pov-preview">{pov?.status === "Complete" ? <video data-testid={`pov-preview-${index + 1}`} ref={(element) => { if (element) previewVideos.current.set(index, element); else previewVideos.current.delete(index); }} muted playsInline preload="metadata" src={`${API_BASE_URL}${pov.proxy_url}`} onLoadedMetadata={handlePreviewMetadata} /> : <span className="tactical-pov-status">{pov?.status || t("playbook.waiting")}</span>}</span>
            <span className="tactical-pov-caption"><span className="tactical-pov-number">{index + 1}</span><strong title={player.name}>{player.name}</strong><small className="tactical-pov-state">{pov?.status || ""}</small></span>
          </button>;
        })}
        <button type="button" data-testid="pov-2d" aria-pressed={selected === "2d"} onClick={() => selectView("2d")} className={`tactical-pov-tile tactical-pov-tile--map ${selected === "2d" ? "is-selected" : ""}`}><span className="tactical-pov-map-icon">◎</span><span className="tactical-pov-caption"><strong>{t("playbook.viewer7")}</strong></span></button>
      </aside>;
}
