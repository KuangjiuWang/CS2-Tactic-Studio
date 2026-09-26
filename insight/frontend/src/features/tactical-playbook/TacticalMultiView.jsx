import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/useT";
import { API_BASE_URL } from "../../api/api";
import { tickToPovSeconds, povSecondsToTick } from "./povClock";

export default function TacticalMultiView({ players, batch, selected, selectView, tick, tickRate, playing, speed, onPlayhead }) {
  const t = useT();
  const videos = useRef(new Map());
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  const clips = useMemo(() => players.map((player, index) => ({
    player,
    index,
    pov: batch?.players?.find((item) => item.steam_id64 === player.steam_id64),
  })), [batch?.players, players]);
  const leader = clips.find(({ index, pov }) => String(index) === selected && pov?.status === "Complete")
    || clips.find(({ pov }) => pov?.status === "Complete");

  useEffect(() => {
    clips.forEach(({ index, pov }) => {
      const video = videos.current.get(index);
      if (!video) return;
      if (!pageVisible || pov?.status !== "Complete") {
        if (!video.paused) video.pause();
        return;
      }
      video.muted = true;
      video.playbackRate = Number(speed) || 1;
      const target = tickToPovSeconds(tick, pov.coverage_start_tick, tickRate, video.duration || Infinity);
      const isLeader = leader?.index === index;
      if ((!playing || !isLeader) && (video.readyState >= 1) && Math.abs(video.currentTime - target) > (playing ? 0.35 : 0.04)) {
        video.currentTime = target;
      } else if (playing && isLeader && Math.abs(video.currentTime - target) > 1) {
        video.currentTime = target;
      }
      if (playing && video.paused) {
        try { void video.play()?.catch(() => {}); } catch { /* A preview may not have a decoded frame yet. */ }
      } else if (!playing && !video.paused) video.pause();
    });
  }, [clips, leader?.index, pageVisible, playing, speed, tick, tickRate]);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return <div className="tactical-multiview" data-testid="tactical-multiview">
    {clips.map(({ player, index, pov }) => {
      const complete = pov?.status === "Complete" && pov.proxy_url;
      return <button type="button" key={player.steam_id64 || player.name} className={`tactical-multiview-tile ${selected === String(index) ? "is-focused" : ""}`} aria-pressed={selected === String(index)} onClick={() => selectView(String(index))}>
        <span className="tactical-multiview-video">{complete
          ? <video data-testid={`multiview-pov-${index + 1}`} ref={(element) => { if (element) videos.current.set(index, element); else videos.current.delete(index); }} muted playsInline preload="metadata" src={`${API_BASE_URL}${pov.proxy_url}`} onLoadedMetadata={(event) => { const video = event.currentTarget; video.muted = true; const target = tickToPovSeconds(tick, pov.coverage_start_tick, tickRate, video.duration || Infinity); video.currentTime = target; if (playing && pageVisible) void video.play()?.catch(() => {}); }} onTimeUpdate={leader?.index === index ? (event) => onPlayhead(povSecondsToTick(event.currentTarget.currentTime, pov.coverage_start_tick, tickRate)) : undefined} />
          : <span className="tactical-multiview-status">{pov?.status || t("playbook.waiting")}</span>}</span>
        <span className="tactical-multiview-name"><strong>{index + 1}. {player.name}</strong><small>{pov?.status || t("playbook.waiting")}</small></span>
      </button>;
    })}
  </div>;
}
