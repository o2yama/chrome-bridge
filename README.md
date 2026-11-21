# chrome-bridge

起動中のChrome系ブラウザを、コマンドライン `cb` から読み取り中心で操作する道具です。Chrome拡張機能、CLI、両者をつなぐNative Messagingホストの3つでできています。Claude Code や Codex などのエージェントに、自分が開いているタブを読ませる用途を想定しています。

拡張機能を読み込んだプロファイルだけが対象になります。TCPポートは開きません。

## 対応環境

- macOS
- Google Chrome と Arc
- Node.js 18 以上（依存パッケージなし）

## インストール

1. CLIを入れる。

   ```bash
   npm i -g github:o2yama/chrome-bridge
   ```

2. Native Messagingホストを登録する。最後に拡張機能のフォルダの絶対パスが表示される。

   ```bash
   cb install
   ```

3. 使いたいプロファイルで `chrome://extensions` を開き、「デベロッパー モード」をオンにする。
4. 「パッケージ化されていない拡張機能を読み込む」を押し、手順2で表示されたフォルダ（`extension`）を選ぶ。
5. シークレットウィンドウでも使うなら、拡張機能の「詳細」で「シークレット モードでの実行を許可する」をオンにする。
6. `cb browsers` に行が出れば完了。

手順3〜5はプロファイルごとに行います。`cb install` は、インストール先の `host/` に起動スクリプトを書き、Chrome と Arc のうち存在するものの `NativeMessagingHosts` にマニフェストを置きます。

## 基本の使い方

```bash
cb browsers                                  # 接続中のブラウザ一覧
cb tabs -b user@example.com                  # タブ一覧
cb read -b user@example.com -t 123456        # 本文を読む（続きは --offset）
cb elements -b user@example.com -t 123456    # 押せる要素の一覧（ref が付く）
cb scroll -b user@example.com -t 123456 --by 800
cb click -b user@example.com -t 123456 --ref 4
cb screenshot -b user@example.com -t 123456 --out shot.png
cb open https://example.com                  # 裏のタブで開く
```

- `-b` には、メールアドレス、プロファイル表示名、`cb label` で付けた呼び名、IDの先頭のどれかを渡します。接続が1つだけなら省略できます。
- `-t` には `cb tabs` で出る tabId を渡します。
- フォームを送信しうるクリックは `--user-approved`、入力欄のクリックは `--allow-input`、文字入力（`cb type`）は `--user-instructed` を付けないと拒否されます。
- ほかに、実際のマウス・キー入力（`click --real`、`hover`、`key`）、コンソールと通信の記録（`debug`、`console`、`network`）、ページ内でのJavaScript実行（`eval`）、画面幅の切り替え（`emulate`）、要素とCSSの検査（`inspect`、`style`）、計測（`perf`）、動作確認（`doctor`、`selftest`）があります。

全コマンドは `cb --help`、個別の使い方は `cb <コマンド> --help` で見られます。仕様は [docs/spec.md](docs/spec.md) にあります。

### エージェント用のスキル

Claude Code から使う場合は、同梱のスキルを `~/.claude/skills/` にリンクします。

```bash
ln -s "$(npm root -g)/chrome-bridge/skills/chrome-bridge" ~/.claude/skills/chrome-bridge
```

## 更新

1. `npm i -g github:o2yama/chrome-bridge` をもう一度実行する。
2. `cb install` をもう一度実行する（起動スクリプトが作り直される）。
3. `cb reload` か、拡張機能のポップアップの「拡張機能を再読み込み」で拡張機能を読み込み直す。

Node.js の場所が変わったとき（バージョン管理ツールで切り替えた、古いバージョンを消したなど）も、`cb install` をやり直してください。起動スクリプトは、`cb install` を実行した Node.js の絶対パスを使います。

## アンインストール

アンインストール用のコマンドはありません。次を手で消します。

1. `chrome://extensions` で拡張機能を削除する。
2. マニフェストを削除する。
   - `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.o2yama.chrome_bridge.json`
   - `~/Library/Application Support/Arc/User Data/NativeMessagingHosts/com.o2yama.chrome_bridge.json`
3. `npm rm -g chrome-bridge`
4. ソケットと失敗記録の置き場 `~/.chrome-bridge` を削除する。

## 権限と注意

強い権限を持つ道具です。入れる前に次を確認してください。

- 拡張機能は全サイトへのアクセス権限（`<all_urls>`）を持ちます。読み込んだプロファイルで開いているページは、ログイン中のサービスも含めてすべて読めます。
- 拡張機能は `debugger` 権限を持ちます。実際のマウス・キー入力、スクリーンショット、コンソールと通信の記録、画面幅の切り替えなどで、タブにデバッガを接続します。
- `cb eval` はページ内で任意のJavaScriptを実行できます。
- ブラウザの識別のために、プロファイルにログイン中のGoogleアカウントのメールアドレスを取得します（`identity.email` 権限）。メールアドレスは `cb browsers` などの出力に出ます。
- CLIとホストの間に認証はありません。ソケットは本人だけが読み書きできる権限（ディレクトリ700、ソケット600）で作りますが、同じOSユーザーで動くプロセスなら、どれでも命令を送れます。
- 送信系のクリックと入力の確認ガードは、誤操作を防ぐための最低線です。`cb eval` を使えば回避できるので、安全の境界にはなりません。
- `cb network --detail` は認証ヘッダーなどを伏せて返しますが、レスポンス本文は伏せません。

信頼できるマシンで、自分の責任で使ってください。共用のマシンや、信頼できないプログラムを動かす環境には向きません。

## 開発

```bash
npm test
```

## ライセンス

[MIT](LICENSE)
