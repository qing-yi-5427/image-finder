import csv,json,sqlite3,sys,hashlib
from pathlib import Path
home=Path(sys.argv[1]);db=sqlite3.connect(f"file:{(home/'models'/'translation'/'tag.sqlite').as_posix()}?mode=ro",uri=True)
rows={row[0]:row[1] for row in db.execute('SELECT name,cn_name FROM tags WHERE cn_name IS NOT NULL AND cn_name != \'\'')}
with open(home/'models'/'wd'/'selected_tags.csv',encoding='utf-8') as stream:tags=list(csv.DictReader(stream))
matched={tag['name']:rows[tag['name']] for tag in tags if tag['name'] in rows}
result={'source':'ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table','revision':'5a0f6bcd436ae7548884dbfcd81c09090f1d4762','license':'MIT','quality':'Gemini translation with community manual corrections; not all manually verified','total':len(tags),'translated':len(matched),'tags':matched}
(home/'wd-translations.json').write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')
print(json.dumps({k:v for k,v in result.items() if k!='tags'}))
