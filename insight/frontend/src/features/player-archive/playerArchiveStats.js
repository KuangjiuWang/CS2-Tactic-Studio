const COUNT_FIELDS = [
  "kills", "deaths", "assists", "headshots", "first_kills", "first_deaths",
  "trade_kills", "trade_deaths", "clutch_attempts", "clutch_wins",
  "one_kill_rounds", "two_kill_rounds", "three_kill_rounds", "four_kill_rounds",
  "five_kill_rounds", "awp_kills",
];

function emptyTotals() {
  return {
    matches: 0, rounds: 0, kills: 0, deaths: 0, assists: 0, headshots: 0,
    damage: 0, kastRounds: 0, survivedRounds: 0, wins: 0, firstKills: 0,
    firstDeaths: 0, tradeKills: 0, tradeDeaths: 0, clutchAttempts: 0,
    clutchWins: 0, utilityDamage: 0, multiKillRounds: 0, awpKills: 0,
    oneKillRounds: 0, twoKillRounds: 0, threeKillRounds: 0, fourKillRounds: 0, fiveKillRounds: 0,
    ratingRounds: 0, ratingTotal: 0, damageCoveredRounds: 0,
  };
}

export function aggregateMatches(matches, side = "all") {
  const totals = emptyTotals();
  for (const match of matches) {
    const metrics = match.metrics || {};
    const breakdown = side === "all" ? null : metrics.side_breakdown?.[side];
    if (side !== "all" && !breakdown) continue;
    const rounds = Number(breakdown?.rounds ?? metrics.total_rounds ?? 0);
    if (!rounds) continue;
    totals.matches += 1;
    totals.rounds += rounds;
    const value = (field) => Number(breakdown?.[field] ?? metrics[field] ?? 0) || 0;
    for (const field of COUNT_FIELDS) {
      const target = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      if (target in totals) totals[target] += value(field);
    }
    const damage = breakdown?.damage ?? metrics.damage
      ?? (side === "all" && metrics.adr != null ? Number(metrics.adr) * rounds : 0);
    totals.damage += Number(damage) || 0;
    totals.utilityDamage += value("utility_damage");
    const sideKastRounds = Object.values(metrics.side_breakdown || {})
      .reduce((sum, sideStats) => sum + Number(sideStats.kast_rounds || 0), 0);
    totals.kastRounds += breakdown
      ? Number(breakdown.kast_rounds || 0)
      : metrics.kast_rounds != null
        ? Number(metrics.kast_rounds)
        : Object.keys(metrics.side_breakdown || {}).length
          ? sideKastRounds
          : Number(metrics.kast || 0) * rounds / 100;
    totals.survivedRounds += breakdown ? Number(breakdown.survived_rounds || 0) : Number(metrics.survival_rate || 0) * rounds / 100;
    totals.wins += Number(breakdown?.wins ?? metrics.rounds_won ?? 0);
    totals.damageCoveredRounds += Number(breakdown?.damage_samples ?? (metrics.adr != null ? rounds : 0));
    if (side === "all" && metrics.rating_approx != null) {
      totals.ratingTotal += Number(metrics.rating_approx) * rounds;
      totals.ratingRounds += rounds;
    }
  }
  totals.kd = totals.deaths ? totals.kills / totals.deaths : totals.kills;
  totals.kpr = totals.rounds ? totals.kills / totals.rounds : null;
  totals.dpr = totals.rounds ? totals.deaths / totals.rounds : null;
  totals.adr = totals.rounds && totals.damageCoveredRounds >= totals.rounds * 0.9 ? totals.damage / totals.rounds : null;
  totals.kast = totals.rounds ? totals.kastRounds / totals.rounds * 100 : null;
  totals.survival = totals.rounds ? totals.survivedRounds / totals.rounds * 100 : null;
  totals.hsPercent = totals.kills ? totals.headshots / totals.kills * 100 : null;
  totals.openingDuels = totals.firstKills + totals.firstDeaths;
  totals.openingRate = totals.openingDuels ? totals.firstKills / totals.openingDuels * 100 : null;
  totals.clutchRate = totals.clutchAttempts ? totals.clutchWins / totals.clutchAttempts * 100 : null;
  totals.utilityDamagePerRound = totals.rounds ? totals.utilityDamage / totals.rounds : null;
  totals.roundWinRate = totals.rounds ? totals.wins / totals.rounds * 100 : null;
  if (side === "all" && totals.ratingRounds) {
    totals.ratingApprox = totals.ratingTotal / totals.ratingRounds;
  } else if (totals.rounds) {
    const assistsPerRound = totals.assists / totals.rounds;
    totals.ratingApprox = 0.3591 * totals.kpr - 0.5329 * totals.dpr
      + 0.2372 * (2.13 * totals.kpr + 0.42 * assistsPerRound - 0.41)
      + 0.0032 * (totals.adr || 0) + 0.1587;
  } else {
    totals.ratingApprox = null;
  }
  totals.multiKillRounds = totals.twoKillRounds + totals.threeKillRounds + totals.fourKillRounds + totals.fiveKillRounds;
  return totals;
}
