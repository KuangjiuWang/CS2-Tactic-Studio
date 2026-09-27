# Player Archive — Phase 1 data contract

The Player Archive is a local-only cross-demo directory. Its first increment
indexes known Demo Library rosters, lets the user search/filter players, and
stores membership in three overlapping collections: Professional, Amateur
High-Level, and Team Members. The player identity and derived match data remain
shared when a player appears in more than one collection.

## Identity and source data

- Use SteamID64 as the canonical key whenever the demo provides it.
- If SteamID64 is unavailable, use a known account ID. Never merge players by
  nickname alone. Rows identified only by engine user ID or nickname stay
  scoped to their originating demo and are labeled as local/low-confidence.
- Read roster and event counts from the existing local `demo_player_stats`
  index and join them to `demo_files`. No demo, video, or player data is sent to
  an external service.
- Deduplicate roster totals by Demo content MD5 when available. Without a
  content fingerprint, treat separate Demo Library entries as separate
  matches.
- Keep the observed nicknames as aliases; the most recently observed nickname
  is the display label. Group membership is keyed by identity, not nickname.

## Phase 1 metrics

The initial profile may show demo count, map count, total kills/deaths/assists,
and K/D. These are sums over unique indexed matches and are not yet
map/side/economy-adjusted. K/D is kills divided by deaths; when deaths are
zero, show kills as the ratio numerator rather than dividing by zero. Every
value is derived from the roster index and must be traceable to the listed
matches. Empty or missing roster rows are not interpreted as zero performance.

First kills/deaths, opening duel rate, trades, and clutches already exist in
the per-match analysis workspace; they are not aggregated in Phase 1. The
opening-duel rate must be wins divided by the selected player's opening wins
plus opening deaths, with the number of participating rounds shown. General
duel win rate is deferred until a reproducible event grouping is validated;
multiplayer fights and unresolved exchanges must not be silently counted as
1v1 losses.

## UI and completion criteria

- Add a dedicated Player Archive entry and a Tactical Playbook-inspired
  two-pane page: collection/search/map filters on the left and the selected
  player's profile plus match list on the right.
- Provide All Players, Professional, Amateur High-Level, and Team Members
  views. A player may belong to more than one collection without duplicating
  the underlying profile or its stats.
- Search display names, aliases, and SteamID64. Map filtering uses the map
  recorded by the Demo Library. Show the selected player's observed aliases,
  identity confidence, maps, match count, and per-match roster stats.
- Each displayed metric exposes its source and denominator. The UI must mark
  identity as local/low-confidence when no cross-demo stable ID is available.
- Existing Demo Library rows and settings remain unchanged. The new SQLite
  membership table is additive and is created idempotently at app startup.

## Phase 2 — saved match metrics

- Read the already-saved `analysis_workspace` in `match_results`; opening the
  archive never reparses a Demo. A match without a complete saved workspace is
  marked unavailable instead of contributing zeroes.
- Expose ADR, KAST, headshot percentage, opening kills/deaths and win rate,
  trade kills/deaths, clutch attempts/wins, and utility damage per round.
- Opening win rate is first kills / (first kills + first deaths), with both
  counts and the duel denominator shown. Clutch rate is wins / attempts, with
  its attempt count shown. ADR and KAST are weighted by analyzed rounds when
  combining matches; HS% is weighted by kills.
- General duel win rate remains unavailable until the event grouping can
  distinguish resolved 1v1s from multi-player fights and unresolved exchanges.

## Phase 3 — 2D scouting evidence

- Let the analyst choose an analyzed Demo and open its existing round-by-round
  2D replay or movement/combat/kill/death heatmap. Both reuse the app's replay
  components and local replay cache rather than implementing another parser or
  coordinate transform.
- Load spatial data only after the analyst opens this panel. The replay keeps
  the selected match's own radar transform and round events, including kill
  positions and utility tracks when the saved workspace/cache provides them.
- The heatmap is available for one selected Demo at a time, with side filters;
  this avoids merging coordinate data across map versions or different radar
  transforms. It can be compared across matches by switching the Demo selector.
- Demos without a saved analysis workspace stay visible in the match list but
  cannot provide this evidence until analyzed in the Demo Library.

## Phase 4 — engagement and opponent evidence

- Add a per-player event dossier for confirmed kills/deaths, opening eliminations,
  saved clutch outcomes, and that player's saved grenade trajectories. Show
  opponent kill/death counts and average distance only when both elimination
  positions exist in the saved event data.
- Clicking an event opens the existing 2D round replay at its round and, when
  available, its event tick. Missing coordinates remain missing; they are not
  replaced with guessed positions.
- These are observed events, not a complete sample of every aim duel. General
  1v1 win rate stays unavailable until the parser can identify attempts,
  participants, and resolved outcomes without treating multi-player fights as
  duels. Distances are Demo coordinate units, not meters.
- All dossier data is derived from the already-saved local analysis workspace;
  opening the dossier does not upload or reparse the Demo.

## Phase 5 — local comparison and export

- Allow up to two directory profiles to be compared side by side. Apply the
  current map filter consistently to both profiles and show match count, K/D/A,
  analyzed ADR/KAST/headshot rate, opening record, clutch record, trades, and
  utility damage per round with their available sample counts.
- Export a versioned JSON scouting report on-device. It contains player
  identity/aliases, selected-map scope, aggregate stats, and safe per-match
  result fields. It deliberately excludes absolute Demo paths, video paths,
  raw workspaces, and source files.
- Comparison and export use the existing local API/database only; no server,
  account, or network service is required.
