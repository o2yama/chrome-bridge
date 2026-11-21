# chrome-bridge 境界仕様

Claude Code / Codex が、このMacで起動中のChrome系ブラウザを読み取り中心で操作するための拡張機能とCLI。
拡張機能を入れたプロファイルだけが対象になる。

## 構成

```
extension/   MV3拡張（manifest.json、background.js、ページ内で動かす関数）
host/        Native Messagingホスト（Node、依存なし）
bin/cb       CLI（Node、依存なし）
test/        node:test
```

```
cb ──UNIXソケット──> host ──Native Messaging(stdio)──> 拡張のservice worker ──> タブ
```

- 拡張はservice worker起動時に `chrome.runtime.connectNative("com.o2yama.chrome_bridge")` で常時接続する。切れたら再接続し、`chrome.alarms`（1分間隔）でも接続を確かめる。
- Chromeがプロファイルごとにhostプロセスを1つ起動する。hostは `~/.chrome-bridge/run/<hostのpid>.sock` で待ち受ける。ディレクトリは700、ソケットは600。stdinがEOFになったらソケットを消して終了する。
- TCPポートは開かない。実入力・撮影・復旧・検査には chrome.debugger を必要な間だけ接続する。debug と emulate の継続接続の寿命は「DevTools相当の機能」を参照。

## 拡張機能

- permissions: `tabGroups` `debugger` `tabs` `scripting` `identity` `identity.email` `alarms` `storage` `nativeMessaging`。host_permissions: `<all_urls>`。`"incognito": "spanning"`。
- manifestに `key` を入れて拡張IDを固定する。IDは `extension/EXTENSION_ID`（改行なしの32文字）に書き出す。秘密鍵は残さない。
- ページ内の処理は `chrome.scripting.executeScript`（isolated world）で行う。要素の参照は isolated world 内の配列で持ち、参照用のDOM属性は足さない。style add だけは明示された試し書き用の style 要素を追加する。

## メッセージ形式

cb→host、host→拡張とも同じJSON。cb⇄host間は改行区切り、host⇄拡張間はNative Messagingの4バイト長プレフィックス。

```
要求  {"id": "<任意の文字列>", "cmd": "<コマンド>", "args": {...}}
応答  {"id": "...", "ok": true,  "result": {...}}
      {"id": "...", "ok": false, "error": {"code": "...", "message": "...", "detail": {...}}}
```

hostは要求をそのまま拡張へ流し、同じidの応答を返す。30秒で `TIMEOUT`。
例外は `hello` だけで、hostが結果に `hostPid` と `browserApp`（親プロセスの実行ファイルパスから取ったアプリ名。例 `Google Chrome`、`Arc`）を足す。

## コマンド（拡張が実装する）

| cmd | args | result |
|---|---|---|
| `hello` | なし | `instanceId`（初回に生成して storage.local に保存するUUID）、`email`（`identity.getProfileUserInfo({accountStatus:"ANY"})`。未ログインは空文字）、`label`、`extensionVersion`、`incognitoAllowed`、`windows: {normal, incognito}`、`tabCount` |
| `setLabel` | `label` | `label` |
| `tabs` | なし | `tabs: [{tabId, windowId, groupId, index, active, windowFocused, incognito, title, url, status}]` |
| `read` | `tabId`, `mode`（`text` 既定 / `html`）, `selector?`, `allFrames?`, `offset?`（既定0）, `maxChars?`（既定100000） | `url`, `title`, `text`, `totalChars`, `truncated`, `scroll: {x, y, pageHeight, viewportHeight}` |
| `elements` | `tabId`, `inViewportOnly?` | `elements: [{ref, kind, tag, role, type, text, href, inForm, formAction, formMethod, disabled, inViewport}]` |
| `scroll` | `tabId` と、`by: {x, y}` / `to: "top" \| "bottom" \| {x, y}` / `ref` / `selector` のどれか1つ | `scroll`（readと同じ形） |
| `click` | `tabId`, `ref`, `allowRisky?`, `allowInput?` | `clicked`（elementsの1要素と同じ形） |
| `type` | `tabId`, `ref`, `text`, `userInstructed` | `typed: true` |
| `screenshot` | `tabId`, `full?` | `dataUrl`（PNG） |

- `elements` の対象は、a[href]、button、input、select、textarea、summary、`[role=button|link|tab|menuitem|checkbox|radio|switch]`、`[onclick]`、`[contenteditable]`。表示されていない要素は除く。`text` は見えている文言（aria-label、value、alt も候補）を120字まで。`ref` は呼び出しのたびに0から振り直し、次の `elements` かページ遷移まで有効。
- `kind` は `link` / `button` / `input` / `other`。input・select・textarea・contenteditable、それらに結び付いた label、`role` が checkbox / radio / switch / textbox / combobox / listbox / slider のものは `input`。パスワード欄の値は `text` に出さない。
- `screenshot` の撮影経路・full指定は「DevTools相当の機能」を参照。勝手にタブを切り替えない。

### 操作のガード（拡張側で強制する最低線）

| 条件 | 必要なフラグ | なければ返すcode |
|---|---|---|
| `click` の対象が `kind: input` | `allowInput: true` | `INPUT_BLOCKED` |
| `click` の対象がフォームを送信しうる（form内の `button`（type=button以外）、`input[type=submit\|image]`）、または `a[href]` で `javascript:` 以外のスキームが http(s) でない、または `download` 属性付き | `allowRisky: true` | `NEEDS_CONFIRMATION` |
| `type` | `userInstructed: true` | `INPUT_BLOCKED` |

拒否時の `error.detail` には対象要素の情報を入れる。このガードは最低線で、押してよいかの判断は呼び出し側（スキル）が先に行う。

### エラーcode

`NO_SUCH_REQUEST`（network detailの記録なし）、`NO_SUCH_TAB` `CANNOT_ACCESS_PAGE`（chrome:// やストアなど注入できないページ）`STALE_REF` `BAD_ARGS` `INPUT_BLOCKED` `NEEDS_CONFIRMATION` `TAB_NOT_ACTIVE` `TIMEOUT` `INTERNAL`

## CLI `bin/cb`

```
cb install                      Native Messagingホストのマニフェストを配置する
cb browsers [--json]            接続中のブラウザ一覧
cb label -b <sel> <名前>         プロファイルに呼び名を付ける
cb tabs [-b <sel>] [--json]     タブ一覧（-b なしなら全ブラウザをまとめて）
cb read -b <sel> -t <tabId> [--html] [--selector S] [--all-frames] [--offset N] [--max-chars N]
cb elements -b <sel> -t <tabId> [--viewport] [--json]
cb scroll -b <sel> -t <tabId> (--by Y | --top | --bottom | --ref N | --selector S)
cb click -b <sel> -t <tabId> --ref N [--user-approved] [--allow-input]
cb type -b <sel> -t <tabId> --ref N --text "..." --user-instructed
cb screenshot -b <sel> -t <tabId> --out <path.png> [--full]
```

- `-b <sel>` は、instanceIdの前方一致、メールアドレス・label・プロファイル表示名の部分一致（大文字小文字を無視）で1つに決まるものを選ぶ。接続が1つだけなら省略できる。複数あって未指定、または複数に一致したら、候補一覧を出して終了コード2で終わる。
- `browsers` の1行は、instanceIdの先頭8文字、ブラウザ名、プロファイル表示名、メール、label、通常/シークレットのウィンドウ数、タブ数、`incognitoAllowed`。
- プロファイル表示名は、`browserApp` に対応するユーザーデータディレクトリの `Local State` の `profile.info_cache` から、`user_name` が `email` と一致するものの `name` を引く（Google Chrome は `~/Library/Application Support/Google/Chrome`、Arc は `~/Library/Application Support/Arc/User Data`）。見つからなければ空。
- `tabs` の1行は、tabId、`*`（前面）、`[secret]`（シークレット）、タイトル、URL。`-b` なしのときは、ブラウザごとに `# ` で始まる見出し行（`browsers` と同じ内容）を先に出す。
- `elements` の1行は、ref、kind、`tag:type`、文言、href、`form:メソッド 送信先`、`disabled`。
- `read` は本文をstdoutに、タイトル・URL・全体の文字数・続きの有無をstderrに出す。
- `--user-approved` は `allowRisky`、`--allow-input` は `allowInput`、`--user-instructed` は `userInstructed` に対応する。
- つながらないソケット（残骸）は一覧時に消す。
- 成功は終了コード0、拡張からのエラーは1（stderrに `code: message`、`--json` 時はJSON）、使い方の誤りと選択の曖昧さは2。

### `cb install`

- ホスト名は `com.o2yama.chrome_bridge`。マニフェストの `path` は `host/run-host.sh`（install時に生成。`process.execPath` の絶対パスで `host/host.js` を exec する。実行権限を付ける）。`allowed_origins` は `extension/EXTENSION_ID` から作る。
- 配置先は、存在するものだけ。`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` と `~/Library/Application Support/Arc/User Data/NativeMessagingHosts/`。
- 何度実行しても同じ結果になる。配置したパスを表示し、続けて拡張機能を読み込む手順と `extension/` の絶対パスを表示する。

## v2 追加（2026-11-10）

実入力とデバッグのため `chrome.debugger`（CDP 1.3）を使う。「TCPポートは開かない」は維持し、「chrome.debugger も使わない」は撤回する。
デバッガは必要なコマンドの間だけタブに接続し、終わったら外す。`debugStart` と `emulate` は接続を共有し、それぞれの利用が終わるまで保つ。詳細は「DevTools相当の機能」を参照。

### 拡張機能

- permissions に `debugger` を足す。`action.default_popup` は `popup.html`。
- `hello` の result に足すもの: `chromeVersion`（例 `142.0.7444.60`）、`verified`（`{chromeVersion, ok, failures: [項目名], at}`。未実施は null）、`debugTabs`（デバッガ接続中の tabId 一覧）。
- 起動時と `selftestResult` 受信時に、現在のChromeのメジャーバージョンが `verified.chromeVersion` のメジャーと違う、または `verified.ok` が false なら、アイコンにバッジ `!` を出す。一致していれば消す。
- ポップアップ（popup.html / popup.js）: ホストとの接続状態、メール、拡張バージョン、Chromeバージョン、確認状況（確認済み / 未確認 / 失敗した項目名）を表示する。ボタンは2つ。「拡張機能を再読み込み」（`chrome.runtime.reload()`）と「このChromeで動作確認」（ホストへ `{"event": "selftestRequested", "instanceId": "..."}` を送る。id を持たないイベントメッセージ）。動作確認中は結果が届くまで待機表示にする。外部リソースは読み込まない。

追加コマンド:

| cmd | args | result |
|---|---|---|
| `open` | `url`（http / https / file のみ）, `tabId?`（あればそのタブを移動）, `front?`（true のときだけ対象タブを前面にする。既定 false）、`new?`（true なら必ず新規作成）、`background?`（互換用。無視） | `tabId`, `url`, `title`（新規作成・移動時は読み込み完了か15秒まで待つ）, `reused` |
| `nav` | `tabId`, `action`（`back` / `forward` / `reload`）, `noCache?`（reloadのみ） | `tabId`, `url`, `title` |
| `close` | `tabId` | `closed: true`。このservice workerの `open` が新しく作ったタブだけ閉じられる。それ以外は `NOT_OWNED` |
| `activate` | `tabId` | 実装済み |
| `reload` | なし | 実装済み |
| `click` に追加 | `real?` | true なら CDP の `Input.dispatchMouseEvent`（移動→押下→解放）を要素の中心に送る。先に要素を画面内へスクロールする。ガードは従来と同じ |
| `hover` | `tabId`, `ref` | `hovered`（要素情報）。CDP のマウス移動だけを送る。ガードなし |
| `key` | `tabId`, `key`（`Enter` `Escape` `Tab` `Space` `ArrowUp/Down/Left/Right` `PageUp` `PageDown` `Home` `End` `Backspace` `Delete`、または `Meta+a` のような修飾キー付き）, `allowRisky?`, `allowInput?` | `pressed: key`。CDP の `Input.dispatchKeyEvent` |
| `type` に追加 | `real?` | true なら対象にフォーカスして CDP の `Input.insertText` で入れる。`userInstructed` は従来どおり必須 |
| `debugStart` | `tabId` | `attached: true`。Runtime・Log・Network を有効にして記録を始める |
| `debugStop` | `tabId` | `detached`（emulate継続中はfalse） |
| `console` | `tabId`, `pattern?`（正規表現）, `clear?` | `messages: [{level, text, url, line, at}]`。新しいものから最大1000件を保持 |
| `network` | `tabId`, `pattern?`（URLへの正規表現）, `clear?`, `detail?`, `maxChars?` | 一覧は `requests: [{requestId, method, url, status, type, at, failed}]`、最大1000件。詳細形式と秘匿規則は「DevTools相当の機能」を参照 |
| `eval` | `tabId`, `expression` | `value`（JSON化できる値。文字列化して10万字まで）, `exception?`。CDP の `Runtime.evaluate`（ページ本体の世界、awaitPromise）。一時接続で動く |
| `selftestResult` | `chromeVersion`, `ok`, `failures` | 保存して `verified` を返す |

`console` と `network` は `debugStart` していないタブでは `NOT_DEBUGGING` を返す。

`key` のガード（押す前にページ内でフォーカス中の要素を調べる）:

| 条件 | 必要なフラグ | code |
|---|---|---|
| `Enter` で、フォーカス中の要素が form 内にある、または送信しうる要素 | `allowRisky` | `NEEDS_CONFIRMATION` |
| `Space` `Backspace` `Delete` で、フォーカス中の要素が `kind: input` | `allowInput` | `INPUT_BLOCKED` |
| 修飾キーなしの1文字キー、`Meta+v` `Ctrl+v`（貼り付け） | `allowInput` | `INPUT_BLOCKED` |
| それ以外（Escape、Tab、矢印、PageUp/Down、Home、End、form 外の Enter など） | なし | |

追加エラーcode: `NOT_OWNED` `NOT_DEBUGGING` `DEBUGGER_FAILED`（接続できない。DevToolsを開いているタブなど。`detail.cause` に理由）

### ホスト

- 拡張からの id なしメッセージ `{"event": "selftestRequested", "instanceId"}` を受けたら、`bin/cb selftest -b <instanceId>` を切り離した子プロセスで起動する。それ以外の event は無視する。

### CLI

```
cb open [-b <sel>] <url> [--tab <tabId>] [--front] [--new]
cb nav -b <sel> -t <tabId> (--back | --forward | --reload [--no-cache])
cb close -b <sel> -t <tabId>
cb click ... [--real]
cb hover -b <sel> -t <tabId> --ref N
cb key -b <sel> -t <tabId> <key> [--user-approved] [--allow-input]
cb type ... [--real]
cb debug (start | stop) -b <sel> -t <tabId>
cb console -b <sel> -t <tabId> [--pattern RE] [--clear] [--json]
cb network -b <sel> -t <tabId> [--pattern RE] [--clear] [--json]
cb eval -b <sel> -t <tabId> <式>
cb doctor [--json]
cb selftest -b <sel>
```

- 失敗の記録: 拡張が返したエラーのうち、`INTERNAL` `TIMEOUT` `TAB_NOT_RESPONDING` `DEBUGGER_FAILED` `CANNOT_ACCESS_PAGE` `STALE_REF` を `~/.chrome-bridge/log/failures.jsonl` に1行ずつ追記する。項目は `at` `cmd` `code` `message` `cause`（detail.cause）`chromeVersion` `browserApp` `urlHost`（分かるとき。対象タブのホスト名だけ）。引数やページの中身は書かない。500行を超えたら古い行を捨てる。
- `cb doctor`: ブラウザごとに、Chromeバージョン、確認状況（確認済み / 未確認 / 失敗項目）、デバッガ接続中のタブを出し、続けて failures.jsonl の直近20件を出す。
- `cb selftest`: `127.0.0.1` の空きポートに一時HTTPサーバーを立て、`test/fixtures/selftest.html` を配る。そのタブを 既定の裏タブとして `open` で開き、下の項目を順に試し、最後に `close` でタブを閉じてサーバーを止める。項目ごとに ok / NG と理由を出し、`selftestResult` を拡張へ送る。全部通れば終了コード0、1つでも落ちれば1。
  - 項目: `read` `elements` `scroll` `click`（表示が変わる）`click-guard`（フォーム送信ボタンが `NEEDS_CONFIRMATION` で拒否され、サーバーにPOSTが届いていない）`input-guard`（入力欄クリックが `INPUT_BLOCKED`）`click-real` `hover`（ホバーで出る要素が出る）`key`（Escape をページが受け取る）`key-guard`（form 内で Enter が拒否される）`type`（`--user-instructed` で値が入る）`type-real` `eval` `console` `network` `nav`（reload 後に読める）
  - テストページは操作の結果を `document.body.dataset` や本文に書き、selftest は `read` / `eval` でそれを確かめる。フォームの送信先は一時サーバー自身で、POSTを受けたら記録する。

## v3 追加（2026-11-11）

- 新規の `open` は、最後にフォーカスのあった通常ウィンドウ（`windows.getLastFocused({windowTypes:["normal"]})`）に非アクティブなタブを作る。`front: true` / CLI `--front` だけが前面化する。`--background` は受け付けて無視する。`--tab` による既存タブの移動は従来どおり。
- `open` は新規作成前に、そのプロファイルの全通常ウィンドウから同じURLのタブを探して再利用する。比較時はhashを除去し、ルート以外のpathname末尾の `/` を除去し、ホストを小文字化する。クエリ・スキーム・ホストはそのほか変更せず、パースできないURLは文字列の完全一致とする。Bridgeが作成したタブは現在URLに加えて作成時の要求URLでも照合し、その記録は所有権管理と同じ寿命で保持する。候補はBridgeが作成したタブを優先し、同順位なら `lastAccessed` が大きいものを選ぶ。
- 再利用時はリロード、グループ移動、前面化を行わず、`--front` のときだけ前面化する。`--new` は再利用せず必ず新規作成する。`--tab` は再利用判定の対象外とする。結果の `reused` は再利用時にtrue、それ以外はfalse。ユーザーのタブを再利用しても所有権は移らず、`close` の所有権チェックは変わらない。
- 新規タブはタイトル `Bridge`、色 `orange` のグループへ入れる。ウィンドウごとに既存の同名グループを再利用し、消えていれば作る。作成・検索・グループ化を直列化し、同時 open によるグループ重複を防ぐ。グループ化に失敗した場合は今回作ったタブだけを閉じてエラーにする。`close` の所有権チェックは維持する。
- 実入力の前に `Page.setWebLifecycleState({state:"active"})` と `Emulation.setFocusEmulationEnabled({enabled:true})` を送る。`ensureFront` は呼ばない。一時接続は finally で解除し、debugStart / emulate による継続接続では操作後にフォーカスエミュレーションを無効化する。
- executePage の `TAB_NOT_RESPONDING` 時は、CDPで active にして注入を1回やり直す。CDP接続・復旧が失敗した場合（`DEBUGGER_FAILED` を含む）、または再試行もタイムアウトした場合だけ従来の ensureFront に落とす。CDP操作の内部では既存の接続を使い、接続キューへ再入しない。タイムアウト済み注入の `abandoned` による二重実行防止は維持する。
- screenshot は前面化しない。撮影経路・フォールバックは「DevTools相当の機能」を参照。裏で撮れなければ `TAB_NOT_ACTIVE`（detail に原因）を返す。
- click は `ref` または有限数値の `x, y` を排他的に受け取る。CLI は `cb click -b <sel> -t <id> --xy X,Y`。座標はビューポート座標で、real 指定によらず実入力になる。elementFromPoint の要素と、イベントが伝播する祖先に既存の guardClick を適用する。要素がなければ NEEDS_CONFIRMATION。入力・送信の許可フラグは従来どおり。
- tabs の要素に `groupId` を追加する。selftest に `group`、`screenshot-bg`（PNGシグネチャ）、`click-xy`（isTrustedなクリック）、`no-focus-steal` を追加する。開始時に各ウィンドウのアクティブタブを記録し、各項目後と最後に一致を確認する。通常の操作結果は read で取得し、デバッガに依存しない項目を独立に判定する。

### 実機で確認した事実

2026-11-11、Google Chrome 157.0.8103.38、127.0.0.1 の selftest ページで確認。

- user@example.com のプロファイル: 実クリック、座標クリック、hover、Escapeキー、type --real のすべてが前面化なしで届いた。裏タブPNG撮影と全項目後の前面タブ維持も成功。
- 前面化しないと届かなかった操作は、今回試した範囲ではなかった。したがって操作種別ごとの前面化フォールバックは追加していない。CDPの成功応答だけでは任意サイトの処理完了を保証できないため、自動再送はしない。
- work のプロファイル: 今回の selftest ではデバッガ接続にも成功し、全20項目が成功した。別の拡張機能が差し込むフレームによる DEBUGGER_FAILED は今回再現しなかった。
- 自然発生の休止・凍結タブは今回の実機試験では再現していない。CDP復旧成功、接続失敗後の前面化、復旧後もタイムアウトする場合の前面化、abandoned、接続解除は node:test の模擬APIで検証する。ユーザーの既存タブを使った試験はしていない。

CDPメソッドの定義: [Emulation](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/)、[Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/)。


## DevTools相当の機能（2026-11-13）

追加するコマンドも既存の要求・応答エンベロープを使う。hostは透過転送するだけで、新しい依存パッケージや権限は追加しない。inspect / style / perf / emulate は読み取り・表示系として扱い、click / key / type の送信確認・入力ブロックを変更しない。

### CLI

```
cb emulate -b <sel> -t <id> [--preset sp|tablet|pc] [--size WxH] [--dpr N] [--mobile] [--touch] [--color-scheme light|dark] [--reduced-motion] [--json]
cb emulate -b <sel> -t <id> --reset [--json]
cb screenshot -b <sel> -t <id> --out <path.png> [--full]
cb inspect -b <sel> -t <id> (--selector <css> | --ref N) [--props a,b,c] [--rules] [--json]
cb style add -b <sel> -t <id> --css '<css>' [--json]
cb style clear -b <sel> -t <id> [--id <id>] [--json]
cb network -b <sel> -t <id> --detail <requestId> [--max-chars N] [--json]
cb nav -b <sel> -t <id> --reload --no-cache
cb perf -b <sel> -t <id> [--json]
```

- 新コマンドの結果は既定でJSONをstdoutに出す。`--json` 指定時は拡張のエラーもJSONでstderrに出す。screenshotは従来どおりPNGを書き出して出力先を表示する。
- `cb --help` / `cb help` はコマンド一覧、`cb <command> --help` はその使い方を表示し、ブラウザへの接続なしで終了コード0。引数なし・不明なコマンドでは一覧を表示して終了コード2。
- `--size` は正の整数 `WxH`（各辺10000000以下）、`--dpr` は有限の正数。presetと個別指定を併用でき、個別指定を優先する。設定指定なしのemulate、および `--reset` と設定の併用は `BAD_ARGS`（CLIでは終了コード2）。
- `--selector` と `--ref` はどちらか一方。`--props` は空でないプロパティ名のカンマ区切り。`style add` は `--css` 必須、`style clear` の `--id` 省略は全件削除。
- `network --detail` は `--pattern` / `--clear` と併用できない。`--max-chars` はdetail指定時だけ使える0以上の整数で、0なら本文を出さず長さを返す。`--no-cache` は `--reload` 専用。

### emulateと接続の寿命

要求は `{"cmd":"emulate","args":{"tabId":123,"preset":"sp"}}`。argsには `preset?`, `width?`, `height?`, `dpr?`, `mobile?`, `touch?`, `colorScheme?`, `reducedMotion?`, `reset?` を持つ。CLIの `--size` はwidth/height、`--color-scheme` はcolorScheme、`--reduced-motion` はreducedMotionに対応する。

| preset | width × height | dpr | mobile | touch |
|---|---|---|---|---|
| sp | 390 × 844 | 3 | true | true |
| tablet | 820 × 1180 | 2 | true | true |
| pc | 1440 × 900 | 1 | false | false |

- 設定はタブ単位で保持する。再指定では既存設定に指定した項目を重ね、presetは寸法・dpr・mobile・touchをまとめて上書きする。色・動きの指定だけでも継続接続する。
- `Emulation.setDeviceMetricsOverride`、`Emulation.setTouchEmulationEnabled`、`Emulation.setEmulatedMedia` を使う。colorSchemeは `prefers-color-scheme`、reducedMotionは `prefers-reduced-motion: reduce` に対応する。
- 結果は `{emulating:true, settings:{width?,height?,dpr,mobile,touch,colorScheme?,reducedMotion?}, innerWidth,innerHeight}`。innerWidth/innerHeightはページ内の実測値であり、viewportメタタグ等によって指定寸法と異なることがある。ウィンドウのサイズやアクティブタブは変更しない。
- `reset:true` は `Emulation.clearDeviceMetricsOverride`、touch無効、media/features空を送る。結果は `{emulating:false, innerWidth,innerHeight}`。他に継続用途がなければ切断する。
- 接続・操作・解除は既存のタブ単位キューで直列化する。debugとemulateは単一のchrome.debugger接続を共有する。`debugStop` は記録を終了してもemulate中なら切断せず、`emulate --reset` もdebug中なら切断しない。一時接続の操作は両方の継続状態を尊重し、接続を二重に取得しない。
- 設定の更新・resetに失敗した場合は直前のエミュレーション設定への復元を試み、初回失敗では設定解除と接続解放を試みる。debugの共有接続は維持する。
- 継続接続中はChromeのデバッガ接続バナーが残る。タブを閉じる、ユーザーがバナーから切断する、拡張を再読み込みすると、接続・emulate設定・デバッグ記録を破棄する。切断後に自動でエミュレーションを復元しない。

### screenshot / nav

- `screenshot` のargsに `full?:boolean` を追加し、resultは従来どおり `{dataUrl:"data:image/png;base64,..."}`。
- 通常の前面タブは `tabs.captureVisibleTab`。その失敗時（image readback failed等）は自動的に `Page.captureScreenshot` に切り替える。裏タブ・emulate中・full指定時は最初からCDPを使う。
- fullは `Page.getLayoutMetrics` のコンテンツ領域（CSS座標の `cssContentSize`、未対応時は `contentSize`）をclipにして、`captureBeyondViewport:true` でページ全体を撮る。タブ・ウィンドウは前面化せず、サイズも変更しない。
- `nav` の `noCache:true` は `Page.reload({ignoreCache:true})` を送る。通常reload/back/forwardは従来の経路を保つ。

### network detailとredaction

一覧にも `requestId` を含める。リダイレクトで同じrequestIdが複数行に現れた場合、detailは最新の遷移先を返す。`{"cmd":"network","args":{"tabId":123,"detail":"123.4","maxChars":20000}}` はdebug start中に記録した要求を返す。debug未開始は `NOT_DEBUGGING`、記録にないrequestIdは `NO_SUCH_REQUEST`。

結果は `{requestId,method,url,status,type,at,failed,requestHeaders,responseHeaders,mimeType,body,truncated,totalChars?,bodyUnavailable?}`。ヘッダーは記録時に保持し、一覧には含めない。本文はdetail時に `Network.getResponseBody` で取得し、既定20000字まで返す。bodyは文字列またはnull、truncatedは打ち切り有無、totalCharsは取得できた本文全体の長さ。

- 対象MIMEは `text/*`、JSON、XML、JavaScript、form、GraphQLと `+json` / `+xml`。非テキストは `body:null, bodyUnavailable:"non-text"`。本文取得に失敗した場合もヘッダー等は返し、`bodyUnavailable:"unavailable"` とする。
- ヘッダー名は大文字小文字を無視する。Authorization、Proxy-Authorization、Cookie、Set-Cookieの完全一致、`X-` で始まりTokenを含む名前、`api-key` / `api_key` / `apikey` を含む名前の値を `[redacted]` に置換する。
- URLのクエリ名に `token` / `key` / `secret` / `code` / `password` を含む場合（大文字小文字を無視、URLデコード後に判定）、値を `[redacted]` にする。URLのユーザー名・パスワードも伏せる。非秘密ヘッダーの値に含まれるhttp(s) URLにも同じクエリの処理を適用する。Location / Content-Location / Referer / Referrer は相対URLも対象とし、percent encodedのクエリ名もデコードして判定する。相対URLのパス・通常のクエリ・fragmentは維持する。
- 一覧・詳細のURLと保持するヘッダーに適用する。requestId、ステータス、MIMEは維持する。本文そのものは任意のテキストであり、秘密情報を推測して置換する処理は行わない。
- 記録は従来どおり最新1000件。clear・debug stop・切断・タブ削除で捨てる。Chrome側で既に破棄された本文は取り戻せない。


### inspect

要求は `{"cmd":"inspect","args":{"tabId":123,"selector":".card","props":["display","color"],"rules":true}}`。selectorの代わりに `ref` を指定でき、elementsが返したrefをそのまま使う。対象は最初の一致要素で、件数も返す。

結果は `{count,element,rect,box,computed,url,rules?}`。

- elementは `{tag,id,classes,ref?}`、rectはgetBoundingClientRectの `{x,y,top,right,bottom,left,width,height}`（CSS px）。boxは `{margin,padding,border}` でそれぞれ `{top,right,bottom,left}` のcomputed値。borderは各辺のborder-width。
- computedはCSSプロパティ名から値への辞書。props省略時はdisplay、position、width、height、margin、padding、font-size、color、background-color、transform、z-index、opacity、visibility。props指定時は指定分だけ返す。
- selectorに一致しない場合は `{count:0,element:null}`（rules指定なら `rules:[]` も付く）。無効なCSSセレクタは `BAD_ARGS`、期限切れrefは `STALE_REF`。
- rulesは `CSS.getMatchedStylesForNode` で取得する。各ルールは `{selector,origin,sourceURL,line,inherited,declarations}`。inheritedは0が対象自身、1以上が祖先の深さ。inline styleとpresentational attributesも含める。lineは1始まり、不明ならnull。
- 宣言は `{name,value,important,disabled,parsedOk,line,overridden,inactive?,overriddenProperties?}`。overriddenはtrueが全項目で上書き済み、falseが有効な項目あり、nullが判定不能。shorthandが一部だけ上書きされた場合はoverriddenPropertiesにそのlonghand名を返す。無効・無効化された宣言や不成立の条件はinactiveで区別する。
- 判定にはimportance、origin、inline、specificity、CDPのcascade順、longhand展開を使う。layer / scope / container条件はCDPの順序に従い、importantではlayer順を反転しinlineを優先する。祖先の継承適用、starting-style、revert / revert-layer、animation / transition、競合するinjected origin（author / userの判別不能）など確定できない場合はnullを返し、computed値との単純比較で断定しない。
- 対象の参照はisolated worldからCDPのDOMノードへ解決し、DOMに識別用属性を追加しない。DOM/CSSは検査の間だけ有効にし、成功・失敗のどちらでも解除する。debug中に有効なRuntimeは維持する。

### style

要求は `{"cmd":"style","args":{"tabId":123,"action":"add","css":"body { color: red; }"}}`。`<style data-chrome-bridge="UUID">` をページのhead（なければdocumentElement）に差し込み、`{id,added:true}` を返す。

clearの要求は `{"cmd":"style","args":{"tabId":123,"action":"clear","id":"UUID"}}`。id省略なら `style[data-chrome-bridge]` をすべて外し、`{removed,ids}` を返す。該当IDがなければremovedは0。既存ページのstyle要素は変更しない。

変更はそのページだけに留まり、リロードで消える。サーバーのファイルや保存APIは変更しない。CSSにurl()や@importがあれば通常のブラウザのCSS処理による読み込みは起こりうる。

### perf

要求は `{"cmd":"perf","args":{"tabId":123}}`。結果は `{metrics,lcp,cls,fcp,ttfb,resourceCount,transferSize}`。

- metricsは `Performance.getMetrics` からTimestamp、Documents、Frames、JSHeapUsedSize、JSHeapTotalSize、Nodes、LayoutCount、RecalcStyleCount、LayoutDuration、RecalcStyleDuration、ScriptDuration、TaskDuration、TaskOtherDuration、ThreadTime、ProcessTimeのうち取得できた項目を返す。ヒープはbyte、duration類はCDPの秒、count類は件数。Performanceドメインは取得中だけ有効にする。
- ページ内のPerformanceObserverをbufferedで一時登録し、LCP、layout-shift、paintを収集して解除する。lcpは `{value,element}`、elementは `{tag,id,classes,text}`（説明文は120字まで）、要素不明時はnull。lcp.value、fcp、ttfbの単位はmsで、Navigation Timing基準。
- clsはrecent inputによるshiftを除外し、1秒未満の間隔・最大5秒のセッションウィンドウで合計した最大値。観測対象が未対応ならnull、対応してshiftなしなら0。
- fcpはfirst-contentful-paint、ttfbはnavigationのresponseStart - startTime。未観測の値はnull。LCPは取得時点の最新値で、読み込み中の最終値を保証しない。
- resourceCountとtransferSizeはResource Timingに残るリソースの件数とtransferSizeの合計（byte）。navigationは含まない。バッファ上限やcross-originの公開制限により、ページの全通信量と一致するとは限らない。
