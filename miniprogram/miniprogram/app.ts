import {runUploadQueue} from './services/cloud-intake';
import {activeBankId,invalidateBank} from './services/bank';
import {syncBank} from './services/sync';
let timer:ReturnType<typeof setInterval>|undefined;
function wake(){void runUploadQueue().catch(()=>{});const id=activeBankId();void syncBank(id).then(changed=>{if(changed)invalidateBank(id)}).catch(()=>{});}
App({
 onLaunch(){wx.onNetworkStatusChange(r=>{if(r.isConnected)wake()});},
 onShow(){wake();if(timer!==undefined)clearInterval(timer);timer=setInterval(()=>void runUploadQueue().catch(()=>{}),15000);},
 // Native close cannot await tasks. Only previously confirmed jobs may continue;
 // unsent editor drafts are persisted during input in the intake page.
 onHide(){if(timer!==undefined)clearInterval(timer);timer=undefined;void runUploadQueue().catch(()=>{});}
});
