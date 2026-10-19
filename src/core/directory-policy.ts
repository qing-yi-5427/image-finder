/** Only directory components are excluded; a dot in an image filename is allowed. */
export const hasDotDirectory=(directory:string)=>directory.replace(/\\/g,'/').split('/').some(part=>part.startsWith('.'));
export const isExcludedImagePath=(file:string)=>{const parts=file.replace(/\\/g,'/').split('/');parts.pop();return parts.some(part=>part.startsWith('.'));};
export const excludedFileSql=(column:string)=>`(replace(${column},char(92),'/') GLOB '.*/*' OR replace(${column},char(92),'/') GLOB '*/.*/*')`;
export const excludedDirectorySql=(column:string)=>excludedFileSql(`(${column}||'/')`);
export const visibleFilesView=()=>`CREATE VIEW IF NOT EXISTS files_visible AS SELECT f.* FROM files f JOIN roots r ON r.id=f.root_id WHERE NOT ${excludedFileSql('f.relative_path')} AND NOT ${excludedDirectorySql('r.path')}`;
