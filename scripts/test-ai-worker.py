"""Offline preprocessing/cache regressions; run with the managed AI Python. No models/GPU needed."""
import ast,csv,tempfile,unittest,sys,types
from pathlib import Path
from unittest.mock import patch
import numpy as np
from PIL import Image,ImageOps

WORKER=Path(__file__).with_name('ai-worker.py')
def worker_functions(home):
    tree=ast.parse(WORKER.read_text(encoding='utf-8'))
    names={'InputImageError','image','wd_tags','tokenizer'}
    selected=[node for node in tree.body if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in names]
    ns={'HOME':home,'Image':Image,'ImageOps':ImageOps,'csv':csv,'wd_tag_rows':None,'text_tokenizer':None}
    exec(compile(ast.Module(body=selected,type_ignores=[]),str(WORKER),'exec'),ns)
    return ns

def previous_image(path):
    with Image.open(path) as source:
        source=ImageOps.exif_transpose(source).convert('RGBA')
        canvas=Image.new('RGBA',source.size,'white');canvas.alpha_composite(source)
        return canvas.convert('RGB')

class WorkerRegression(unittest.TestCase):
    def test_rgb_fast_path_and_all_other_modes_preserve_exact_pixels(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);ns=worker_functions(home)
            rgb=np.arange(13*17*3,dtype=np.uint8).reshape(13,17,3)
            files=[]
            def save(image,name,**kwargs):
                p=home/name;image.save(p,**kwargs);files.append(p)
            save(Image.fromarray(rgb),'rgb.png')
            alpha=np.concatenate([rgb,np.tile(np.array([0,127,255],dtype=np.uint8),74)[:13*17].reshape(13,17,1)],axis=2)
            save(Image.fromarray(alpha),'rgba.png')
            save(Image.fromarray(rgb).convert('L'),'gray.png')
            save(Image.fromarray(alpha).convert('LA'),'gray-alpha.png')
            save(Image.fromarray(rgb).quantize(colors=8),'palette.png',transparency=0)
            save(Image.fromarray(rgb),'rgb-trns.png',transparency=(0,1,2))
            save(Image.fromarray(rgb).convert('CMYK'),'cmyk.jpg')
            save(Image.fromarray(np.arange(13*17,dtype=np.uint16).reshape(13,17)),'16bit.png')
            exif=Image.Exif();exif[274]=6
            save(Image.fromarray(rgb),'exif.jpg',exif=exif)
            for file in files:
                with self.subTest(file=file.name):
                    before=np.asarray(previous_image(file));after=np.asarray(ns['image'](file))
                    self.assertTrue(np.array_equal(before,after));self.assertEqual(before.shape,after.shape)
            bad=home/'bad.png';bad.write_bytes(b'not an image')
            with self.assertRaises(ns['InputImageError']):ns['image'](bad)
    def test_tag_metadata_is_loaded_once_without_changing_order_or_categories(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);directory=home/'models'/'wd';directory.mkdir(parents=True)
            (directory/'selected_tags.csv').write_text('name,category\nblue_hair,0\nperson,4\nsafe,9\n',encoding='utf-8')
            ns=worker_functions(home)
            import builtins
            with patch('builtins.open',wraps=builtins.open) as opened:
                first=ns['wd_tags']();second=ns['wd_tags']()
                self.assertIs(first,second);self.assertEqual(opened.call_count,1)
            self.assertEqual(first,[('blue_hair','content'),('person','character'),('safe','rating')])
    def test_tokenizer_is_lazy_and_reused(self):
        with tempfile.TemporaryDirectory() as folder:
            ns=worker_functions(Path(folder));created=[]
            class Tokenizer:
                def __init__(self,**kwargs):created.append(kwargs)
            with patch.dict(sys.modules,{'transformers':types.SimpleNamespace(BertTokenizer=Tokenizer)}):
                self.assertIs(ns['tokenizer'](),ns['tokenizer']())
            self.assertEqual(len(created),1);self.assertTrue(created[0]['do_lower_case'])

if __name__=='__main__':unittest.main()
