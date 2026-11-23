# 第三方内容与许可范围

根目录[MIT许可](LICENSE)只适用于本项目原创代码，不覆盖第三方代码、模型相关资产、品牌/联系素材或赛事资料，也不改变它们原有的版权与授权条件。

## DeepSeek V4.1 tokenizer

两个版本都保留了独立的第三方文件及原许可：

| 版本 | 文件与说明 | 原许可 |
| --- | --- | --- |
| old | [assets/README.md](old/src/lib/competitions/discovery/assets/README.md)、`deepseek-v41-tokenizer.json` | [assets/LICENSE.txt](old/src/lib/competitions/discovery/assets/LICENSE.txt) |
| new | [assets/README.md](new/src/lib/competitions/discovery/assets/README.md)、`deepseek-v41-tokenizer.json` | [assets/LICENSE.txt](new/src/lib/competitions/discovery/assets/LICENSE.txt) |

随附说明记录该tokenizer取自DeepSeek官方仓库，获取日期为2026-11-19，SHA-256为：

```text
81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99
```

来源：[deepseek-ai/deepseek-recipe tokenizer](https://github.com/deepseek-ai/deepseek-recipe/blob/main/static/tokenizers/v41/tokenizer.json)。原许可为MIT，原版权声明为 `Copyright (c) 2026 DeepSeek`，完整文本保留在上述 `LICENSE.txt`，未替换成本项目版权声明。这份许可说明不代表对DeepSeek模型、托管API或其他未随附资产作出授权。

该tokenizer由应用在本机离线使用，不是服务密钥或模型权重。

## 软件依赖与运行工具

Next.js、React、TypeScript、PostgreSQL客户端、Hugging Face Transformers、Sharp等依赖由各版本的 `package.json`、`pnpm-lock.yaml` 记录，遵循各自的软件许可。安装后应保留各依赖包随附的许可证与通知；本文件不把所有依赖统一标为MIT，也不是完整的依赖许可证审计。

Node.js、pnpm、PostgreSQL运行工具未随源码仓库分发。使用者自行准备工具时，应同时保留所用发行包的许可证、通知与必要文件。

## 品牌、二维码、海报与赛事证据

赛途/乐乐品牌图像、Emily已公开的联系二维码、竞赛组队二维码、赛事海报、第三方网页及截图、章程/规则摘录和其他证据材料，用于保留网站展示及资料来源上下文；不随原创代码一并转为MIT许可。其权利与可使用范围仍由相应权利人和原授权决定，公开可见本身不等于通用转载或商业使用授权。

源码中的赛事资料和必要 `artifacts` 保留原届次、适用范围、来源与待核状态，不代表赛事主办方背书或当前可报名。来源链接不替代原文，也不保证外部页面或历史二维码长期有效。
