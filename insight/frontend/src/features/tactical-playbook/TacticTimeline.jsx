import { useMemo } from "react";
import { useT } from "../../i18n/useT";
import { clock, eventVisual } from "./viewerEvents";
import { addDeathTimelineEvents } from "./timelineModel";

const TRACKS = [
  { id: "steps", label: "steps" },
  { id: "T", label: "T" },
  { id: "CT", label: "CT" },
  { id: "smoke", label: "playbook.viewer20" },
  { id: "flash", label: "playbook.viewer21" },
  { id: "fire", label: "playbook.viewer22" },
  { id: "utility", label: "playbook.timeline.otherUtility" },
  { id: "bomb", label: "C4" },
  { id: "combat", label: "playbook.timeline.combat" },
];

export default function TacticTimeline({
  startTick,
  endTick,
  tickRate,
  tick,
  visibleEvents,
  steps = [],
  activeStepId = null,
  selectedStepId = null,
  workspace,
  activeRound,
  seekToTick,
  onSelectStep,
}) {
  const t = useT();
  const timelineEvents = useMemo(() => addDeathTimelineEvents(visibleEvents), [visibleEvents]);
  const eventPosition = (value) => `${Math.max(0, Math.min(100, (Number(value) - startTick) / (endTick - startTick) * 100))}%`;

  const matchesTrack = (event, track) => {
    const tone = eventVisual(event, t).tone;
    if (track === "T" || track === "CT") {
      const actor = (workspace.players || []).find((player) => player.name === event.actor);
      const actorSide = actor?.team_key === "a"
        ? activeRound?.team_a_side
        : actor?.team_key === "b" ? activeRound?.team_b_side : null;
      return actorSide === track;
    }
    if (track === "utility") return ["he", "decoy", "utility"].includes(tone);
    if (track === "combat") return ["kill", "death"].includes(tone);
    return tone === track;
  };

  return <>
    <div className="tactical-ruler">
      <span>{clock(0)}</span>
      <span>{clock((endTick - startTick) / tickRate / 4)}</span>
      <span>{clock((endTick - startTick) / tickRate / 2)}</span>
      <span>{clock((endTick - startTick) / tickRate * 3 / 4)}</span>
      <span>{clock((endTick - startTick) / tickRate)}</span>
    </div>
    <div className="tactical-timeline">
      <div className="tactical-track-labels">
        {TRACKS.map((track) => <span key={track.id}>{track.label === "steps" ? t("playbook.timeline.steps") : track.label.startsWith("playbook.") ? t(track.label) : track.label}</span>)}
      </div>
      <div className="tactical-track-canvas">
        <div className="tactical-playhead" style={{ left: eventPosition(tick) }} />
        {TRACKS.map((track) => <div key={track.id} className={`tactical-track-row tactical-track-row--${track.id}`}>
          {track.id === "steps"
            ? steps.map((step) => <button
                type="button"
                key={step.id}
                data-testid={`timeline-step-marker-${step.id}`}
                className={`tactical-step-marker ${step.id === activeStepId ? "is-active" : ""} ${step.id === selectedStepId ? "is-selected" : ""}`}
                style={{ left: eventPosition(step.tick) }}
                title={`${t("playbook.timeline.step")} ${step.step_number} · ${step.title || ""} · ${clock((Number(step.tick) - startTick) / tickRate)}`}
                aria-label={`${t("playbook.timeline.seekStep")} ${step.step_number} at tick ${step.tick}`}
                onClick={() => onSelectStep(step)}
              >{step.step_number}</button>)
            : timelineEvents.filter((event) => matchesTrack(event, track.id)).map((event, index) => {
                const visual = eventVisual(event, t);
                const tone = track.id === "T" || track.id === "CT" ? track.id.toLowerCase() : visual.tone;
                const markerPosition = event.type === "death" ? `calc(${eventPosition(event.tick)} + 5px)` : eventPosition(event.tick);
                return <button
                  type="button"
                  key={`${event.type}-${event.tick}-${event.actor || ""}-${index}`}
                  data-testid={`timeline-event-${event.type}-${event.tick}-${track.id}`}
                  className={`tactical-marker tactical-tone-${tone} ${event.type === "death" ? "is-death" : ""}`}
                  style={{ left: markerPosition }}
                  title={`${clock((Number(event.tick) - startTick) / tickRate)} · ${event.actor || ""} ${visual.label}`}
                  aria-label={`${t("playbook.timeline.seekEvent")} ${visual.label} at tick ${event.tick}`}
                  onClick={() => seekToTick(event.tick)}
                />;
              })}
        </div>)}
        <input aria-label="Tactical timeline" type="range" min={startTick} max={endTick} step="1" value={Math.max(startTick, Math.min(endTick, tick))} onChange={(event) => seekToTick(event.target.value)} />
      </div>
    </div>
  </>;
}
