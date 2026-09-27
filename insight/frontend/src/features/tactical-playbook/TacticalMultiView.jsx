import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/useT";
import { API_BASE_URL } from "../../api/api";
import { povSecondsToTick } from "./povClock";
import { syncPovVideo } from "./povPlayback";

export default function TacticalMultiView({ players, batch, selected, selectView, tick, tickRate, playing, speed, onPlayhead, onPlaybackChange }) {
  const t = useT();
  const videos = useRef(new Map());
  const videoRefCallbacks = useRef(new Map());
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  const clips = useMemo(() => players.map((player, index) => ({
    player,
    index,
    pov: batch?.players?.find((item) => item.steam_id64 === player.steam_id64),
  })), [batch?.players, players]);
  const isCoveredAtTick = (pov) => {
    const start = Number(pov?.coverage_start_tick);
    const end = Number(pov?.coverage_end_tick);
    return (!Number.isFinite(start) || Number(tick) >= start)
      && (!Number.isFinite(end) || Number(tick) < end);
  };
  const completeClips = clips.filter(({ pov }) => pov?.status === "Complete");
  const activeClips = completeClips.filter(({ pov }) => isCoveredAtTick(pov));
  const leader = activeClips.find(({ index }) => String(index) === selected)
    || activeClips[0]
    || completeClips.find(({ index }) => String(index) === selected)
    || completeClips[0];

  const videoRefFor = (index) => {
    if (!videoRefCallbacks.current.has(index)) {
      videoRefCallbacks.current.set(index, (element) => {
        if (element) videos.current.set(index, element);
        else {
          videos.current.get(index)?.pause();
          videos.current.delete(index);
        }
      });
    }
    return videoRefCallbacks.current.get(index);
  };

  useEffect(() => () => {
    videos.current.forEach((video) => video.pause());
    videos.current.clear();
    videoRefCallbacks.current.clear();
  }, []);

  useEffect(() => {
    clips.forEach(({ index, pov }) => {
      const video = videos.current.get(index);
      if (!video) return;
      syncPovVideo(video, pov, {
        tick,
        tickRate,
        playing,
        speed,
        pageVisible,
        role: leader?.index === index ? "leader" : "follower",
        muted: true,
      });
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
          ? <video data-testid={"multiview-pov-" + (index + 1)} ref={videoRefFor(index)} muted playsInline preload="metadata" src={API_BASE_URL + pov.proxy_url}
            onLoadedMetadata={(event) => syncPovVideo(event.currentTarget, pov, {
              tick, tickRate, playing, speed, pageVisible, muted: true,
              role: leader?.index === index ? "leader" : "follower", forceSeek: true,
            })}
            onTimeUpdate={leader?.index === index ? (event) => onPlayhead(povSecondsToTick(
              event.currentTarget.currentTime,
              pov.coverage_start_tick,
              tickRate,
              pov.coverage_end_tick,
            )) : undefined}
            onEnded={leader?.index === index ? (event) => {
              const endTick = povSecondsToTick(
                event.currentTarget.currentTime,
                pov.coverage_start_tick,
                tickRate,
                pov.coverage_end_tick,
              );
              onPlayhead(endTick);
              const hasAnotherCoveredPov = clips.some(({ index: otherIndex, pov: otherPov }) => (
                otherIndex !== index
                && otherPov?.status === "Complete"
                && (!Number.isFinite(Number(otherPov.coverage_start_tick)) || Number(otherPov.coverage_start_tick) <= endTick)
                && (!Number.isFinite(Number(otherPov.coverage_end_tick)) || Number(otherPov.coverage_end_tick) > endTick)
              ));
              if (!hasAnotherCoveredPov) onPlaybackChange?.(false);
            } : undefined}
          />
          : <span className="tactical-multiview-status">{pov?.status || t("playbook.waiting")}</span>}</span>
        <span className="tactical-multiview-name"><strong>{index + 1}. {player.name}</strong><small>{pov?.status || t("playbook.waiting")}</small></span>
      </button>;
    })}
  </div>;
}
