"""One-time conversion of the pinned official Chinese-CLIP weights to FP32 ONNX."""
import json, sys
from pathlib import Path
import torch
from transformers import ChineseCLIPModel
home=Path(sys.argv[1]);directory=home/'models'/'semantic'
torch.set_num_threads(4)
model=ChineseCLIPModel.from_pretrained(str(directory),local_files_only=True,attn_implementation='eager').eval()
class Vision(torch.nn.Module):
    def __init__(self,model):super().__init__();self.model=model
    def forward(self,pixel_values):
        return self.model.visual_projection(self.model.vision_model(pixel_values=pixel_values,return_dict=False)[1])
class Text(torch.nn.Module):
    def __init__(self,model):super().__init__();self.model=model
    def forward(self,input_ids,attention_mask,token_type_ids):
        return self.model.text_projection(self.model.text_model(input_ids=input_ids,attention_mask=attention_mask,token_type_ids=token_type_ids,return_dict=False)[0][:,0,:])
with torch.inference_mode():
    torch.onnx.export(Vision(model),(torch.zeros(1,3,224,224),),str(directory/'image.onnx'),input_names=['pixel_values'],output_names=['embedding'],opset_version=17,dynamo=False)
    torch.onnx.export(Text(model),(torch.zeros(1,52,dtype=torch.int64),torch.ones(1,52,dtype=torch.int64),torch.zeros(1,52,dtype=torch.int64)),str(directory/'text.onnx'),input_names=['input_ids','attention_mask','token_type_ids'],output_names=['embedding'],opset_version=17,dynamo=False)
print(json.dumps({'export':'complete','dimension':512,'preprocess':'clip-rgba-white-bicubic-square224-meanstd-v2','tokenizer':'bert-uncased-wordpiece-length52-v1'}))
