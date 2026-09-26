import { DEMO_LIBRARY_MAP_OPTIONS } from "../../constants/demoLibraryFilters";

export const TACTICAL_MAPS = DEMO_LIBRARY_MAP_OPTIONS;
export const TACTIC_CATEGORIES = ["default", "execute", "retake", "postplant", "clutch", "eco", "other"];
export const TACTIC_SITES = ["A", "B", "Mid", "Other"];
export const TACTIC_UTILITIES = ["smoke", "flash", "molotov", "he", "decoy"];
export const TACTIC_RESULTS = ["win", "loss", "neutral"];
export const mapLabel = (map) => String(map || "").replace(/^de_/, "").replace(/^./, (c) => c.toUpperCase());
export const folderIds = (tactic) => tactic.folder_ids ?? (tactic.folder_id ? [tactic.folder_id] : []);
export function folderPath(folder, folders) {
  const names = [], seen = new Set();
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id); names.unshift(folder.name);
    folder = folders.find((item) => item.id === folder.parent_id);
  }
  return names.join(" / ");
}
export function descendants(id, folders) {
  const ids = new Set([id]);
  let count;
  do {
    count = ids.size;
    folders.forEach((folder) => { if (ids.has(folder.parent_id)) ids.add(folder.id); });
  } while (count !== ids.size);
  return ids;
}
export function filterTactics(tactics, { folder, search = "", map = "", side = "", pov = "", category = "", site = "", utility = "", result = "", sort = "updated" }) {
  const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return tactics.filter((item) => {
    const meta = item.metadata || {};
    const classification = meta.classification || {};
    const haystack = [item.name, item.description, item.map_name, item.round_number, `R${item.round_number}`,
      meta.source_match, meta.source_team, meta.opponent, ...(meta.tags || []), ...(classification.tags || []),
      classification.category, classification.site, ...(classification.utility || []), classification.result,
      item.source_demo_path].join(" ").toLowerCase();
    return (!folder || folderIds(item).includes(folder)) && (!map || item.map_name === map)
      && (!side || item.side === side) && (!pov || (item.pov_status || "none") === pov)
      && (!category || classification.category === category) && (!site || classification.site === site)
      && (!utility || (classification.utility || []).includes(utility)) && (!result || classification.result === result)
      && words.every((word) => haystack.includes(word));
  }).sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : String(b.updated_at).localeCompare(String(a.updated_at)));
}
