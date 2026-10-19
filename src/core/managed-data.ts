import path from'node:path';import{spawnSync}from'node:child_process';
/** attrib +H changes this one directory only and preserves all other attributes. */
export function hideManagedDataDirectory(directory:string,platform:NodeJS.Platform=process.platform,run:typeof spawnSync=spawnSync):string|null{
 if(platform!=='win32'||!['.image-finder','.image-finder-cache','.image-finder-ai'].includes(path.basename(directory).toLowerCase()))return null;
 const result=run(path.join(process.env.SystemRoot??'C:\\Windows','System32','attrib.exe'),['+H',path.resolve(directory)],{windowsHide:true,encoding:'utf8'});
 return result.error||result.status!==0?'无法设置图库数据目录的 Windows 隐藏属性；扫描排除规则仍然有效。':null;
}
