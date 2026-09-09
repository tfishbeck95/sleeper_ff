import type { LeagueSnapshot } from '@sleeper/domain';
/**
 * A fictional illustration only. Its points are not produced by any league's scoring rules, so they
 * are named `illustrativePoints` and never reach lineup, waiver or trade ranking. The connected
 * dashboard route strips these recommendations rather than mixing them with a real league.
 */
export const demoSnapshot = (): LeagueSnapshot => ({
 leagueId:'demo', leagueName:'Sunday Legends', username:'demo-manager', season:'2026', week:1, record:'0–0', rank:3, pointsFor:0, lastSyncedAt:new Date().toISOString(),
 matchup:{week:1,opponent:'Gridiron Guild',illustrativeFor:126.8,illustrativeAgainst:119.4},
 roster:[
  {id:'1',name:'Jalen Hurts',team:'PHI',position:'QB',illustrativePoints:22.8,trend:'up'},
  {id:'2',name:'Bijan Robinson',team:'ATL',position:'RB',illustrativePoints:19.4,trend:'steady'},
  {id:'3',name:'Amon-Ra St. Brown',team:'DET',position:'WR',illustrativePoints:18.7,trend:'up'},
  {id:'4',name:'Trey McBride',team:'ARI',position:'TE',illustrativePoints:14.1,trend:'steady'}],
 recommendations:[
  {id:'r1',kind:'start',title:'Keep Hurts in your starting lineup',rationale:'Elite rushing usage creates a reliable floor in this matchup. Illustrative only: no league scoring rules were applied.',confidence:92,actionLabel:'View lineup',player:{id:'1',name:'Jalen Hurts',team:'PHI',position:'QB',illustrativePoints:22.8,trend:'up'}},
  {id:'r2',kind:'waiver',title:'Watch the waiver wire for RB depth',rationale:'Your bench has limited coverage behind the starting backs.',confidence:78,actionLabel:'Review targets'},
  {id:'r3',kind:'trade',title:'Explore a 2-for-1 receiver upgrade',rationale:'Package surplus depth to improve your weekly ceiling.',confidence:64,actionLabel:'See analysis'}]
});
