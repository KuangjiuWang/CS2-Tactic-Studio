import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  Activity, ArrowLeft, Download, Filter, Map as MapIcon, ShieldCheck, Swords, Target,
  Trophy, Users, Crosshair, Loader2, ChevronRight,
} from "lucide-react";
import API from "../../api/api";
import { useT } from "../../i18n/useT.js";
import { aggregateMatches } from "./playerArchiveStats.js";
import "./playerProfile.css";

export { aggregateMatches };

const COLLECTIONS = ["professional", "amateur", "squad"];
const DemoHeatmapView = lazy(() => import("../demo-analysis/replay/DemoHeatmapView.jsx"));
const Demo2DReplayPreview = lazy(() => import("../demo-analysis/replay/Demo2DReplayPreview.jsx"));

function number(value, decimals = 0) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(Number(value));
}

function dateLabel(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toLocaleDateString();
}

function positionLabel(position) {
  return position && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.y))
    ? `${number(position.x, 0)}, ${number(position.y, 0)}`
    : "—";
}

function mergeBreakdown(matches, key, side = "all") {
  const merged = new Map();
  for (const match of matches) {
    const rows = side === "all"
      ? match.metrics?.[key]
      : match.metrics?.[`side_${key}`]?.[side];
    for (const [label, row] of Object.entries(rows || {})) {
      const target = merged.get(label) || {};
      for (const [field, value] of Object.entries(row || {})) {
        if (Number.isFinite(Number(value))) target[field] = Number(target[field] || 0) + Number(value || 0);
      }
      merged.set(label, target);
    }
  }
  return [...merged.entries()].map(([label, values]) => ({ label, ...values }));
}

function aggregateTacticalMatches(matches, side = "all") {
  const cells = new Map();
  const sites = new Map();
  const totals = {
    availableMatches: 0,
    duelWins: 0,
    duelLosses: 0,
    breakFirstKills: 0,
    holdFirstKills: 0,
    break2k: 0,
    break3k: 0,
    hold2k: 0,
    hold3k: 0,
    siteAreaKills: 0,
  };
  for (const match of matches) {
    const tactical = match.tactical_metrics;
    if (!tactical?.available) continue;
    totals.availableMatches += 1;
    for (const row of tactical.duel_cells || []) {
      if (side !== "all" && row.side !== side) continue;
      const ownArea = String(row.own_area || "未知区域");
      const enemyArea = String(row.enemy_area || "未知区域");
      const key = `${ownArea}\u0000${enemyArea}`;
      const target = cells.get(key) || { ownArea, enemyArea, wins: 0, losses: 0 };
      target.wins += Number(row.wins || 0);
      target.losses += Number(row.losses || 0);
      cells.set(key, target);
    }
    const includeBreak = side === "all" || side === "T";
    const includeHold = side === "all" || side === "CT";
    if (includeBreak) {
      totals.breakFirstKills += Number(tactical.site_break_first_kills || 0);
      totals.break2k += Number(tactical.site_break_2k || 0);
      totals.break3k += Number(tactical.site_break_3k || 0);
    }
    if (includeHold) {
      totals.holdFirstKills += Number(tactical.site_hold_first_kills || 0);
      totals.hold2k += Number(tactical.site_hold_2k || 0);
      totals.hold3k += Number(tactical.site_hold_3k || 0);
    }
    totals.siteAreaKills += Number(tactical.site_area_kills || 0);
    for (const row of tactical.site_breakdown || []) {
      const site = String(row.site || "?");
      const target = sites.get(site) || {
        site, breakFirstKills: 0, holdFirstKills: 0,
        break2k: 0, break3k: 0, hold2k: 0, hold3k: 0,
      };
      if (includeBreak) {
        target.breakFirstKills += Number(row.break_first_kills || 0);
        target.break2k += Number(row.break_2k || 0);
        target.break3k += Number(row.break_3k || 0);
      }
      if (includeHold) {
        target.holdFirstKills += Number(row.hold_first_kills || 0);
        target.hold2k += Number(row.hold_2k || 0);
        target.hold3k += Number(row.hold_3k || 0);
      }
      sites.set(site, target);
    }
  }

  const cellRows = [...cells.values()];
  const areaTotals = (field) => {
    const totalsByArea = new Map();
    cellRows.forEach((row) => {
      const area = row[field];
      totalsByArea.set(area, (totalsByArea.get(area) || 0) + row.wins + row.losses);
    });
    return [...totalsByArea.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8).map(([area]) => area);
  };
  return {
    ...totals,
    duelAttempts: totals.duelWins + totals.duelLosses,
    duelWinRate: totals.duelWins + totals.duelLosses
      ? totals.duelWins / (totals.duelWins + totals.duelLosses) * 100
      : null,
    ownAreas: areaTotals("ownArea"),
    enemyAreas: areaTotals("enemyArea"),
    cells: cellRows,
    sites: [...sites.values()].sort((left, right) => left.site.localeCompare(right.site)),
  };
}

function StatCard({ icon: Icon, label, value, detail, tone = "" }) {
  return <article className={`player-profile__stat ${tone}`}><div><span>{label}</span>{Icon && <Icon size={15} />}</div><strong>{value}</strong>{detail && <small>{detail}</small>}</article>;
}

function TrendChart({ rows, field, title, color, decimals = 2 }) {
  const points = rows.map((row) => ({
    label: dateLabel(row.match_date || row.added_at),
    value: Number(row.metrics?.[field]),
    title: `${row.map_name} · ${row.title}`,
  })).filter((point) => Number.isFinite(point.value));
  if (!points.length) return <section className="player-profile__chart"><header>{title}</header><div className="player-profile__chart-empty">—</div></section>;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.18, 0.08);
  const low = min - pad;
  const high = max + pad;
  const width = 600;
  const height = 156;
  const coords = points.map((point, index) => ({
    x: points.length === 1 ? width / 2 : 18 + index * (width - 36) / (points.length - 1),
    y: 15 + (high - point.value) / Math.max(0.001, high - low) * (height - 42),
    ...point,
  }));
  return <section className="player-profile__chart">
    <header><span>{title}</span><strong style={{ color }}>{number(points.at(-1).value, decimals)}</strong></header>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      {[0, 1, 2].map((line) => <line key={line} x1="12" x2={width - 12} y1={22 + line * 39} y2={22 + line * 39} className="player-profile__chart-grid" />)}
      <polyline points={coords.map(({ x, y }) => `${x},${y}`).join(" ")} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {coords.map((point, index) => <g key={`${point.label}-${index}`}><title>{`${point.title}: ${number(point.value, decimals)}`}</title><circle cx={point.x} cy={point.y} r="4" fill={color} /><circle cx={point.x} cy={point.y} r="8" fill={color} fillOpacity="0.15" /></g>)}
      <text x="14" y={height - 8}>{coords[0].label}</text><text x={width - 14} y={height - 8} textAnchor="end">{coords.at(-1).label}</text>
    </svg>
  </section>;
}

function RateText({ value, digits = 1 }) {
  return value == null ? "—" : `${number(value, digits)}%`;
}

export default function PlayerProfilePage() {
  const t = useT();
  const { playerKey = "" } = useParams();
  const [searchParams] = useSearchParams();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingGroups, setSavingGroups] = useState(false);
  const [mapName, setMapName] = useState(searchParams.get("map") || "");
  const [side, setSide] = useState("all");
  const [matchLimit, setMatchLimit] = useState("all");
  const [activeTab, setActiveTab] = useState("overview");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [analysisDemoId, setAnalysisDemoId] = useState("");
  const [spatialMode, setSpatialMode] = useState("replay");
  const [spatialData, setSpatialData] = useState(null);
  const [spatialLoading, setSpatialLoading] = useState(false);
  const [spatialError, setSpatialError] = useState("");
  const [replayTarget, setReplayTarget] = useState(null);
  const [replaySeekRequestId, setReplaySeekRequestId] = useState(0);
  const [evidenceFilter, setEvidenceFilter] = useState("all");

  useEffect(() => {
    let active = true;
    setLoading(true);
    API.get(`/player-archive/players/${encodeURIComponent(playerKey)}`)
      .then(({ data }) => { if (active) { setProfile(data); setError(""); } })
      .catch((cause) => { if (active) setError(String(cause?.response?.data?.detail || cause?.message || cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [playerKey]);

  const allMatches = useMemo(() => [...(profile?.matches || [])].sort((left, right) =>
    String(right.match_date || "").localeCompare(String(left.match_date || "")) || Number(right.demo_id) - Number(left.demo_id),
  ), [profile?.matches]);
  const scopedMatches = useMemo(() => {
    const filtered = allMatches.filter((match) => !mapName || match.map_name === mapName);
    return matchLimit === "all" ? filtered : filtered.slice(0, Number(matchLimit));
  }, [allMatches, mapName, matchLimit]);
  const scopedIds = useMemo(() => new Set(scopedMatches.map((match) => String(match.demo_id))), [scopedMatches]);
  const analysisMatches = useMemo(() => [...(profile?.analysis_matches || [])]
    .filter((match) => scopedIds.has(String(match.demo_id)) && match.available && match.metrics)
    .sort((left, right) => String(left.match_date || "").localeCompare(String(right.match_date || "")) || Number(left.demo_id) - Number(right.demo_id)),
  [profile?.analysis_matches, scopedIds]);
  const metrics = useMemo(() => aggregateMatches(analysisMatches, side), [analysisMatches, side]);
  const trendMatches = useMemo(() => analysisMatches.map((match) => {
    const filtered = aggregateMatches([match], side);
    return { ...match, metrics: { ...match.metrics, rating_approx: filtered.ratingApprox, adr: filtered.adr } };
  }), [analysisMatches, side]);
  const selectedAnalysisMatches = useMemo(() => analysisMatches.filter((match) => match.available), [analysisMatches]);
  const selectedMatch = selectedAnalysisMatches.find((match) => String(match.demo_id) === analysisDemoId)
    || selectedAnalysisMatches.at(-1)
    || null;
  const spatialMatchesSelection = Boolean(spatialData && selectedMatch
    && String(spatialData.demo_id) === String(selectedMatch.demo_id)
    && String(spatialData.player_key || spatialData.selected_player_key || "") === String(profile?.player_key || ""));

  useEffect(() => {
    if (selectedAnalysisMatches.length && !selectedAnalysisMatches.some((match) => String(match.demo_id) === analysisDemoId)) {
      setAnalysisDemoId(String(selectedAnalysisMatches.at(-1).demo_id));
    } else if (!selectedAnalysisMatches.length && analysisDemoId) setAnalysisDemoId("");
  }, [analysisDemoId, selectedAnalysisMatches]);

  useEffect(() => {
    setReplayTarget(null);
  }, [playerKey, selectedMatch?.demo_id]);

  useEffect(() => {
    let active = true;
    if (activeTab !== "spatial" || !selectedMatch) return () => { active = false; };
    setSpatialLoading(true);
    setSpatialError("");
    API.get(`/player-archive/matches/${selectedMatch.demo_id}/analysis`, { params: { player_key: profile?.player_key } })
      .then(({ data }) => { if (active) setSpatialData(data); })
      .catch((cause) => { if (active) { setSpatialData(null); setSpatialError(String(cause?.response?.data?.detail || cause?.message || cause)); } })
      .finally(() => { if (active) setSpatialLoading(false); });
    return () => { active = false; };
  }, [activeTab, profile?.player_key, selectedMatch?.demo_id]);

  const toggleCollection = async (collectionId) => {
    if (!profile || savingGroups) return;
    const next = new Set(profile.groups || []);
    next.has(collectionId) ? next.delete(collectionId) : next.add(collectionId);
    setSavingGroups(true);
    setNotice("");
    try {
      const { data } = await API.put("/player-archive/membership", { player_key: profile.player_key, group_ids: [...next] });
      setProfile((current) => current ? { ...current, groups: data.groups || [] } : current);
      setNotice(t("playerArchive.groupsSaved"));
    } catch (cause) {
      setNotice(t("playerArchive.groupsError"));
      setError(String(cause?.response?.data?.detail || cause?.message || cause));
    } finally { setSavingGroups(false); }
  };

  const exportProfile = () => {
    if (!profile) return;
    const safeName = String(profile.display_name || "player").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 60) || "player";
    const payload = {
      format: "cs2-player-archive", version: 3, exported_at: new Date().toISOString(),
      player: { player_key: profile.player_key, display_name: profile.display_name, steam_id64: profile.steam_id64 || null, aliases: profile.aliases || [], groups: profile.groups || [] },
      filters: { map_name: mapName || null, side, match_limit: matchLimit },
      summary: { ...metrics, tactical },
      matches: scopedMatches.map((match) => {
        const analysis = profile.analysis_matches?.find((row) => String(row.demo_id) === String(match.demo_id));
        const source = analysis?.metrics || null;
        const aggregate = source ? aggregateMatches([{ ...analysis, available: true }], side) : null;
        const stats = aggregate?.matches ? aggregate : null;
        const tacticalStats = analysis?.tactical_metrics
          ? aggregateTacticalMatches([{ ...analysis, tactical_metrics: analysis.tactical_metrics }], side)
          : null;
        return {
          demo_id: match.demo_id,
          map_name: match.map_name,
          match_date: match.match_date || null,
          total_rounds: stats?.rounds ?? match.total_rounds,
          result: source?.match_result || null,
          team_score: source?.team_score ?? null,
          opponent_score: source?.opponent_score ?? null,
          stats: stats ? {
            kills: stats.kills, deaths: stats.deaths, assists: stats.assists,
            headshots: stats.headshots, kd: stats.kd, adr: stats.adr, kast: stats.kast,
            first_kills: stats.firstKills, first_deaths: stats.firstDeaths,
            trade_kills: stats.tradeKills, trade_deaths: stats.tradeDeaths,
            clutch_attempts: stats.clutchAttempts, clutch_wins: stats.clutchWins,
            utility_damage: stats.utilityDamage, utility_damage_per_round: stats.utilityDamagePerRound,
            rating_approx: stats.ratingApprox,
          } : null,
          tactical_stats: tacticalStats,
        };
      }),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeName}-scouting.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const jumpToEvidence = (row) => {
    setSpatialMode("replay");
    setReplayTarget({ roundNumber: row.round_number, tick: row.tick ?? row.throw_tick ?? null });
    setReplaySeekRequestId((current) => current + 1);
  };
  const evidence = spatialData?.evidence || {};
  const evidenceRows = [
    ...(evidence.eliminations || []).map((row) => ({ ...row, evidence_type: row.type })),
    ...(evidence.clutches || []).map((row) => ({ ...row, evidence_type: "clutch" })),
    ...(evidence.utilities || []).map((row) => ({ ...row, evidence_type: "utility" })),
  ].filter((row) => (side === "all" || row.side === side)
    && (evidenceFilter === "all" || (evidenceFilter === "opening"
      ? ["kill", "death"].includes(row.evidence_type) && row.is_opening
      : row.evidence_type === evidenceFilter))).sort((left, right) => Number(right.round_number || 0) - Number(left.round_number || 0)
      || Number(right.tick || right.throw_tick || 0) - Number(left.tick || left.throw_tick || 0));
  const opponentRows = (evidence.opponents || []).map((opponent) => {
    const scoped = side === "all" ? opponent : opponent.sides?.[side];
    return scoped ? { ...scoped, opponent: opponent.opponent } : null;
  }).filter(Boolean).sort((left, right) =>
    Number(right.kills || 0) + Number(right.deaths || 0) - Number(left.kills || 0) - Number(left.deaths || 0),
  );

  const mapRows = useMemo(() => {
    const groups = new Map();
    for (const match of analysisMatches) {
      const row = groups.get(match.map_name) || [];
      row.push(match);
      groups.set(match.map_name, row);
    }
    return [...groups.entries()].map(([name, rows]) => ({ name, stats: aggregateMatches(rows, side) }))
      .sort((left, right) => right.stats.rounds - left.stats.rounds);
  }, [analysisMatches, side]);
  const sideRows = useMemo(() => ["T", "CT"].map((name) => ({ name, stats: aggregateMatches(analysisMatches, name) })), [analysisMatches]);
  const weaponRows = useMemo(() => mergeBreakdown(analysisMatches, "weapon_breakdown", side).sort((left, right) => right.kills - left.kills), [analysisMatches, side]);
  const economyRows = useMemo(() => mergeBreakdown(analysisMatches, "economy_breakdown", side).sort((left, right) => right.rounds - left.rounds), [analysisMatches, side]);
  const utilityRows = useMemo(() => mergeBreakdown(analysisMatches, "utility_breakdown", side).sort((left, right) => right.throws - left.throws), [analysisMatches, side]);
  const clutchRows = useMemo(() => mergeBreakdown(analysisMatches, "clutch_breakdown", side).sort((left, right) => Number(left.label.slice(2)) - Number(right.label.slice(2))), [analysisMatches, side]);
  const tactical = useMemo(() => (
    mapName ? aggregateTacticalMatches(analysisMatches, side) : aggregateTacticalMatches([], side)
  ), [analysisMatches, mapName, side]);
  const tacticalCellMap = useMemo(() => new Map(
    tactical.cells.map((row) => [`${row.ownArea}\u0000${row.enemyArea}`, row]),
  ), [tactical.cells]);

  const tabs = [
    ["overview", t("playerArchive.overview"), Activity],
    ["maps", t("playerArchive.mapSideAnalysis"), MapIcon],
    ["weapons", t("playerArchive.weaponsEconomy"), Swords],
    ["tactics", t("playerArchive.tacticalAnalysis"), Crosshair],
    ["matches", t("playerArchive.matches"), Trophy],
    ["spatial", t("playerArchive.spatialAnalysis"), Crosshair],
  ];

  if (loading) return <div className="player-profile__loading" role="status"><Loader2 className="animate-spin" size={24} />{t("playerArchive.loading")}</div>;
  if (error && !profile) return <div className="player-profile__load-error" role="alert"><p>{error}</p><Link to="/players">{t("playerArchive.backToPlayers")}</Link></div>;
  if (!profile) return null;

  const directoryParams = new URLSearchParams();
  const directoryGroup = searchParams.get("group");
  const directoryQuery = searchParams.get("q");
  if (directoryGroup) directoryParams.set("group", directoryGroup);
  if (directoryQuery) directoryParams.set("q", directoryQuery);
  if (mapName) directoryParams.set("map", mapName);
  searchParams.getAll("compare").slice(0, 2).forEach((key) => directoryParams.append("compare", key));
  const backToDirectory = directoryParams.toString() ? `/players?${directoryParams.toString()}` : "/players";

  return (
    <div className="player-profile">
      <header className="player-profile__topbar">
        <Link to={backToDirectory} className="player-profile__back"><ArrowLeft size={15} />{t("playerArchive.backToPlayers")}</Link>
        <div className="player-profile__breadcrumbs"><span>{t("playerArchive.title")}</span><ChevronRight size={13} /><strong>{profile.display_name}</strong></div>
        <button type="button" className="player-profile__export" onClick={exportProfile}><Download size={14} />{t("playerArchive.exportLocal")}</button>
      </header>

      <section className="player-profile__identity">
        <div className="player-profile__identity-main">
          <div className="player-profile__avatar">{String(profile.display_name || "?").trim().slice(0, 1).toUpperCase()}</div>
          <div><div className="player-profile__eyebrow">PLAYER SCOUTING PROFILE</div><h1>{profile.display_name}</h1><p>{profile.steam_id64 ? `SteamID64 ${profile.steam_id64}` : t("playerArchive.noSteamId")}</p></div>
        </div>
        <div className="player-profile__identity-meta">
          <span className={`player-profile__identity-badge identity-${profile.identity_quality}`}><ShieldCheck size={13} />{profile.identity_quality === "steamid64" ? t("playerArchive.steamid64") : profile.identity_quality === "account_id" ? t("playerArchive.accountId") : t("playerArchive.localIdentity")}</span>
          <small>{t("playerArchive.profileCoverage", { analyzed: metrics.matches, total: scopedMatches.length, rounds: number(metrics.rounds) })}</small>
        </div>
        <div className="player-profile__groups">
          {COLLECTIONS.map((collectionId) => <label key={collectionId} className={(profile.groups || []).includes(collectionId) ? "is-active" : ""}>
            <input type="checkbox" checked={(profile.groups || []).includes(collectionId)} disabled={savingGroups} onChange={() => void toggleCollection(collectionId)} />
            {t(`playerArchive.${collectionId}`)}
          </label>)}
          <small>{savingGroups ? "…" : notice}</small>
        </div>
        {!!profile.aliases?.length && <div className="player-profile__aliases"><span>{t("playerArchive.aliases")}</span>{profile.aliases.slice(0, 8).map((alias) => <span key={alias}>{alias}</span>)}</div>}
      </section>

      <div className="player-profile__filters">
        <label><MapIcon size={14} /><select value={mapName} onChange={(event) => setMapName(event.target.value)} aria-label={t("playerArchive.filterMap")}><option value="">{t("playerArchive.allMaps")}</option>{(profile.maps || []).map((item) => <option key={item.map_name} value={item.map_name}>{item.map_name}</option>)}</select></label>
        <label><Filter size={14} /><select value={side} onChange={(event) => setSide(event.target.value)} aria-label={t("playerArchive.filterSide")}><option value="all">{t("playerArchive.allSides")}</option><option value="T">T</option><option value="CT">CT</option></select></label>
        <label><Activity size={14} /><select value={matchLimit} onChange={(event) => setMatchLimit(event.target.value)} aria-label={t("playerArchive.timeRange")}><option value="all">{t("playerArchive.allMatches")}</option><option value="10">{t("playerArchive.last10Matches")}</option><option value="25">{t("playerArchive.last25Matches")}</option><option value="50">{t("playerArchive.last50Matches")}</option></select></label>
        <span>{t("playerArchive.analysisCoverage", { analyzed: metrics.matches, total: scopedMatches.length })}</span>
      </div>

      {error && <div className="player-profile__error" role="alert">{error}</div>}
      <nav className="player-profile__tabs" role="tablist" aria-label={t("playerArchive.profileSections")}>
        {tabs.map(([id, label, Icon]) => <button type="button" key={id} role="tab" aria-selected={activeTab === id} className={activeTab === id ? "is-active" : ""} onClick={() => setActiveTab(id)}><Icon size={14} />{label}</button>)}
      </nav>

      <main className="player-profile__body">
        {activeTab === "overview" && <>
          <section className="player-profile__stat-grid" aria-label={t("playerArchive.advancedMetrics")}>
            <StatCard icon={Activity} label={t("playerArchive.ratingApprox")} value={number(metrics.ratingApprox, 2)} detail={t("playerArchive.ratingApproxNote")} tone="is-accent" />
            <StatCard icon={Swords} label={t("playerArchive.kd")} value={number(metrics.kd, 2)} detail={`${number(metrics.kills)} / ${number(metrics.deaths)} ${t("playerArchive.killsDeaths")}`} />
            <StatCard icon={Target} label={t("playerArchive.adr")} value={number(metrics.adr, 1)} detail={t("playerArchive.perRound", { rounds: number(metrics.rounds) })} />
            <StatCard icon={ShieldCheck} label={t("playerArchive.kast")} value={<RateText value={metrics.kast} />} detail={`${number(metrics.kastRounds)} / ${number(metrics.rounds)} ${t("playerArchive.roundsShort")}`} />
            <StatCard label={t("playerArchive.kpr")} value={number(metrics.kpr, 2)} detail={t("playerArchive.killsPerRound")} />
            <StatCard label={t("playerArchive.dpr")} value={number(metrics.dpr, 2)} detail={t("playerArchive.deathsPerRound")} />
            <StatCard label={t("playerArchive.hsPercent")} value={<RateText value={metrics.hsPercent} />} detail={`${number(metrics.headshots)} / ${number(metrics.kills)} ${t("playerArchive.killsShort")}`} />
            <StatCard label={t("playerArchive.survivalRate")} value={<RateText value={metrics.survival} />} detail={`${number(metrics.survivedRounds)} / ${number(metrics.rounds)} ${t("playerArchive.roundsShort")}`} />
            <StatCard label={t("playerArchive.openingRate")} value={<RateText value={metrics.openingRate} />} detail={`${number(metrics.firstKills)} / ${number(metrics.openingDuels)} ${t("playerArchive.duels")}`} />
            <StatCard label={t("playerArchive.clutchRate")} value={<RateText value={metrics.clutchRate} />} detail={`${number(metrics.clutchWins)} / ${number(metrics.clutchAttempts)} ${t("playerArchive.attempts")}`} />
            <StatCard label={t("playerArchive.roundWinRate")} value={<RateText value={metrics.roundWinRate} />} detail={`${number(metrics.wins)} / ${number(metrics.rounds)} ${t("playerArchive.roundsShort")}`} />
            <StatCard label={t("playerArchive.multiKillRounds")} value={number(metrics.multiKillRounds)} detail={t("playerArchive.multiKillNote", { two: number(metrics.twoKillRounds), three: number(metrics.threeKillRounds), four: number(metrics.fourKillRounds), five: number(metrics.fiveKillRounds) })} />
            <StatCard label={t("playerArchive.assists")} value={number(metrics.assists)} detail={`${number(metrics.kills)} / ${number(metrics.assists)} / ${number(metrics.deaths)} K / A / D`} />
            <StatCard label={t("playerArchive.tradeKills")} value={number(metrics.tradeKills)} detail={t("playerArchive.tradeDeaths", { count: number(metrics.tradeDeaths) })} />
            <StatCard label={t("playerArchive.utilityDamagePerRound")} value={number(metrics.utilityDamagePerRound, 1)} detail={t("playerArchive.utilityDamageTotal", { damage: number(metrics.utilityDamage) })} />
            <StatCard label={t("playerArchive.awpKills")} value={number(metrics.awpKills)} detail={t("playerArchive.killsShort")} />
          </section>

          <div className="player-profile__charts">
            <TrendChart rows={trendMatches} field="rating_approx" title={t("playerArchive.ratingTrend")} color="#f47c38" />
            <TrendChart rows={trendMatches} field="adr" title={t("playerArchive.adrTrend")} color="#70a9ff" decimals={1} />
          </div>

          <div className="player-profile__overview-grid">
            <section className="player-profile__panel"><header><strong>{t("playerArchive.mapPerformance")}</strong><button type="button" onClick={() => setActiveTab("maps")}>{t("playerArchive.viewAll")}</button></header>
              {mapRows.length ? <div className="player-profile__map-cards">{mapRows.slice(0, 6).map(({ name, stats }) => <article key={name}><strong>{name}</strong><span>{number(stats.kd, 2)} K/D</span><small>{number(stats.rounds)} {t("playerArchive.roundsShort")} · ADR {number(stats.adr, 1)}</small><div><i style={{ width: `${Math.max(0, Math.min(100, stats.roundWinRate || 0))}%` }} /></div></article>)}</div> : <div className="player-profile__empty">{t("playerArchive.noAnalyzedMatches")}</div>}
            </section>
            <section className="player-profile__panel"><header><strong>{t("playerArchive.recentMatches")}</strong><button type="button" onClick={() => setActiveTab("matches")}>{t("playerArchive.viewAll")}</button></header>
              <div className="player-profile__recent-list">{scopedMatches.slice(0, 5).map((match) => {
                const row = profile.analysis_matches?.find((item) => String(item.demo_id) === String(match.demo_id));
                const stats = row?.metrics ? aggregateMatches([{ ...row, available: true }], side) : null;
                return <article key={match.demo_id}><span className={`player-profile__result result-${row?.metrics?.match_result || "unknown"}`}>{row?.metrics?.match_result || "·"}</span><div><strong>{match.map_name} · {match.title}</strong><small>{dateLabel(match.match_date)} · {number(stats?.kills)}/{number(stats?.deaths)}/{number(stats?.assists)}</small></div><span>{stats?.ratingApprox == null ? "—" : number(stats.ratingApprox, 2)}</span></article>;
              })}{!scopedMatches.length && <div className="player-profile__empty">{t("playerArchive.noResults")}</div>}</div>
            </section>
          </div>
          <p className="player-profile__method-note"><ShieldCheck size={14} />{t("playerArchive.metricMethod")}</p>
        </>}

        {activeTab === "maps" && <div className="player-profile__analysis-grid">
          <section className="player-profile__panel"><header><strong>{t("playerArchive.mapPerformance")}</strong><small>{mapRows.length} {t("playerArchive.mapsShort")}</small></header>
            <div className="player-profile__table-scroll"><table><thead><tr><th>{t("playerArchive.map")}</th><th>{t("playerArchive.matchesPlayed")}</th><th>{t("playerArchive.rounds")}</th><th>K / A / D</th><th>ADR</th><th>KAST</th><th>{t("playerArchive.openingSplit")}</th><th>{t("playerArchive.clutch")}</th><th>{t("playerArchive.roundWinRate")}</th></tr></thead><tbody>{mapRows.map(({ name, stats }) => <tr key={name}><td>{name}</td><td>{stats.matches}</td><td>{number(stats.rounds)}</td><td>{number(stats.kills)} / {number(stats.assists)} / {number(stats.deaths)}</td><td>{number(stats.adr, 1)}</td><td><RateText value={stats.kast} /></td><td>{number(stats.firstKills)} / {number(stats.firstDeaths)}</td><td>{number(stats.clutchWins)} / {number(stats.clutchAttempts)}</td><td><RateText value={stats.roundWinRate} /></td></tr>)}</tbody></table></div>
          </section>
          <section className="player-profile__panel"><header><strong>{t("playerArchive.sidePerformance")}</strong><small>{t("playerArchive.roundsShort")}</small></header>
            <div className="player-profile__table-scroll"><table><thead><tr><th>{t("playerArchive.side")}</th><th>{t("playerArchive.rounds")}</th><th>K / A / D</th><th>K/D</th><th>ADR</th><th>KAST</th><th>{t("playerArchive.openingSplit")}</th><th>{t("playerArchive.clutch")}</th><th>{t("playerArchive.roundWinRate")}</th></tr></thead><tbody>{sideRows.map(({ name, stats }) => <tr key={name}><td>{name}</td><td>{number(stats.rounds)}</td><td>{number(stats.kills)} / {number(stats.assists)} / {number(stats.deaths)}</td><td>{number(stats.kd, 2)}</td><td>{number(stats.adr, 1)}</td><td><RateText value={stats.kast} /></td><td>{number(stats.firstKills)} / {number(stats.firstDeaths)}</td><td>{number(stats.clutchWins)} / {number(stats.clutchAttempts)}</td><td><RateText value={stats.roundWinRate} /></td></tr>)}</tbody></table></div>
          </section>
          <section className="player-profile__panel"><header><strong>{t("playerArchive.clutchBreakdown")}</strong><small>{number(metrics.clutchAttempts)} {t("playerArchive.attempts")}</small></header>
            <div className="player-profile__table-scroll"><table><thead><tr><th>{t("playerArchive.situation")}</th><th>{t("playerArchive.attempts")}</th><th>{t("playerArchive.clutchWins")}</th><th>{t("playerArchive.clutchRate")}</th></tr></thead><tbody>{clutchRows.map((row) => <tr key={row.label}><td>{row.label}</td><td>{number(row.attempts)}</td><td>{number(row.wins)}</td><td><RateText value={row.attempts ? row.wins / row.attempts * 100 : null} /></td></tr>)}</tbody></table></div>
          </section>
        </div>}

        {activeTab === "weapons" && <div className="player-profile__analysis-grid">
          <section className="player-profile__panel player-profile__panel--wide"><header><strong>{t("playerArchive.weaponPerformance")}</strong><small>{t("playerArchive.weaponDataNote")}</small></header>
            <div className="player-profile__table-scroll"><table><thead><tr><th>{t("playerArchive.weapon")}</th><th>{t("playerArchive.kills")}</th><th>{t("playerArchive.hsPercent")}</th><th>{t("playerArchive.damage")}</th><th>{t("playerArchive.shotsFired")}</th></tr></thead><tbody>{weaponRows.map((row) => <tr key={row.label}><td className="player-profile__weapon-name">{row.label.replaceAll("_", " ")}</td><td>{number(row.kills)}</td><td><RateText value={row.kills ? row.headshots / row.kills * 100 : null} /></td><td>{number(row.damage)}</td><td>{number(row.shots_fired)}</td></tr>)}{!weaponRows.length && <tr><td colSpan="5">{t("playerArchive.noAnalyzedMatches")}</td></tr>}</tbody></table></div>
          </section>
          <section className="player-profile__panel"><header><strong>{t("playerArchive.economyPerformance")}</strong><small>{t(profile.analysis_summary?.economy_sources?.length === 1 && profile.analysis_summary.economy_sources[0] === "player_loadout" ? "playerArchive.individualBuySource" : "playerArchive.teamBuySource")}</small></header>
            <div className="player-profile__table-scroll"><table><thead><tr><th>{t("playerArchive.buyType")}</th><th>{t("playerArchive.rounds")}</th><th>{t("playerArchive.roundWinRate")}</th><th>K/D</th><th>ADR</th></tr></thead><tbody>{economyRows.map((row) => <tr key={row.label}><td>{t(`playerArchive.buy.${row.label}`)}</td><td>{number(row.rounds)}</td><td><RateText value={row.rounds ? row.wins / row.rounds * 100 : null} /></td><td>{row.deaths ? number(row.kills / row.deaths, 2) : number(row.kills, 2)}</td><td>{row.damage_samples >= row.rounds * 0.9 ? number(row.damage / row.rounds, 1) : "—"}</td></tr>)}</tbody></table></div>
          </section>
          <section className="player-profile__panel"><header><strong>{t("playerArchive.utilityUsage")}</strong><small>{number(metrics.utilityDamage)} {t("playerArchive.damage")}</small></header>
            <div className="player-profile__utility-list">{utilityRows.map((row) => <div key={row.label}><span>{row.label}</span><strong>{number(row.throws)}</strong><small>{t("playerArchive.throws")}</small></div>)}{!utilityRows.length && <div className="player-profile__empty">{t("playerArchive.noAnalyzedMatches")}</div>}</div>
          </section>
        </div>}

        {activeTab === "tactics" && <div className="player-profile__analysis-grid">
          <section className="player-profile__panel player-profile__panel--wide"><header><strong>{t("playerArchive.duelMatrix")}</strong><small>{mapName ? t("playerArchive.tacticalMapScope", { map: mapName }) : t("playerArchive.tacticalSelectMap")}</small></header>
            <p className="player-profile__method-note">{t("playerArchive.duelMatrixNote", { matches: number(tactical.availableMatches) })}</p>
            {!mapName ? <div className="player-profile__empty">{t("playerArchive.tacticalSelectMap")}</div>
              : !tactical.availableMatches ? <div className="player-profile__empty">{t("playerArchive.tacticalNeedsReanalysis")}</div>
              : tactical.duelAttempts ? <div className="player-profile__table-scroll player-profile__tactical-matrix-scroll"><table className="player-profile__tactical-matrix"><thead><tr><th>{t("playerArchive.enemyPosition")}↓ / {t("playerArchive.ownPosition")}→</th>{tactical.ownAreas.map((area) => <th key={area}>{area}</th>)}</tr></thead><tbody>{tactical.enemyAreas.map((enemyArea) => <tr key={enemyArea}><th>{enemyArea}</th>{tactical.ownAreas.map((ownArea) => {
                const row = tacticalCellMap.get(`${ownArea}\u0000${enemyArea}`);
                const attempts = Number(row?.wins || 0) + Number(row?.losses || 0);
                const rate = attempts ? Number(row.wins) / attempts * 100 : null;
                return <td key={ownArea} className={attempts ? "has-sample" : ""} style={rate == null ? undefined : { "--duel-rate": `${Math.round(rate)}%` }} title={attempts ? `${number(row.wins)} W / ${number(row.losses)} L` : ""}>
                  {attempts ? <><strong>{number(rate)}%</strong><small>{number(row.wins)} / {number(row.losses)}</small></> : "—"}
                </td>;
              })}</tr>)}</tbody></table></div>
              : <div className="player-profile__empty">{t("playerArchive.noDuelSamples")}</div>}
          </section>

          <div className="player-profile__stat-grid player-profile__tactical-stats">
            <StatCard icon={Swords} label={t("playerArchive.duelWinRate")} value={<RateText value={tactical.duelWinRate} />} detail={t("playerArchive.duelRecord", { wins: number(tactical.duelWins), losses: number(tactical.duelLosses), attempts: number(tactical.duelAttempts) })} tone="is-accent" />
            <StatCard icon={Target} label={t("playerArchive.breakSiteFirstKills")} value={number(tactical.breakFirstKills)} detail={t("playerArchive.breakSiteMultiKills", { two: number(tactical.break2k), three: number(tactical.break3k) })} />
            <StatCard icon={ShieldCheck} label={t("playerArchive.holdSiteFirstKills")} value={number(tactical.holdFirstKills)} detail={t("playerArchive.holdSiteMultiKills", { two: number(tactical.hold2k), three: number(tactical.hold3k) })} />
            <StatCard icon={MapIcon} label={t("playerArchive.recognizedSiteKills")} value={number(tactical.siteAreaKills)} detail={t("playerArchive.siteAreaKillNote")} />
          </div>

          <section className="player-profile__panel player-profile__panel--wide"><header><strong>{t("playerArchive.siteEntryBreakdown")}</strong><small>{t("playerArchive.siteEntryScope")}</small></header>
            <div className="player-profile__table-scroll"><table><thead><tr><th>{t("playerArchive.site")}</th><th>{t("playerArchive.breakSiteFirstKills")}</th><th>{t("playerArchive.siteMultiKillHeader")}</th><th>{t("playerArchive.holdSiteFirstKills")}</th><th>{t("playerArchive.siteMultiKillHeader")}</th></tr></thead><tbody>{tactical.sites.map((row) => <tr key={row.site}><td>{row.site}</td><td>{number(row.breakFirstKills)}</td><td>{number(row.break2k)} / {number(row.break3k)}</td><td>{number(row.holdFirstKills)}</td><td>{number(row.hold2k)} / {number(row.hold3k)}</td></tr>)}{!tactical.sites.length && <tr><td colSpan="5">{t(mapName ? "playerArchive.noSiteSamples" : "playerArchive.tacticalSelectMap")}</td></tr>}</tbody></table></div>
          </section>
        </div>}

        {activeTab === "matches" && <section className="player-profile__panel player-profile__panel--wide"><header><strong>{t("playerArchive.matches")}</strong><small>{scopedMatches.length} · {t("playerArchive.analysisCoverage", { analyzed: metrics.matches, total: scopedMatches.length })}</small></header>
          <div className="player-profile__table-scroll"><table><thead><tr><th>{t("playerArchive.match")}</th><th>{t("playerArchive.map")}</th><th>{t("playerArchive.date")}</th><th>{t("playerArchive.result")}</th><th>{t("playerArchive.rounds")}</th><th>K / D / A</th><th>{t("playerArchive.ratingApprox")}</th><th>ADR</th><th>KAST</th><th>{t("playerArchive.openingRate")}</th><th>{t("playerArchive.clutch")}</th></tr></thead><tbody>{scopedMatches.map((match) => {
            const analysis = profile.analysis_matches?.find((row) => String(row.demo_id) === String(match.demo_id));
            const stats = analysis?.metrics ? aggregateMatches([{ ...analysis, available: true }], side) : null;
            return <tr key={match.demo_id}><td title={match.filename}>{match.title}</td><td>{match.map_name}</td><td>{dateLabel(match.match_date)}</td><td><span className={`player-profile__result result-${analysis?.metrics?.match_result || "unknown"}`}>{analysis?.metrics?.match_result || "—"}</span>{analysis?.metrics?.team_score != null ? ` ${analysis.metrics.team_score}:${analysis.metrics.opponent_score}` : ""}</td><td>{number(stats?.rounds ?? match.total_rounds)}</td><td>{number(stats?.kills)} / {number(stats?.deaths)} / {number(stats?.assists)}</td><td>{number(stats?.ratingApprox, 2)}</td><td>{number(stats?.adr, 1)}</td><td><RateText value={stats?.kast} /></td><td>{stats?.openingRate == null ? "—" : `${number(stats.openingRate)}% (${number(stats.firstKills)}/${number(stats.openingDuels)})`}</td><td>{stats?.clutchAttempts ? `${number(stats.clutchWins)}/${number(stats.clutchAttempts)}` : "—"}</td></tr>;
          })}{!scopedMatches.length && <tr><td colSpan="11">{t("playerArchive.noResults")}</td></tr>}</tbody></table></div>
        </section>}

        {activeTab === "spatial" && <section className="player-profile__spatial-panel">
          <div className="player-profile__panel player-profile__spatial-controls">
            <header><div><strong>{t("playerArchive.spatialAnalysis")}</strong><small>{t("playerArchive.spatialSubtitle")}</small></div></header>
            <label><span>{t("playerArchive.sourceMatch")}</span><select value={selectedMatch ? String(selectedMatch.demo_id) : ""} onChange={(event) => setAnalysisDemoId(event.target.value)}>{selectedAnalysisMatches.map((match) => <option key={match.demo_id} value={String(match.demo_id)}>{match.map_name} · {match.title}</option>)}</select></label>
            <div className="player-profile__spatial-tabs"><button type="button" className={spatialMode === "replay" ? "is-active" : ""} onClick={() => setSpatialMode("replay")}>{t("playerArchive.roundReplay")}</button><button type="button" className={spatialMode === "heatmap" ? "is-active" : ""} onClick={() => setSpatialMode("heatmap")}>{t("playerArchive.playerHeatmap")}</button></div>
            <p>{t("playerArchive.spatialProvenance")}</p>
          </div>
          {!selectedMatch && <div className="player-profile__empty">{t("playerArchive.spatialUnavailable")}</div>}
          {spatialLoading && <div className="player-profile__empty" role="status"><Loader2 size={18} className="animate-spin" />{t("playerArchive.loadingSpatial")}</div>}
          {spatialError && <div className="player-profile__error" role="alert">{spatialError}</div>}
          {spatialMatchesSelection && spatialData?.available && <>
            <div className="player-profile__spatial-summary"><div><span>{t("playerArchive.recordedKills")}</span><strong>{number(evidence.eliminations?.filter((row) => row.type === "kill" && (side === "all" || row.side === side)).length || 0)}</strong></div><div><span>{t("playerArchive.recordedDeaths")}</span><strong>{number(evidence.eliminations?.filter((row) => row.type === "death" && (side === "all" || row.side === side)).length || 0)}</strong></div><div><span>{t("playerArchive.clutchSamples")}</span><strong>{number(evidence.clutches?.filter((row) => side === "all" || row.side === side).length || 0)}</strong></div><div><span>{t("playerArchive.opponentsSeen")}</span><strong>{number(opponentRows.length)}</strong></div></div>
            <div className="player-profile__spatial-grid">
              <section className="player-profile__panel"><header><strong>{t("playerArchive.engagementEvidence")}</strong><small>{t("playerArchive.observedOnly")}</small></header>
                <p className="player-profile__method-note">{t("playerArchive.duelEvidenceNote")}</p>
                <h3 className="player-profile__subheading">{t("playerArchive.opponentSummary")}</h3>
                <div className="player-profile__table-scroll player-profile__opponent-table"><table><thead><tr><th>{t("playerArchive.opponentsSeen")}</th><th>K / D</th><th>{t("playerArchive.openingSplit")}</th><th>{t("playerArchive.distanceAverage")}</th><th>{t("playerArchive.distanceSamples")}</th></tr></thead><tbody>{opponentRows.map((row) => <tr key={row.opponent}><td>{row.opponent}</td><td>{number(row.kills)} / {number(row.deaths)}</td><td>{number(row.opening_kills)} / {number(row.opening_deaths)}</td><td>{row.average_elimination_distance == null ? "—" : number(row.average_elimination_distance, 1)}</td><td>{number(row.distance_samples)}</td></tr>)}{!opponentRows.length && <tr><td colSpan="5">{t("playerArchive.noEvidence")}</td></tr>}</tbody></table></div>
                <div className="player-profile__evidence-filters">{[["all", t("playerArchive.filterAll")], ["opening", t("playerArchive.filterOpening")], ["kill", t("playerArchive.filterKills")], ["death", t("playerArchive.filterDeaths")], ["clutch", t("playerArchive.filterClutch")], ["utility", t("playerArchive.filterUtility")]].map(([value, label]) => <button type="button" key={value} aria-pressed={evidenceFilter === value} onClick={() => setEvidenceFilter(value)}>{label}</button>)}</div>
                <div className="player-profile__evidence-list">{evidenceRows.slice(0, 100).map((row, index) => {
                  const title = row.evidence_type === "kill" || row.evidence_type === "death" ? `${row.is_opening ? `${t("playerArchive.openingPrefix")} · ` : ""}${row.evidence_type === "kill" ? t("playerArchive.recordedKills") : t("playerArchive.recordedDeaths")} · ${row.opponent || "—"}` : row.evidence_type === "clutch" ? `${t("playerArchive.clutch")} · ${row.won ? t("playerArchive.clutchWon") : t("playerArchive.clutchLost")}` : `${row.kind || t("playerArchive.filterUtility")} · ${t("playerArchive.filterUtility")}`;
                  const tick = row.tick ?? row.throw_tick ?? null;
                  const positionText = row.evidence_type === "kill" || row.evidence_type === "death"
                    ? `${t("playerArchive.playerLocation")}: ${positionLabel(row.player_position)} · ${t("playerArchive.opponentLocation")}: ${positionLabel(row.opponent_position)}`
                    : row.evidence_type === "clutch" ? t("playerArchive.clutchOpponents", { count: number(row.opponents) })
                      : row.path_length == null ? "" : t("playerArchive.utilityPath", { length: number(row.path_length, 1) });
                  return <button type="button" key={`${row.evidence_type}-${row.round_number}-${tick}-${index}`} onClick={() => jumpToEvidence(row)}><span className={`is-${row.evidence_type}`}>{row.evidence_type === "kill" ? "K" : row.evidence_type === "death" ? "D" : row.evidence_type === "clutch" ? "C" : "U"}</span><div><strong>{title}</strong><small>R{row.round_number} · {row.weapon || row.kind || ""} {row.distance == null ? "" : `· ${number(row.distance)} ${t("playerArchive.units")}`}<br />{positionText}</small></div><ChevronRight size={13} /></button>;
                })}{!evidenceRows.length && <div className="player-profile__empty">{t("playerArchive.noEvidence")}</div>}</div>
              </section>
              <div className="player-profile__spatial-view"><Suspense fallback={<div className="player-profile__empty"><Loader2 size={18} className="animate-spin" />{t("playerArchive.loadingSpatial")}</div>}>{spatialMode === "heatmap" ? <DemoHeatmapView workspace={spatialData.workspace} demoPath={spatialData.demo_path} players={spatialData.workspace?.players || []} selectedPlayer={spatialData.selected_player_key} /> : <Demo2DReplayPreview workspace={spatialData.workspace} demoPath={spatialData.demo_path} players={spatialData.workspace?.players || []} teamAName={spatialData.workspace?.team_a_name || "Team A"} teamBName={spatialData.workspace?.team_b_name || "Team B"} initialRound={replayTarget?.roundNumber} externalSeekTick={replayTarget?.tick ?? null} externalSeekRequestId={replaySeekRequestId} />}</Suspense></div>
            </div>
          </>}
          {spatialMatchesSelection && spatialData && !spatialData.available && <div className="player-profile__empty">{t("playerArchive.spatialUnavailable")}</div>}
        </section>}
      </main>
    </div>
  );
}
