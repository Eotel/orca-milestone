# orca-milestone

[Orca](https://github.com/stablyai/orca) の plugin です。[orca-board](https://github.com/Eotel/orca-board) の ask と step を、ターミナル横のパネルに表示します。

## この fork の違い

[andoshin11/orca-milestone](https://github.com/andoshin11/orca-milestone) を、orca-board の core を使うクライアントに変えています。進捗の取得、次の作業の判断、lane への送信はボードが行います。パネルは core が返した内容を表示し、回答や選択を core に送ります。

ボードはこの Mac で起動しておく必要があります。既定の接続先は `http://127.0.0.1:7317` です。変更する場合は plugin 設定 `boardUrl` を書き換え、plugin を再起動します（`orca plugin restart eotel.milestone`）。ボードに接続できない間は接続先を 1 行で表示し、ステータスバーの件数を隠します。

## できること

- **ask に回答する:** フォーカス中の workspace の ask を新しい順に表示します。各質問で 1 つずつ選択して「回答を送信」を押します。選択肢のない ask には文章で回答できます。
- **step を見る:** ゴール、完了数、未完了の step を表示します。完了した step は「✓ 済み N」にまとめます。
- **次の作業を頼む:** ボードが返した提案を押すと、core が lane に送信します。ほかの workspace でも「Claude に送る」「Codex に送る」で最初の提案を送れます。
- **自分の番を見る:** ボードで自分の番になっている項目と件数を、ボードが付けた見出しで表示します。行を押すと workspace に移動します。ステータスバーを押すと、移動先のある最古の項目を開きます。
- **ボードを開く:** Orca のブラウザタブで全体のボードを開きます。plugin 設定 `boardWorkspace` の workspace（既定は `triage-lead`）を使い、見つからなければフォーカス中の workspace を使います。既存のボードタブがあれば切り替えます。

SSE と Orca のイベントで更新し、30 秒ごとにも取得します。表示が変わったときだけ DOM を更新するため、回答の選択や入力は更新後も残ります。ask が変更された場合は選択をクリアします。

## 必要なもの

- Orca 1.4.248 以上
- この Mac で動く orca-board（core API v1 対応）

Claude Code と Codex に対応しています。Orca から新しく起動したときに、次の設定をそのセッションだけに追加します。

| エージェント | 起動時の設定 |
|---|---|
| Claude Code | タスク用ツールを有効にし、ゴール付きのタスクを記録する指示を追加します。Agent Teams も同じです。既存の `--append-system-prompt` があれば追加しません。 |
| Codex | 進捗を記録する MCP ツール `update_progress` と指示を追加します。`~/.codex` の設定は変更しません。 |

保存したセッションの再開、Orca の外での起動、`orca terminal create --command` での起動には適用されません。Codex の進捗は `~/.orca-milestone/progress/` に記録し、ボードが読み取ります。

## インストール

1. Orca の **設定 → プラグイン → プラグインを追加 → Git URL から…** で `https://github.com/Eotel/orca-milestone` を指定します。
2. フルアクセスと権限を確認して有効化します。plugin のキーは `eotel.milestone` です。
3. 右サイドバーの旗アイコンを開きます。

| 権限 | 用途 |
|---|---|
| `workspace:read` | フォーカス中の workspace と移動先の特定 |
| `workspace:write` | workspace の移動 |
| `agent:read` | Agent ステータスの通知 |
| `settings:own` | `boardUrl`・`boardWorkspace` の取得 |

ボード用ブラウザタブの切替・作成には Orca 同梱の CLI を使います。依頼文の送信はボードの core API を使います。

## 表示されないとき

- 接続エラーが出る場合は、表示された URL でボードが起動しているか確認します。
- step が出ない場合は、ボード側にも step があるか確認します。
- 起動時の指示を反映するにはエージェントを新しく起動します。Codex の `update_progress` は進捗ファイルだけに書き込み、承認なしで動きます。

Codex の指示は `developer_instructions` で渡すため、Orca から起動したセッションでは既存の同じ設定を置き換えます。SSH 先の workspace とチャット表示での起動は未確認です。

## 開発

```sh
npm ci
npm test
ORCA_SOURCE_DIR=/path/to/stablyai/orca npm run check:manifest
node scripts/render-sample.mjs /tmp/milestone-sample.html
```

テストでは fetch、Orca host、CLI runner をモックします。実ボードや lane には接続しません。manifest の検証には Orca の checkout と、そこから参照できる `zod` が必要です。CI は v1.4.247 の parser を使います。

サンプルはダミーデータを使います。`--light` でライトテーマ、`--next` で次の作業を表示できます。

## ライセンス

[MIT](LICENSE)
