import { Bomb, CircleHelp, Crosshair, Flame, Swords, Zap } from "lucide-react";
export function clock(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function eventVisual(event, t) {
  const kind = String(event?.kind || "").toLowerCase();
  if (event?.type === "kill") return { icon: Swords, label: t("playbook.kill"), tone: "kill" };
  if (["plant", "defuse", "explode", "bomb_pickup", "bomb_drop"].includes(event?.type)) return { icon: Bomb, label: "C4", tone: "bomb" };
  if (/smoke|烟/.test(kind)) return { icon: CircleHelp, label: t("playbook.smoke"), tone: "smoke" };
  if (/flash|闪/.test(kind)) return { icon: Zap, label: t("playbook.flash"), tone: "flash" };
  if (/molotov|incendiary|燃|火/.test(kind)) return { icon: Flame, label: t("playbook.fire"), tone: "fire" };
  if (/decoy/.test(kind)) return { icon: Crosshair, label: t("playbook.decoy"), tone: "decoy" };
  if (/hegrenade|high explosive|^he$/.test(kind)) return { icon: Bomb, label: t("playbook.he"), tone: "he" };
  return { icon: Crosshair, label: event?.kind || t("playbook.utility"), tone: "utility" };
}
