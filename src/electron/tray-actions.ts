import type { TaskPowerStatus } from "./task-power-preference.js";
export type TrayTaskSnapshot = {stats:any;pixiv:any;ai:any;sauce:any;danbooru:any};
export function trayPauseActions(s:TrayTaskSnapshot): {method:string;payload:Record<string,unknown>}[] {
 const actions:{method:string;payload:Record<string,unknown>}[]=[];
 const add=(method:string,payload={})=>actions.push({method,payload});
 const count=(rows:any[],status:string)=>rows?.find(r=>r.status===status)?.count??0;
 const l=s.stats.local;
 if(l&&!l.scanPaused&&(l.activeRoot||l.pendingRoots?.length||s.stats.activity?.scanningRootId))add('local.pause',{kind:'scan'});
 if(l&&!l.imagesPaused&&(l.images?.pending||s.stats.activity?.processing))add('local.pause',{kind:'images'});
 if((!s.pixiv.source.paused||s.pixiv.source.reason==='batch_rest')&&((s.pixiv.source.scopePending??count(s.pixiv.counts,'waiting')+count(s.pixiv.counts,'retry_wait'))>0||count(s.pixiv.counts,'running')>0))add('jobs.pause');
 for(const q of s.ai.queues??[])if(!q.paused&&(q.counts.waiting>0||q.counts.running>0))add('ai.pause',{kind:q.kind});
 for(const [name,state]of [['danbooru',s.danbooru],['sauce',s.sauce]]as const)if(state&&!state.paused&&(count(state.counts,'waiting')>0||count(state.counts,'running')>0))add(name+'.pause');
 return actions;
}
export type TrayMenuState = {power:TaskPowerStatus;canPause:boolean};
