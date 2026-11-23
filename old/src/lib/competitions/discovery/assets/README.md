# DeepSeek V4.1 tokenizer

This server-only asset is copied unchanged from DeepSeek's official repository:

https://github.com/deepseek-ai/deepseek-recipe/blob/main/static/tokenizers/v41/tokenizer.json

Retrieved 2026-11-19. SHA-256:
`81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99`.

The source repository is distributed under the MIT License, reproduced in
`LICENSE.txt`. The official tokenizer usage instructions are at
https://github.com/deepseek-ai/deepseek-recipe/blob/main/docs/tokenizer.md.

Local live acceptance observed a 32,768-token user-input limit on the hosted
web-search endpoint. The general model's published 1M context size does not
override that observed endpoint limit. Application checks count the complete
system and user messages and reserve another 512 tokens for protocol overhead.

This asset is used locally through the existing Hugging Face tokenizer runtime.
No tokenizer download or paid API request is required during startup or checks.
