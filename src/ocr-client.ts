import {invoke, isTauri} from '@tauri-apps/api/core';
import type {Worker} from 'tesseract.js';
import type {Hit, Choice} from './types';

export type OcrEngine = 'auto'|'system'|'builtin';
export type OcrImage = {data_url:string;name:string;width:number;height:number;needs_crop?:boolean};
export type OcrInput = {image?:OcrImage|null;text?:string};
export type Recognition = {engine:string;text:string;elapsed_ms:number;lines:{text:string;confidence:number|null;bounds:number[]}[]};
export type Candidate = {hit:Hit;similarity:number;exact_stem:boolean;options_matched:boolean;answer:string;answer_scope:'image'|'bank';answer_details:string[]};
export type Matches = {parsed:{stem:string;options:Choice[];multiple_questions:boolean};candidates:Candidate[];automatic:boolean;message:string;elapsed_ms:number};
const maxBytes = 20 * 1024 * 1024;

export function looksLikeQuestion(text:string){
  return text.trim().length>=12 && (/[\r\n]/.test(text) || /(?:[?？]|[AＡ][.．、]\s*.+[BＢ][.．、]|以下|下列|是否|什么|哪[个些种]|正确|错误|决定)/.test(text) || (text.trim().length>=24&&/[。．.]$/.test(text.trim())));
}
export async function readImage(file:File):Promise<OcrImage>{
  if(file.size>maxBytes)throw Error('图片超过 20 MB，请裁剪到一道题后重试');
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('请选择 PNG、JPEG 或 WebP 图片');
  const data_url=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('无法读取图片'));reader.readAsDataURL(file)});
  const image=await loadImage(data_url);
  if(image.naturalWidth*image.naturalHeight>30_000_000)throw Error('图片尺寸过大，请裁剪后重试');
  return {data_url,name:file.name||'粘贴的图片',width:image.naturalWidth,height:image.naturalHeight};
}
function loadImage(url:string):Promise<HTMLImageElement>{
  return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(Error('图片已损坏或格式不受支持'));image.src=url});
}

// One controller per open panel. Its worker is terminated on cancel/close; late
// system OCR replies are discarded by the panel's operation counter.
export class OcrController {
  private worker:Worker|null=null;
  private cancelled=false;
  async cancel(){this.cancelled=true;const worker=this.worker;this.worker=null;if(worker)await worker.terminate()}
  async recognize(image:OcrImage,engine:OcrEngine,status:(message:string)=>void):Promise<Recognition>{
    if(engine!=='builtin'&&isTauri()){
      status('正在使用系统 OCR 识别…');
      try{
        const result=await invoke<Recognition>('ocr_recognize',{dataUrl:image.data_url});
        if(this.cancelled)throw Error('识别已取消');
        if(result.text.trim())return result;
        if(engine==='system')throw Error('没有识别到文字，请换一张清晰截图或切换内置引擎');
      }catch(e){if(engine==='system'||this.cancelled)throw e;}
      status('系统 OCR 不可用或未识别到文字，正在启用内置引擎…');
    }else if(engine==='system'){throw Error('系统 OCR 需要在桌面程序中使用')}
    const started=performance.now();
    const {createWorker,OEM,PSM}=await import('tesseract.js');
    if(this.cancelled)throw Error('识别已取消');
    const base=new URL('./ocr/',document.baseURI).href;
    const worker=await createWorker('chi_sim+eng',OEM.LSTM_ONLY,{
      workerPath:`${base}worker.min.js`,corePath:`${base}core`,langPath:`${base}lang`,
      gzip:false,workerBlobURL:true,cacheMethod:'none',
      logger:({status:stage,progress})=>{
        if(this.cancelled)return;
        status(stage==='recognizing text'?`内置 OCR 识别中 · ${Math.round(progress*100)}%`:'正在加载内置中英文引擎…');
      },
    });
    this.worker=worker;
    if(this.cancelled){await this.cancel();throw Error('识别已取消')}
    try{
      await worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_BLOCK,preserve_interword_spaces:'1'});
      const source=await loadImage(image.data_url);
      const scale=Math.min(1,3200/Math.max(source.naturalWidth,source.naturalHeight));
      const canvas=document.createElement('canvas');
      canvas.width=Math.round(source.naturalWidth*scale);canvas.height=Math.round(source.naturalHeight*scale);
      const ctx=canvas.getContext('2d');if(!ctx)throw Error('无法准备识别图片');
      ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(source,0,0,canvas.width,canvas.height);
      const {data}=await worker.recognize(canvas,{}, {text:true,blocks:true});
      if(this.cancelled)throw Error('识别已取消');
      return {engine:'内置 Tesseract',text:data.text.trim(),elapsed_ms:performance.now()-started,
        lines:(data.blocks||[]).flatMap(b=>b.paragraphs.flatMap(p=>p.lines.map(l=>({text:l.text,confidence:l.confidence/100,bounds:[l.bbox.x0/canvas.width,l.bbox.y0/canvas.height,(l.bbox.x1-l.bbox.x0)/canvas.width,(l.bbox.y1-l.bbox.y0)/canvas.height]}))))};
    }finally{await this.cancel()}
  }
}
