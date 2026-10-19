"""Isolated offline inference. stdin/stdout are JSONL; diagnostics use stderr."""
import csv, json, os, sys, time, traceback, hashlib
from pathlib import Path
import numpy as np
from PIL import Image, ImageOps
import onnxruntime as ort

HOME = Path(sys.argv[1])
KIND = sys.argv[2]
PROVIDER = sys.argv[3] if len(sys.argv)>3 else 'cpu'
sessions = {}
profiled=set()
def execution(sess,name):
    if PROVIDER!='directml' or name in profiled:return None
    profiled.add(name)
    profile=sess.end_profiling()
    counts={}
    try:
        for event in json.loads(Path(profile).read_text(encoding='utf-8')):
            provider=event.get('args',{}).get('provider')
            if provider:counts[provider]=counts.get(provider,0)+1
    except Exception:pass
    result={'profile':profile,'nodeProviders':counts}
    (HOME/f'{KIND}-gpu-profile-summary.json').write_text(json.dumps(result),encoding='utf-8')
    return result
def session(name, filename):
    if name not in sessions:
        # Portable copies may change mtimes. Verify actual bytes before the first load.
        marker=json.loads((HOME/'models-ready.json').read_text(encoding='utf-8'))
        for file_name,record in marker['files'][KIND].items():
            h=hashlib.sha256()
            with (HOME/'models'/KIND/file_name).open('rb') as stream:
                for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
            if h.hexdigest()!=record['sha256']:raise RuntimeError('AI_MODEL_HASH_MISMATCH:'+file_name)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        providers = ['CPUExecutionProvider']
        if PROVIDER == 'directml':
            if 'DmlExecutionProvider' not in ort.get_available_providers():
                raise RuntimeError('DIRECTML_UNAVAILABLE')
            options.enable_mem_pattern = False
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            providers = ['DmlExecutionProvider', 'CPUExecutionProvider']
            options.enable_profiling=True
            options.profile_file_prefix=str(HOME/f'{KIND}-ort-profile')
        sessions[name] = ort.InferenceSession(str(HOME/'models'/KIND/filename), sess_options=options, providers=providers)
    return sessions[name]
def image(path):
    with Image.open(path) as source:
        source=ImageOps.exif_transpose(source).convert('RGBA')
        canvas=Image.new('RGBA',source.size,'white')
        canvas.alpha_composite(source)
        return canvas.convert('RGB')
def normalize(value):
    vector = np.asarray(value,dtype=np.float32).reshape(-1)
    length=np.linalg.norm(vector)
    if not np.isfinite(length) or length <= 0: raise ValueError('INVALID_VECTOR')
    return (vector/length).tolist()
def infer(request):
    started=time.perf_counter()
    if KIND=='wd':
        sess=session('wd','model.onnx')
        size=sess.get_inputs()[0].shape[1]
        original=image(request['path'])
        edge=max(original.size)
        padded=Image.new('RGB',(edge,edge),'white')
        padded.paste(original,((edge-original.width)//2,(edge-original.height)//2))
        pixels=np.asarray(padded.resize((size,size),Image.Resampling.BICUBIC),dtype=np.float32)[:,:,::-1][None,...]
        scores=sess.run(None,{sess.get_inputs()[0].name:pixels})[0][0]
        with open(HOME/'models'/'wd'/'selected_tags.csv',encoding='utf-8') as stream:
            tags=list(csv.DictReader(stream))
        # Persist broad raw candidate range; display threshold is recorded separately.
        retained=set(request.get('retainTags',[]))
        candidates=[{'tag':tag['name'],'category':'character' if tag['category']=='4' else 'rating' if tag['category']=='9' else 'content','score':float(score)} for tag,score in zip(tags,scores) if float(score)>=0.01 or tag['name'] in retained]
        candidates.sort(key=lambda item:item['score'],reverse=True)
        result={'candidates':candidates,'providers':sess.get_providers(),'execution':execution(sess,'wd')}
    elif 'text' in request:
        from transformers import BertTokenizer
        tokenizer=BertTokenizer(vocab_file=str(HOME/'models'/'semantic'/'vocab.txt'),do_lower_case=True)
        tokens=tokenizer(request['text'],padding='max_length',max_length=52,truncation=True,return_tensors='np')
        sess=session('text','text.onnx')
        output=sess.run(None,{i.name:tokens[i.name].astype(np.int64) for i in sess.get_inputs()})[0]
        result={'vector':normalize(output),'providers':sess.get_providers(),'execution':execution(sess,'text')}
    else:
        original=image(request['path'])
        # Pinned HF preprocessor_config: fixed 224x224, do_center_crop=false.
        pixels=np.asarray(original.resize((224,224),Image.Resampling.BICUBIC),dtype=np.float32)/255.0
        pixels=(pixels-np.array([0.48145466,0.4578275,0.40821073],np.float32))/np.array([0.26862954,0.26130258,0.27577711],np.float32)
        sess=session('image','image.onnx')
        output=sess.run(None,{sess.get_inputs()[0].name:pixels.transpose(2,0,1)[None,...]})[0]
        result={'vector':normalize(output),'providers':sess.get_providers(),'execution':execution(sess,'image')}
    result['elapsedMs']=(time.perf_counter()-started)*1000
    return result
for line in sys.stdin:
    try:
        request=json.loads(line)
        reply={'id':request['id'],'result':infer(request)}
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        reply={'id':request.get('id') if 'request' in globals() else None,'error':str(error)}
    print(json.dumps(reply,ensure_ascii=True),flush=True)
