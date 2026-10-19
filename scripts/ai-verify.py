"""Verify official forward / exported ONNX, then publish a complete-file marker."""
import hashlib,json,sys,time,csv
from pathlib import Path
import numpy as np, torch, onnxruntime as ort
from transformers import ChineseCLIPModel,BertTokenizer
home=Path(sys.argv[1]);directory=home/'models'/'semantic'
torch.set_num_threads(4);torch.manual_seed(17)
model=ChineseCLIPModel.from_pretrained(str(directory),local_files_only=True,attn_implementation='eager').eval()
tokenizer=BertTokenizer(vocab_file=str(directory/'vocab.txt'),do_lower_case=True)
opts=ort.SessionOptions();opts.intra_op_num_threads=4;opts.inter_op_num_threads=1
vision=ort.InferenceSession(str(directory/'image.onnx'),sess_options=opts,providers=['CPUExecutionProvider'])
text=ort.InferenceSession(str(directory/'text.onnx'),sess_options=opts,providers=['CPUExecutionProvider'])
evidence=[]
for query in ['蓝色长发的女孩站在海边','夜晚的城市灯光和雨伞','黑白漫画，多个人物','初音未来']:
    tokens=tokenizer(query,padding='max_length',max_length=52,truncation=True,return_tensors='pt')
    pixels=torch.randn(1,3,224,224)
    with torch.inference_mode():expected=model(**tokens,pixel_values=pixels)
    actual_text=text.run(None,{k:v.numpy() for k,v in tokens.items()})[0]
    actual_image=vision.run(None,{'pixel_values':pixels.numpy()})[0]
    row={'query':query}
    for kind,actual,baseline in [('text',actual_text,expected.text_embeds.numpy()),('image',actual_image,expected.image_embeds.numpy())]:
        actual/=np.linalg.norm(actual,axis=-1,keepdims=True)
        error=float(np.max(np.abs(actual-baseline)));cosine=float(np.sum(actual*baseline))
        assert error<1e-4 and cosine>0.99999,(kind,error,cosine)
        row[kind]={'maxAbsoluteError':error,'cosine':cosine}
    evidence.append(row)
files={}
for kind,names in {'wd':['model.onnx','selected_tags.csv'],'semantic':['image.onnx','text.onnx','vocab.txt']}.items():
    files[kind]={}
    for name in names:
        file=home/'models'/kind/name;h=hashlib.sha256()
        with file.open('rb') as stream:
            for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
        files[kind][name]={'bytes':file.stat().st_size,'mtimeMs':file.stat().st_mtime_ns/1000000,'sha256':h.hexdigest()}
marker={'format':1,'preprocess':'clip-rgba-white-bicubic-square224-meanstd-v2','tokenizer':'bert-uncased-wordpiece-length52-v1','dimension':512,'verifiedAt':time.time(),'files':files,'equivalence':evidence}
(home/'models-ready.json.tmp').write_text(json.dumps(marker,ensure_ascii=False,indent=2),encoding='utf-8')
(home/'models-ready.json.tmp').replace(home/'models-ready.json')
print(json.dumps(marker,ensure_ascii=True,indent=2))
