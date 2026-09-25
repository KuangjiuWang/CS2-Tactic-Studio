import { useT } from "../../i18n/useT";
import { API_BASE_URL } from "../../api/api";
import { tickToPovSeconds } from "./povClock";
export default function POVSelector({ players, batch, selected, selectView, tick, tickRate }) {
  const t = useT();
  return <aside className="tactical-pov-rail" aria-label={t("playbook.povViews")}>
        {players.map((player, index) => {
          const pov = batch?.players?.find((item) => item.steam_id64 === player.steam_id64);
          return <button type="button" key={player.steam_id64 || player.name} data-testid={`pov-${index + 1}`} aria-pressed={selected === String(index)} onClick={() => selectView(String(index))} className={`tactical-pov-tile ${selected === String(index) ? "is-selected" : ""}`}>
            <span className="tactical-pov-preview">{pov?.status === "Complete" ? <video muted playsInline preload="metadata" src={`${API_BASE_URL}${pov.proxy_url}`} onLoadedMetadata={(event) => { event.currentTarget.currentTime = tickToPovSeconds(tick, pov.coverage_start_tick, tickRate, event.currentTarget.duration || Infinity); }} /> : <span className="tactical-pov-status">{pov?.status || t("playbook.waiting")}</span>}</span>
            <span className="tactical-pov-caption"><span className="tactical-pov-number">{index + 1}</span><strong title={player.name}>{player.name}</strong><small className="tactical-pov-state">{pov?.status || ""}</small></span>
          </button>;
        })}
        <button type="button" data-testid="pov-2d" aria-pressed={selected === "2d"} onClick={() => selectView("2d")} className={`tactical-pov-tile tactical-pov-tile--map ${selected === "2d" ? "is-selected" : ""}`}><span className="tactical-pov-map-icon">◎</span><span className="tactical-pov-caption"><strong>{t("playbook.viewer7")}</strong></span></button>
      </aside>;
}
