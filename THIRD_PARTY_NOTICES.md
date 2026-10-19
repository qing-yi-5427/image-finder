# 第三方组件

产品界面沿用用户交付的 Image Finder React 原型组件/最终样式，已移除48张模拟数据、占位图集、模拟任务计时器和演示入口。原始zip保留，安全解压参考目录不进入产品包。

React、ReactDOM采用MIT许可证，Lucide React采用ISC并保留其Feather来源说明；运行依赖包中保留各自LICENSE。Vite/@vitejs/plugin-react采用MIT，TypeScript采用Apache-2.0；这些为构建工具，不是远程宿主运行库。测试使用playwright-core，不随产品运行。

SQLite驱动better-sqlite3、sharp及Electron等组件的许可证随各自安装包保留。应用未声明整体开源许可。图片版权归各自权利人。

## 本地 AI 模型与词表

WD 使用官方 [SmilingWolf/wd-eva02-large-tagger-v3](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3/tree/b25b82a03f7282e41aa2f257a52c7583b710bd1c)，固定 revision `b25b82a03f7282e41aa2f257a52c7583b710bd1c`。模型卡声明 Apache-2.0；完整 [Apache License 2.0](resources/ai/licenses/WD-Apache-2.0.txt) 和 [固定版本模型卡](resources/ai/licenses/WD-MODEL-CARD.md) 随源码及运行时保留。模型转换和调用不改变原权重许可证。

中文语义使用官方 [OFA-Sys/chinese-clip-vit-base-patch16](https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/tree/36e679e65c2a2fead755ae21162091293ad37834)，固定 revision `36e679e65c2a2fead755ae21162091293ad37834`，本地转换为图像/文本 FP32 ONNX。Chinese-CLIP 官方项目采用 MIT，完整 [许可及版权声明](resources/ai/licenses/Chinese-CLIP-MIT.txt) 和 [模型卡](resources/ai/licenses/Chinese-CLIP-MODEL-CARD.md) 随包保留，许可来源固定为官方仓库 commit `31863c707501bf1605d36842f43deb78793dbc5d`。

WD 中文显示使用 [ffdkj/Danbooru 中英文对照表](https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table/tree/5a0f6bcd436ae7548884dbfcd81c09090f1d4762)，固定 commit `5a0f6bcd436ae7548884dbfcd81c09090f1d4762`，MIT。保留完整 [MIT 许可](resources/ai/licenses/Translation-MIT.txt) 和 [上游说明](resources/ai/licenses/Translation-README.md)。从原表提取 WD 交集到 `resources/ai/wd-translations.json`：10,861 个 WD 词条中，10,563 个有中文显示名，覆盖率约 97.26%，其余英文回退。上游明确采用 Gemini 翻译加人工纠错，不能将整表描述为已全部人工核准；应用允许用户纠正，且不会按中文译名自动合并角色。

便携包对应完整资源位于 `resources/ai-runtime/licenses/`，模型卡与许可文件名同上。独立 Python 的 PSF 许可及 PyTorch、Transformers、ONNX、ONNX Runtime、NumPy、Pillow 等依赖的许可随各自运行时目录保留。安装器使用固定模型 revision、下载大小和 SHA-256。


## SauceNAO 接入参考

SauceNAO 查询与候选人工审核的设计参考了 [qing-yi-5427/astrbot-plugins 的图片来源插件](https://github.com/qing-yi-5427/astrbot-plugins/tree/main/plugins/astrbot_plugin_qing_image_source)（MIT）。本项目独立实现了固定 HTTPS 请求、原图预览压缩、官方 Pixiv ID 校验、持久队列与人工确认；未引入 AstrBot 或执行其代码。SauceNAO 服务由其运营方提供。
