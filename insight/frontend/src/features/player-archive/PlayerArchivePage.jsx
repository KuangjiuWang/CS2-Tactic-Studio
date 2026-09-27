import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Folder, Map, Search, ShieldCheck, Users, UserRound, ArrowUpRight, GitCompareArrows } from "lucide-react";
import API from "../../api/api";
import { useT } from "../../i18n/useT.js";
import { aggregateMatches } from "./playerArchiveStats.js";
import "./playerArchive.css";

const COLLECTIONS = ["professional", "amateur", "squad"];

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatRate(value, suffix = "%") {
  return value == null ? "—" : `${Number(value).toFixed(1)}${suffix}`;
}

export default function PlayerArchivePage() {
  const t = useT();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [group, setGroup] = useState(() => ["professional", "amateur", "squad"].includes(searchParams.get("group")) ? searchParams.get("group") : "all");
  const [query, setQuery] = useState(() => searchParams.get("q") || "");
  const [mapName, setMapName] = useState(() => searchParams.get("map") || "");
  const [directory, setDirectory] = useState({ players: [], groups: COLLECTIONS, group_counts: {}, maps: [], total: 0 });
  const [compareKeys, setCompareKeys] = useState(() => [...new Set(searchParams.getAll("compare"))].slice(0, 2));
  const [compareProfiles, setCompareProfiles] = useState([]);
  const [compareError, setCompareError] = useState(false);
  const [compareRetry, setCompareRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [compareLoading, setCompareLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    group === "all" ? next.delete("group") : next.set("group", group);
    query ? next.set("q", query) : next.delete("q");
    mapName ? next.set("map", mapName) : next.delete("map");
    next.delete("compare");
    compareKeys.forEach((key) => next.append("compare", key));
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [compareKeys, group, mapName, query, searchParams, setSearchParams]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      API.get("/player-archive", { params: { group, q: query, map_name: mapName } })
        .then(({ data }) => {
          if (!active) return;
          setDirectory(data);
          setError("");
        })
        .catch((cause) => {
          if (active) setError(String(cause?.response?.data?.detail || cause?.message || cause));
        })
        .finally(() => { if (active) setLoading(false); });
    }, query ? 140 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [group, mapName, query]);

  useEffect(() => {
    let active = true;
    if (!compareKeys.length) {
      setCompareProfiles([]);
      setCompareLoading(false);
      setCompareError(false);
      return () => { active = false; };
    }
    setCompareLoading(true);
    setCompareError(false);
    Promise.all(compareKeys.map((key) => API.get(`/player-archive/players/${encodeURIComponent(key)}`)))
      .then((responses) => { if (active) setCompareProfiles(responses.map((response) => response.data)); })
      .catch(() => { if (active) { setCompareProfiles([]); setCompareError(true); } })
      .finally(() => { if (active) setCompareLoading(false); });
    return () => { active = false; };
  }, [compareKeys, compareRetry]);

  const groupTitle = group === "all" ? t("playerArchive.allPlayers") : t(`playerArchive.${group}`);
  const comparisonRows = useMemo(() => compareProfiles.map((profile) => {
    const scopedMatches = (profile.matches || []).filter((match) => !mapName || match.map_name === mapName);
    const analysisMatches = (profile.analysis_matches || []).filter((match) =>
      match.available && (!mapName || match.map_name === mapName),
    );
    return {
      profile,
      summary: aggregateMatches(analysisMatches),
      analyzedMatches: analysisMatches.length,
      matchCount: scopedMatches.length,
    };
  }), [compareProfiles, mapName]);

  const toggleComparison = (playerKey) => {
    setCompareKeys((current) => current.includes(playerKey)
      ? current.filter((key) => key !== playerKey)
      : current.length < 2 ? [...current, playerKey] : [current[1], playerKey]);
  };

  const openProfile = (playerKey) => {
    const params = new URLSearchParams();
    if (group !== "all") params.set("group", group);
    if (query) params.set("q", query);
    if (mapName) params.set("map", mapName);
    compareKeys.forEach((key) => params.append("compare", key));
    const encodedParams = params.toString();
    const search = encodedParams ? `?${encodedParams}` : "";
    navigate(`/players/${encodeURIComponent(playerKey)}${search}`);
  };

  return (
    <div className="player-directory">
      <aside className="player-directory__collections">
        <div className="player-directory__collection-heading">
          <div className="player-directory__brand-icon"><Users size={17} /></div>
          <div><strong>{t("playerArchive.title")}</strong><small>LOCAL PLAYER INDEX</small></div>
        </div>
        <nav className="player-directory__collection-list" aria-label={t("playerArchive.groups")}>
          <button type="button" className={group === "all" ? "is-active" : ""} onClick={() => setGroup("all")}>
            <Users size={16} /><span>{t("playerArchive.allPlayers")}</span><small>{formatNumber(directory.group_counts?.all || 0)}</small>
          </button>
          {COLLECTIONS.map((collectionId) => (
            <button key={collectionId} type="button" className={group === collectionId ? "is-active" : ""} onClick={() => setGroup(collectionId)}>
              <Folder size={15} /><span>{t(`playerArchive.${collectionId}`)}</span><small>{formatNumber(directory.group_counts?.[collectionId] || 0)}</small>
            </button>
          ))}
        </nav>
        <div className="player-directory__local-note"><ShieldCheck size={16} /><p>{t("playerArchive.localOnly")}</p></div>
      </aside>

      <main className="player-directory__main">
        <header className="player-directory__header">
          <div>
            <div className="player-directory__eyebrow">PLAYER SCOUTING / LOCAL DEMO INDEX</div>
            <h1>{groupTitle}</h1>
            <p>{t("playerArchive.directoryHint")}</p>
          </div>
          <div className="player-directory__total"><strong>{formatNumber(directory.total || 0)}</strong><span>{t("playerArchive.playerCount", { count: formatNumber(directory.total || 0) })}</span></div>
        </header>

        <div className="player-directory__filters">
          <label className="player-directory__search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("playerArchive.search")} aria-label={t("playerArchive.search")} /></label>
          <label className="player-directory__map-filter"><Map size={16} /><select value={mapName} onChange={(event) => setMapName(event.target.value)} aria-label={t("playerArchive.allMaps")}><option value="">{t("playerArchive.allMaps")}</option>{(directory.maps || []).map((map) => <option key={map} value={map}>{map}</option>)}</select></label>
          <span>{loading ? "…" : t("playerArchive.playerCount", { count: formatNumber(directory.total || 0) })}</span>
        </div>

        {error && <div className="player-directory__error" role="alert">{error}<button type="button" onClick={() => setQuery((value) => `${value}`)}>{t("playerArchive.retry")}</button></div>}

        <section className="player-directory__table" aria-label={groupTitle}>
          <div className="player-directory__table-head"><span>{t("playerArchive.player")}</span><span>{t("playerArchive.maps")}</span><span>{t("playerArchive.matchesPlayed")}</span><span>{t("playerArchive.kd")}</span><span>{t("playerArchive.compare")}</span></div>
          {loading ? <div className="player-directory__empty" role="status">{t("playerArchive.loading")}</div>
            : directory.players?.length ? directory.players.map((player) => (
              <div className="player-directory__row" key={player.player_key}>
                <button type="button" className="player-directory__player" onClick={() => openProfile(player.player_key)}>
                  <span className="player-directory__avatar">{String(player.display_name || "?").trim().slice(0, 1).toUpperCase()}</span>
                  <span className="player-directory__player-copy"><strong>{player.display_name}<ArrowUpRight size={13} /></strong><small>{player.steam_id64 ? `SteamID64 ${player.steam_id64}` : t("playerArchive.localIdentity")}</small></span>
                </button>
                <span className="player-directory__map-count">{formatNumber(player.map_count || 0)} <small>{t("playerArchive.mapsShort")}</small></span>
                <span className="player-directory__demo-count">{formatNumber(player.demo_count || 0)} <small>DEMOS</small></span>
                <span className="player-directory__kd">{Number(player.kd || 0).toFixed(2)}<small>{formatNumber(player.kills || 0)} / {formatNumber(player.deaths || 0)}</small></span>
                <button type="button" className={`player-directory__compare ${compareKeys.includes(player.player_key) ? "is-active" : ""}`} aria-label={compareKeys.includes(player.player_key) ? t("playerArchive.compareRemove", { name: player.display_name }) : t("playerArchive.compareAdd", { name: player.display_name })} aria-pressed={compareKeys.includes(player.player_key)} onClick={() => toggleComparison(player.player_key)}><GitCompareArrows size={15} /></button>
              </div>
            )) : <div className="player-directory__empty"><UserRound size={26} /><strong>{query || mapName ? t("playerArchive.noResults") : t("playerArchive.emptyTitle")}</strong><p>{t("playerArchive.emptyBody")}</p></div>}
        </section>

        {compareKeys.length > 0 && <section className="player-directory__comparison" aria-label={t("playerArchive.comparisonTitle")}>
          <header><div><strong>{t("playerArchive.comparisonTitle")}</strong><small>{t("playerArchive.comparisonScope", { map: mapName || t("playerArchive.allMaps") })}</small></div><button type="button" onClick={() => setCompareKeys([])}>{t("playerArchive.clearComparison")}</button></header>
          {compareLoading ? <div className="player-directory__empty">{t("playerArchive.loadingComparison")}</div>
            : compareError ? <div className="player-directory__error" role="alert">{t("playerArchive.comparisonLoadError")}<button type="button" onClick={() => setCompareRetry((revision) => revision + 1)}>{t("playerArchive.retry")}</button></div>
              : <div className="player-directory__compare-grid">{comparisonRows.map(({ profile, summary, analyzedMatches, matchCount }) => <article key={profile.player_key}>
              <div><span className="player-directory__avatar">{String(profile.display_name || "?").trim().slice(0, 1).toUpperCase()}</span><strong>{profile.display_name}</strong></div>
              <dl>
                <dt>{t("playerArchive.matchesPlayed")}</dt><dd>{t("playerArchive.analysisCoverage", { analyzed: analyzedMatches, total: matchCount })}</dd>
                <dt>{t("playerArchive.rounds")}</dt><dd>{summary.matches ? formatNumber(summary.rounds) : "—"}</dd>
                <dt>K / A / D</dt><dd>{summary.matches ? `${formatNumber(summary.kills)} / ${formatNumber(summary.assists)} / ${formatNumber(summary.deaths)}` : "—"}</dd>
                <dt>{t("playerArchive.kd")}</dt><dd>{summary.matches ? Number(summary.kd).toFixed(2) : "—"}</dd>
                <dt>{t("playerArchive.adr")}</dt><dd>{summary.adr == null ? "—" : `${Number(summary.adr).toFixed(1)} (${formatNumber(summary.damageCoveredRounds)}/${formatNumber(summary.rounds)} ${t("playerArchive.roundsShort")})`}</dd>
                <dt>{t("playerArchive.kast")}</dt><dd>{summary.kast == null ? "—" : `${formatRate(summary.kast)} (${formatNumber(summary.kastRounds)}/${formatNumber(summary.rounds)})`}</dd>
                <dt>{t("playerArchive.hsPercent")}</dt><dd>{summary.hsPercent == null ? "—" : `${formatRate(summary.hsPercent)} (${formatNumber(summary.headshots)}/${formatNumber(summary.kills)})`}</dd>
                <dt>{t("playerArchive.opening")}</dt><dd>{summary.openingDuels ? t("playerArchive.openingRecord", { wins: formatNumber(summary.firstKills), losses: formatNumber(summary.firstDeaths), count: formatNumber(summary.openingDuels) }) : "—"}</dd>
                <dt>{t("playerArchive.clutch")}</dt><dd>{summary.clutchAttempts ? t("playerArchive.clutchRecord", { wins: formatNumber(summary.clutchWins), attempts: formatNumber(summary.clutchAttempts) }) : "—"}</dd>
                <dt>{t("playerArchive.tradeSplit")}</dt><dd>{summary.matches ? `${formatNumber(summary.tradeKills)} / ${formatNumber(summary.tradeDeaths)}` : "—"}</dd>
                <dt>{t("playerArchive.utilityDamagePerRound")}</dt><dd>{summary.matches ? `${Number(summary.utilityDamagePerRound).toFixed(1)} (${formatNumber(summary.utilityDamage)} / ${formatNumber(summary.rounds)} ${t("playerArchive.roundsShort")})` : "—"}</dd>
              </dl>
              <button type="button" onClick={() => openProfile(profile.player_key)}>{t("playerArchive.openProfile")}</button>
            </article>)}</div>}
        </section>}
      </main>
    </div>
  );
}
