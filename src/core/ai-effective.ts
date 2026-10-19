export const WD_AUTO_MODEL_ID = "SmilingWolf/wd-eva02-large-tagger-v3";
export const WD_AUTO_MODEL_VERSION =
  "b25b82a03f7282e41aa2f257a52c7583b710bd1c:wd-rgb-white-square-bicubic-bgr-v1";
export const SEMANTIC_MODEL_VERSION =
  "36e679e65c2a2fead755ae21162091293ad37834:onnx-fp32:clip-rgba-white-bicubic-square224-meanstd-v2:bert-uncased-wordpiece-length52-v1:512:l2";
export const WD_AUTO_GENERAL = 0.55;
export const WD_AUTO_CHARACTER = 0.85;
export interface AutoTagScope {
  rootId: string;
  relativePath: string;
  recursive: boolean;
}
export const scopedFileSql = (file = "f", scope = "s") =>
  `${file}.root_id=${scope}.root_id AND (${scope}.relative_path='' OR substr(replace(${file}.relative_path,char(92),'/'),1,length(${scope}.relative_path)+1)=${scope}.relative_path||'/') AND (${scope}.recursive=1 OR instr(substr(replace(${file}.relative_path,char(92),'/'),CASE WHEN ${scope}.relative_path='' THEN 1 ELSE length(${scope}.relative_path)+2 END),'/')=0)`;
export const automaticCandidateSelect = (single = false) =>
  `WITH valid AS MATERIALIZED(SELECT r.file_id,r.input_fingerprint,r.model_version,f.bytes,f.mtime_ms FROM ai_valid_runs r JOIN files_visible f ON f.id=r.file_id WHERE r.kind='wd' ${single ? "AND r.file_id=?" : ""} AND EXISTS(SELECT 1 FROM ai_auto_scopes s WHERE ${scopedFileSql()})) SELECT c.file_id,c.tag,c.category,c.score,v.input_fingerprint,v.model_version,v.bytes,v.mtime_ms FROM valid v JOIN ai_candidates c ON c.file_id=v.file_id JOIN files_visible f ON f.id=c.file_id WHERE c.category IN ('content','general','character') AND EXISTS(SELECT 1 FROM ai_auto_scopes s WHERE ${scopedFileSql()} AND c.score>=CASE WHEN c.category='character' THEN s.character_threshold ELSE s.general_threshold END)`;
export const AI_EFFECTIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_runs(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,kind TEXT NOT NULL,model_id TEXT NOT NULL,model_version TEXT NOT NULL,input_fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL,thresholds TEXT NOT NULL,elapsed_ms REAL NOT NULL,providers TEXT NOT NULL,PRIMARY KEY(file_id,kind));
CREATE TABLE IF NOT EXISTS ai_candidates(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,tag TEXT NOT NULL,category TEXT NOT NULL,score REAL NOT NULL,PRIMARY KEY(file_id,tag));
CREATE TABLE IF NOT EXISTS ai_inputs(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,kind TEXT NOT NULL,bytes INTEGER NOT NULL,mtime_ms REAL NOT NULL,PRIMARY KEY(file_id,kind));
CREATE TABLE IF NOT EXISTS ai_tag_keys(tag TEXT PRIMARY KEY,tag_id TEXT NOT NULL REFERENCES tags(id));
CREATE INDEX IF NOT EXISTS ai_tag_keys_id ON ai_tag_keys(tag_id,tag);
CREATE INDEX IF NOT EXISTS ai_candidates_tag ON ai_candidates(tag,file_id,score);
CREATE TABLE IF NOT EXISTS ai_automatic_tags(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,tag TEXT NOT NULL,tag_id TEXT NOT NULL REFERENCES tags(id),category TEXT NOT NULL,score REAL NOT NULL,input_fingerprint TEXT NOT NULL,model_version TEXT NOT NULL,bytes INTEGER NOT NULL,mtime_ms REAL NOT NULL,PRIMARY KEY(file_id,tag));
CREATE INDEX IF NOT EXISTS ai_automatic_tags_id ON ai_automatic_tags(tag_id,file_id);
CREATE TRIGGER IF NOT EXISTS ai_automatic_invalidate AFTER UPDATE OF bytes,mtime_ms,identity ON files WHEN OLD.bytes<>NEW.bytes OR OLD.mtime_ms<>NEW.mtime_ms OR OLD.identity IS NOT NEW.identity BEGIN DELETE FROM ai_automatic_tags WHERE file_id=NEW.id; END;
CREATE TABLE IF NOT EXISTS ai_auto_scopes(root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,relative_path TEXT NOT NULL,recursive INTEGER NOT NULL,general_threshold REAL NOT NULL,character_threshold REAL NOT NULL,PRIMARY KEY(root_id,relative_path));
CREATE VIEW IF NOT EXISTS ai_valid_runs AS SELECT r.* FROM ai_runs r JOIN files_visible f ON f.id=r.file_id JOIN ai_inputs i ON i.file_id=f.id AND i.kind=r.kind WHERE f.missing=0 AND i.bytes=f.bytes AND i.mtime_ms=f.mtime_ms AND r.input_fingerprint=ai_fingerprint(f.id,f.bytes,f.mtime_ms) AND ((r.kind='wd' AND r.model_id='${WD_AUTO_MODEL_ID}' AND r.model_version='${WD_AUTO_MODEL_VERSION}') OR (r.kind='semantic' AND r.model_version='${SEMANTIC_MODEL_VERSION}'));
CREATE VIEW IF NOT EXISTS ai_auto_candidates AS ${automaticCandidateSelect()};
CREATE VIEW IF NOT EXISTS ai_auto_effective AS SELECT t.file_id,t.tag,t.category,t.score,t.tag_id FROM ai_automatic_tags t JOIN files_visible f ON f.id=t.file_id JOIN ai_runs r ON r.file_id=t.file_id AND r.kind='wd' JOIN ai_inputs i ON i.file_id=f.id AND i.kind='wd' WHERE f.missing=0 AND t.bytes=f.bytes AND t.mtime_ms=f.mtime_ms AND i.bytes=f.bytes AND i.mtime_ms=f.mtime_ms AND r.input_fingerprint=t.input_fingerprint AND r.model_version=t.model_version AND t.model_version='${WD_AUTO_MODEL_VERSION}' AND r.model_id='${WD_AUTO_MODEL_ID}' AND NOT EXISTS(SELECT 1 FROM ai_reviews ar WHERE ar.file_id=t.file_id AND ar.tag=t.tag AND ar.action='exclude');
`;
