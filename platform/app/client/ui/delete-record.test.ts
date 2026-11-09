import test, { afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
const keys=['window','document','navigator','HTMLElement','Node'] as const;
const original=keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)] as const);
for(const k of keys)Object.defineProperty(globalThis,k,{configurable:true,value:dom.window[k]});
dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
const {createElement}=await import('react');
const {render,cleanup,fireEvent,waitFor,act}=await import('@testing-library/react');
const {mock}=await import('node:test');
const {default:DeleteRecord}=await import('./DeleteRecord');
const {setCsrf}=await import("../workspace/api");
const originalFetch=globalThis.fetch;
const calls:{url:string;method:string;body:any}[]=[];
const preview={token:'reviewed-token',records:[{kind:'filter',id:'fixture',title:'Fixture'}],updatedRecords:[],files:[],editedFiles:[],sharedFiles:0};
let fail=false,blockedBy:string[]|undefined;
globalThis.fetch=async(input,init)=>{
 const url=String(input),method=init?.method??'GET';calls.push({url,method,body:init?.body?JSON.parse(String(init.body)):null});
 return method==='DELETE'?Response.json(fail?{error:'The record changed. Review again.'}:{deleted:true},{status:fail?409:200}):Response.json({...preview,blockedBy});
};
setCsrf('fixture-csrf');
afterEach(()=>{cleanup();calls.length=0;fail=false;blockedBy=undefined;});
after(()=>{globalThis.fetch=originalFetch;dom.window.close();for(const[k,d]of original){if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);}});

test('Trash button previews deletion and Cancel makes no mutation; confirmation sends only the reviewed token',async()=>{
 let deleted=0;
 const view=render(createElement(DeleteRecord,{kind:'filter',id:'fixture',label:'Fixture',onDeleted:()=>deleted++}));
 fireEvent.click(view.getByLabelText('Delete Fixture'));
 await view.findByText('Review everything being deleted');
 assert.equal(calls.some(c=>c.method==='DELETE'),false);
 fireEvent.click(view.getByText('Cancel'));
 assert.equal(view.queryByRole('dialog'),null);
 fireEvent.click(view.getByLabelText('Delete Fixture'));
 await view.findByText('Review everything being deleted');
 fireEvent.click(view.getByText('Permanently delete'));
 await waitFor(()=>assert.equal(deleted,1));
 assert.deepEqual(calls.filter(c=>c.method==='DELETE'),[{url:'/api/records/filter/fixture',method:'DELETE',body:{token:'reviewed-token'}}]);
});

test('failed deletion stays visible and confirms only a freshly fetched preview',async()=>{
 fail=true;
 const view=render(createElement(DeleteRecord,{kind:'filter',id:'fixture',label:'Fixture'}));
 fireEvent.click(view.getByLabelText('Delete Fixture'));
 await view.findByText('Review everything being deleted');
 fireEvent.click(view.getByText('Permanently delete'));
 await view.findByText('The record changed. Review again.');
 assert.ok(view.getByRole('dialog'));
 // A dead dialog after a 409 left owner waiting an hour on work that had finished.
 await waitFor(()=>assert.equal(calls.filter(c=>c.method==='GET').length,2));
 await waitFor(()=>assert.equal((view.getByText('Permanently delete') as HTMLButtonElement).disabled,false));
 assert.ok(view.getByText('The record changed. Review again.'));
});

test('blocking work disables Delete and a recheck unlocks it once the work finishes',async()=>{
 blockedBy=['Tailspin · Lead Front-end Developer'];
 const settle=()=>act(async()=>{for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));});
 mock.timers.enable({apis:['setTimeout']});
 try {
  const view=render(createElement(DeleteRecord,{kind:'opening',id:'fixture',label:'Fixture'}));
  fireEvent.click(view.getByLabelText('Delete Fixture'));
  await settle();
  assert.ok(view.getByText(/Waiting for this work to finish.*Tailspin · Lead Front-end Developer/));
  assert.equal((view.getByText('Permanently delete') as HTMLButtonElement).disabled,true);
  blockedBy=[];
  act(()=>mock.timers.tick(5000));
  await settle();
  assert.equal(calls.filter(c=>c.method==='GET').length,2);
  assert.equal((view.getByText('Permanently delete') as HTMLButtonElement).disabled,false);
  assert.equal(view.queryByText(/Waiting for this work/),null);
 } finally {mock.timers.reset();}
});
