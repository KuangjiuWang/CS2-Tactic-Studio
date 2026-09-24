import type { Match, Player, Side } from '../types';

// A team is a stable roster of SteamIDs. T/CT is an attribute of the round,
// never a key used to select POV jobs after the halftime swap.
export function rosterForTeam(match:Match,teamId:string):Player[]{
 const ids=match.teams.find(team=>team.id===teamId)?.playerIds??[];
 return ids.map(id=>match.players.find(player=>player.id===id)).filter((player):player is Player=>!!player);
}
export function teamSideAtTick(match:Match,teamId:string,tick:number):Side|undefined{
 const round=[...match.rounds].reverse().find(value=>value.startTick<=tick);
 if(!round?.teamASide)return undefined;
 return teamId===match.teams[0]?.id?round.teamASide:teamId===match.teams[1]?.id?(round.teamASide===2?3:2):undefined;
}
