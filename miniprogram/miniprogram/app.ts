import {refreshSystemTheme,systemThemeChanged} from './services/appearance';
import {runUploadQueue} from './services/cloud-intake';
import {markForegroundEntry} from './services/foreground';
import {cloud} from './services/cloud';
let timer:ReturnType<typeof setInterval>|undefined;
function wake(){void runUploadQueue().catch(()=>{});}
App({
 onLaunch(){void cloud.restoreSession().catch(()=>{});wx.onNetworkStatusChange(r=>{if(r.isConnected)wake()});},
 // Catalog refresh is owned by the home page once per foreground entry.
 onShow(){refreshSystemTheme();markForegroundEntry();void cloud.restoreSession().catch(()=>{});wake();if(timer!==undefined)clearInterval(timer);timer=setInterval(()=>void runUploadQueue().catch(()=>{}),15000);},
 // Native close cannot await tasks. Only previously confirmed jobs may continue;
 // unsent editor drafts are persisted during input in the intake page.
 onThemeChange(event){systemThemeChanged(event);},
 onHide(){if(timer!==undefined)clearInterval(timer);timer=undefined;void runUploadQueue().catch(()=>{});}
});
