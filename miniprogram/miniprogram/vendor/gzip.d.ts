export function gzipSync(data: Uint8Array, options?: {level?: number; mtime?: number}): Uint8Array;

export class Gunzip { constructor(ondata:(chunk:Uint8Array,final:boolean)=>void); push(chunk:Uint8Array,final?:boolean):void; onmember?:(offset:number)=>void; }
