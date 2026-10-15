import {MODEL_PROMPT} from '../generated/client-assets';
export function copyPrompt():void {
 wx.setClipboardData({data:MODEL_PROMPT,fail:()=>wx.showToast({title:'复制失败，请重试',icon:'none'})});
}
