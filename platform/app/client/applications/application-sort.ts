import type {Application,Opening} from '../../shared/types';
export const applicationSortOptions=[
 ['newest','Newest added'],['oldest','Oldest added'],['company','Company · A–Z'],['company-desc','Company · Z–A'],
 ['title','Role title · A–Z'],['stage','Stage · pipeline order'],['stage-desc','Stage · reverse pipeline order'],
 ['next-action','Next action · A–Z'],['next-action-desc','Next action · Z–A'],['followup','Follow-up · earliest first'],['followup-desc','Follow-up · latest first'],
 ['application-date','Application date · newest'],['submitted','Submitted · newest first'],['submitted-asc','Submitted · oldest first'],
] as const;
export const applicationSort=(value:unknown)=>applicationSortOptions.find(([key])=>key===value)?.[0]??'submitted';
const collator=new Intl.Collator('en',{numeric:true,sensitivity:'base'});
function date(v:unknown){if(typeof v!=='string'||!v.trim())return null;const n=Date.parse(v);return Number.isFinite(n)?n:null;}
function dates(a:unknown,b:unknown,descending=false){const x=date(a),y=date(b);if(x===null)return y===null?0:1;if(y===null)return -1;return descending?y-x:x-y;}
function names(a:string|undefined,b:string|undefined,descending=false){if(!a)return b?1:0;if(!b)return -1;return descending?collator.compare(b,a):collator.compare(a,b);}
export function sortApplications(rows:Application[],openings:Opening[],value:unknown,stages:readonly string[],action:(a:Application)=>string|undefined=a=>a.nextAction){
 const mode=applicationSort(value),linked=new Map(openings.map(o=>[o.id,o]));
 const rank=(a:Application)=>{const i=stages.indexOf(a.status);return i<0?stages.length:i};
 return [...rows].sort((a,b)=>{
  const x=linked.get(a.openingId),y=linked.get(b.openingId);let order=0;
  switch(mode){
   case 'oldest':order=dates(a.createdAt,b.createdAt);break;
   case 'company':order=names(x?.company,y?.company);break;
   case 'company-desc':order=names(x?.company,y?.company,true);break;
   case 'title':order=names(x?.title,y?.title);break;
   case 'stage':order=rank(a)-rank(b);break;
   case 'stage-desc':order=rank(a)===stages.length?(rank(b)===stages.length?0:1):rank(b)===stages.length?-1:rank(b)-rank(a);break;
   case 'next-action':order=names(action(a),action(b));break;
   case 'next-action-desc':order=names(action(a),action(b),true);break;
   case 'followup':order=dates(a.followUp,b.followUp);break;
   case 'followup-desc':order=dates(a.followUp,b.followUp,true);break;
   case 'application-date':order=dates(a.applicationDate,b.applicationDate,true);break;
   case 'submitted-asc':order=dates(a.submittedAt,b.submittedAt);break;
   case 'submitted':order=dates(a.submittedAt,b.submittedAt,true);break;
   default:order=dates(a.createdAt,b.createdAt,true);
  }
  return order||names(x?.company,y?.company)||names(x?.title,y?.title)||collator.compare(a.id,b.id);
 });
}
