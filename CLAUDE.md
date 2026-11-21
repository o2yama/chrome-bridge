# chrome-bridge

このMacで起動中のChrome系ブラウザを、Claude Code / Codex から読み取り中心で操作するための拡張機能とCLI。2026-11-10 開始。

- 仕様は [docs/spec.md](docs/spec.md)。構成、メッセージ形式、コマンド、ガードはここだけに書く。
- 使い方と操作の許可範囲は、同梱のスキル [skills/chrome-bridge/SKILL.md](skills/chrome-bridge/SKILL.md) に書く。
- 依存パッケージは入れない（Node標準のみ）。テストは案件直下で `node --test`。
- 一時ファイルは `tmp/`。
