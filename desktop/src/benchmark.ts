// Development-only UI acceptance probe, enabled by QBANK_BENCHMARK=1.
// Queries go through the normal React state -> IPC -> SQLite -> render path.
export function benchmarkCases(n:number,bank:string){
 const topics=['组件布局','窗口管理','状态更新','网络通信','数据存储','文件读写','页面导航','通知服务','多端部署','权限校验','动画效果','输入事件','列表滚动','资源加载','生命周期','表单编辑','中文检索','代码规范','离线发布','数据恢复'];
 return Array.from({length:200},(_,i)=>({
  text:[()=> '中',()=>topics[Math.floor(i/10)%20].slice(0,2),()=>`service${String(i%251).padStart(3,'0')}`,()=>`任务${String(i*499%n).padStart(7,'0')}`,()=>[()=>`${topics[Math.floor(i/10)%20]} ${topics[(Math.floor(i/10)+3)%20]}`,()=>`中 service${String(i%251).padStart(3,'0')}`,()=>'Ωξ @Component',()=>'罕 @Component'][Math.floor(i/10)%4](),()=> '不存在的关键词零命中',()=> '@Component',()=> 'Ωξ',()=> '=value',()=>`BENCH-${String(i*401%n).padStart(7,'0')}`][i%10](),
  bank:i%4===0?bank:'',kind:i%7===0?'single':''
 }));
}
export function percentiles(values:number[]){const v=[...values].sort((a,b)=>a-b);const p=(n:number)=>v[Math.ceil((v.length-1)*n)];return {p50:p(.5),p95:p(.95),p99:p(.99),max:v.at(-1)};}
