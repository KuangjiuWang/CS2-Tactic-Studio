import { useT } from "../../i18n/useT";
import { clock, eventVisual } from "./viewerEvents";
export default function UtilityFeed({ visibleEvents, tick, tickRate, startTick, seekToTick }) {
 const t = useT();
 return <section className="tactical-events-pane"><div className="tactical-panel-heading"><strong>{t("playbook.viewer12")}</strong><span>{visibleEvents.length}</span></div><div className="tactical-events-list">{visibleEvents.length ? visibleEvents.map((event, index) => { const visual = eventVisual(event, t); const Icon = visual.icon; return <button type="button" key={`${event.type}-${event.tick}-${index}`} className={`tactical-event tactical-tone-${visual.tone} ${Math.abs(Number(event.tick) - tick) < tickRate ? "is-current" : ""}`} onClick={() => seekToTick(event.tick)}><span className="tactical-event-time">{clock((Number(event.tick) - startTick) / tickRate)}</span><Icon size={14} /><span className="tactical-event-actor">{event.actor || "—"}</span><span className="tactical-event-kind">{visual.label}{event.target ? ` → ${event.target}` : ""}</span></button>; }) : <p className="tactical-events-empty">{t("playbook.viewer13")}</p>}</div></section>;
}
