import React,{useRef,useState} from 'react';
import type {OcrImage} from './ocr-client';
type Point={x:number;y:number};
export function OcrCrop({image,onCrop,onCancel}:{image:OcrImage;onCrop:(image:OcrImage)=>void;onCancel:()=>void}){
  const [start,setStart]=useState<Point|null>(null),[end,setEnd]=useState<Point|null>(null),[error,setError]=useState('');
  const origin=useRef<Point|null>(null),picture=useRef<HTMLImageElement>(null);
  function point(e:React.PointerEvent<HTMLDivElement>):Point{const box=e.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-box.left)/box.width)),y:Math.max(0,Math.min(1,(e.clientY-box.top)/box.height))}}
  function finish(e:React.PointerEvent<HTMLDivElement>){
    const first=origin.current;origin.current=null;if(!first||!picture.current)return;
    e.currentTarget.releasePointerCapture(e.pointerId);const last=point(e);setEnd(last);
    const x=Math.floor(Math.min(first.x,last.x)*picture.current.naturalWidth),y=Math.floor(Math.min(first.y,last.y)*picture.current.naturalHeight);
    const width=Math.round(Math.abs(first.x-last.x)*picture.current.naturalWidth),height=Math.round(Math.abs(first.y-last.y)*picture.current.naturalHeight);
    if(width<20||height<20){setError('请拖动框选题干和选项，范围需要大于 20 × 20 像素');return}
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d');if(!ctx){setError('无法裁剪截图，请重新截图或粘贴图片');return}
    ctx.drawImage(picture.current,x,y,width,height,0,0,width,height);
    onCrop({data_url:canvas.toDataURL('image/png'),name:'框选截图.png',width,height});
  }
  return <div className="ocr-crop"><h2>框选题目</h2><p>在截图上拖动，选中题干和选项；松开鼠标后自动识别。</p><div className="ocr-crop-stage" aria-label="拖动框选题目区域"
    onPointerDown={e=>{if(e.button!==0)return;e.currentTarget.setPointerCapture(e.pointerId);const value=point(e);origin.current=value;setStart(value);setEnd(value);setError('')}}
    onPointerMove={e=>{if(origin.current)setEnd(point(e))}} onPointerUp={finish} onPointerCancel={()=>{origin.current=null;setStart(null);setEnd(null)}}>
    <img ref={picture} src={image.data_url} alt="待框选的主屏幕截图" draggable={false}/>
    {start&&end&&<div className="ocr-crop-selection" style={{left:`${Math.min(start.x,end.x)*100}%`,top:`${Math.min(start.y,end.y)*100}%`,width:`${Math.abs(start.x-end.x)*100}%`,height:`${Math.abs(start.y-end.y)*100}%`}}/>}
  </div>{error&&<p role="alert" className="ocr-error">{error}</p>}<div className="ocr-footer"><span>本次截取主屏幕，框选后仅识别选中区域。</span><button onClick={onCancel}>取消框选</button></div></div>
}
