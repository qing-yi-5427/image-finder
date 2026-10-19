/** Native file drags accept catalog IDs only, and publish only after every original is rechecked. */
export class NativeFileDrag {
 private busy=false;
 constructor(private deps:{resolve:(id:string)=>Promise<string>;start:(files:string[])=>void}){}
 async start(fileIds:string[]) {
  if(this.busy)throw new Error('正在拖出文件，请稍后重试。');
  if(!Array.isArray(fileIds)||!fileIds.length||fileIds.length>500||fileIds.some(id=>typeof id!=='string'||!id||id.includes('\0')))throw new Error('拖拽图片数量或标识无效，一次最多500张。');
  this.busy=true;
  try{const ids=[...new Set(fileIds)];const paths=[];for(const id of ids)paths.push(await this.deps.resolve(id));this.deps.start([...new Set(paths)]);return {started:true as const,count:ids.length};}finally{this.busy=false;}
 }
}
