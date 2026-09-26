import { Search } from "lucide-react";
import { useT } from "../../i18n/useT";
import { mapLabel, TACTICAL_MAPS, TACTIC_CATEGORIES, TACTIC_SITES, TACTIC_UTILITIES, TACTIC_RESULTS } from "./libraryModel";

export default function PlaybookFilters({ filters, change }) {
  const t = useT();
  return <div className="playbook-filters">
    <label className="playbook-search"><Search size={17} /><input aria-label={t("playbook.search")} placeholder={t("playbook.search")} value={filters.search} onChange={(e) => change("search", e.target.value)} /></label>
    <select aria-label={t("playbook.map")} value={filters.map} onChange={(e) => change("map", e.target.value)}><option value="">{t("playbook.allMaps")}</option>{TACTICAL_MAPS.map((map) => <option key={map} value={map}>{mapLabel(map)}</option>)}</select>
    <select aria-label={t("playbook.side")} value={filters.side} onChange={(e) => change("side", e.target.value)}><option value="">{t("playbook.bothSides")}</option><option>T</option><option>CT</option></select>
    <select aria-label={t("playbook.category")} value={filters.category} onChange={(e) => change("category", e.target.value)}><option value="">{t("playbook.allCategories")}</option>{TACTIC_CATEGORIES.map((value) => <option key={value} value={value}>{t(`playbook.category.${value}`)}</option>)}</select>
    <select aria-label={t("playbook.site")} value={filters.site} onChange={(e) => change("site", e.target.value)}><option value="">{t("playbook.allSites")}</option>{TACTIC_SITES.map((value) => <option key={value} value={value}>{t(`playbook.site.${value}`)}</option>)}</select>
    <select aria-label={t("playbook.utilityFilter")} value={filters.utility} onChange={(e) => change("utility", e.target.value)}><option value="">{t("playbook.allUtilities")}</option>{TACTIC_UTILITIES.map((value) => <option key={value} value={value}>{t(`playbook.utility.${value}`)}</option>)}</select>
    <select aria-label={t("playbook.result")} value={filters.result} onChange={(e) => change("result", e.target.value)}><option value="">{t("playbook.allResults")}</option>{TACTIC_RESULTS.map((value) => <option key={value} value={value}>{t(`playbook.result.${value}`)}</option>)}</select>
    <select aria-label={t("playbook.pov")} value={filters.pov} onChange={(e) => change("pov", e.target.value)}><option value="">{t("playbook.allPovs")}</option>{["ready", "generating", "partial", "failed", "none"].map((status) => <option key={status} value={status}>{t(`playbook.${status}`)}</option>)}</select>
    <select aria-label={t("playbook.sort")} value={filters.sort} onChange={(e) => change("sort", e.target.value)}><option value="updated">{t("playbook.updated")}</option><option value="name">{t("playbook.name")}</option></select>
  </div>;
}
