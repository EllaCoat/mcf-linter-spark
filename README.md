# mcf-linter-spark

Minecraft: Java Edition 1.20.3〜26.3 のデータパックの `.mcfunction` と JSON を検査する linter です。Datapack Helper Plus 3.x（DHP）の lint 設定と [IMP-Doc](https://github.com/SpyglassMC/Spyglass/wiki/IMP-Doc) の公開範囲に沿って診断し、CI 用のコマンドと VSCode 拡張機能（language server）の両方で動きます。

- 検査するバージョンは設定の `datapack.env.cmdVersion` で指定します。指定が無ければ `spyglass.json` の `env.gameVersion` を使い、どちらも無ければ 1.20.4 です。
- 指定できるのは 1.20.3〜26.3 のリリースです。コマンドの一覧と書き方、registry、データパックのディレクトリ名と JSON の種類、NBT と JSON の型は、そのバージョンのものを使います。1.20.3 は 1.20.4 のデータで検査します。
- バージョンの指定が無いのに、1.21 からの単数形のディレクトリ（`function/` など）があるデータパックでは、コマンドと VSCode 拡張機能がそのことを知らせます。

## 検査する内容

コマンドと JSON をゲームの規則に合わせて解析し、`.vscode/settings.json` の `datapack.lint.*` を DHP と同じ意味で適用します。

- コマンド：指定したバージョンのコマンドツリーに沿って、セレクター、SNBT、NBT パス、ブロックステート、item の components と item predicate、テキスト、マクロ行（`$`）の `$(name)` を検査します。1.21.5 からの新しい SNBT や SNBT のテキストなど、書き方もバージョンに合わせて読みます。
- 参照：function、function tag、advancement、loot table、predicate、recipe、storage、objective、score holder、team、bossbar、entity tag、ブロックとアイテムの tag、バニラの registry の ID が存在するかを、`strict*Check` の設定と重さに従って調べます。
- lint の rule：重さを持つ rule（命名規則の `nameOf*`、引用符の `stringQuote`・`nbt*Quote`、`selectorSortKeys`、NBT の `nbtTypeCheck`・`nbtBoolean`・`nbtListLengthCheck` など）を検査します。空白、数値の接尾辞、末尾のカンマといった書式だけの設定は診断しません。
- NBT：entity、block entity、アイテムの NBT と、item の components、particle のオプション、1.21.5 からのテキスト、1.20.5 からコマンドに直接書ける loot table・predicate・item modifier などを [vanilla-mcdoc](https://github.com/SpyglassMC/vanilla-mcdoc) の型で検査します。`data get entity @s` のように種類が分からない所では、すべての種類の型を合わせて使います。
- components などゲームが読み込む時に型を確かめる値は、形の違い（数・文字列・list・compound の違い）と必須の key の不足を、`nbtTypeCheck` の設定に関わらず error にします。
- IMP-Doc：`#>` のドキュメントコメント、`@public`・`@api`・`@private`・`@internal`・`@within`、`#declare`・`#define` を読みます。公開範囲が許さない参照は、DHP と同じく未解決として報告します。
- データパックの JSON：advancement、predicate、loot table、item modifier、recipe、tag、damage type、dimension、dimension type、chat type、trim、worldgen と、1.21 からの enchantment など、そのバージョンのデータパックの種類を vanilla-mcdoc の型で検査します。ゲームが読み込めない誤りは error、型に無い key は warning とし、JSON の中のプロジェクトの ID は `strict*Check` の重さで調べます（IMP-Doc の公開範囲は掛かりません）。

## インストール

### VSCode 拡張機能

[Releases](https://github.com/EllaCoat/mcf-linter-spark/releases) から VSIX をダウンロードし、コマンドパレットの **Extensions: Install from VSIX...** で入れます。Releases の VSIX は Windows（x64）用で、VSCode 1.90 以上で動きます。

- ほかの OS では、Rust（stable）、Node.js、pnpm を使ってソースからビルドします。できた `mcf-linter-spark-<version>.vsix` には、ビルドした OS 用の実行ファイルが入ります。

```sh
git clone https://github.com/EllaCoat/mcf-linter-spark
cd mcf-linter-spark
cargo build --release
cd editors/vscode
pnpm install --frozen-lockfile
pnpm run package
```

### コマンド

Rust（stable）でビルドして入れます。

```sh
cargo install --git https://github.com/EllaCoat/mcf-linter-spark --locked mcf-linter-spark
```

## VSCode 拡張機能

`.mcfunction` とデータパックの JSON に対して、診断、補完、定義へ移動、参照の検索を提供します。`.mcfunction` では IMP-Doc のホバー表示とコマンドのシグネチャヘルプも使えます。

- 補完：コマンド、セレクター、ブロックステート、item の components、バニラとプロジェクトの各種 ID・tag・symbol、JSON の key や値を、指定したバージョンに合わせて補完します。プロジェクトの symbol は IMP-Doc で参照できる所でだけ候補に出し、長い ID は `namespace:`、`folder/` と 1 階層ずつ出します。
- NBT の補完：entity、block entity、アイテムの key とパスに加え、プロジェクトの function（と IMP-Doc の `# @input`・`# @output` の行）が使っている storage のパスを補完します。
- 定義へ移動・参照の検索：symbol の `#declare` か定義、function のファイルのドキュメントコメントへ移動でき、コマンド・function tag・データパックの JSON・コメントのリンクからの参照を検索できます。
- コメントのリンク：`# see [the handler](example:handler/damage#L12)` のように function を指す Markdown のリンクから、その function のその行を開けます（IMP-Doc のホバーからも開けます）。存在しない function や行を指すリンクは information（`commentLink`）として報告し、URL など function 以外を指すリンクは読みません。
- DHP や Spyglass も入れているときは、診断が二重に出ないよう、そちらの診断を切ってください。
- [バニラのデータ](#バニラのデータ)を cache からも取得でも読めないときは、通知でエラーを出します。

### 設定

VSCode の設定で、次の項目を指定できます。

- `mcfLinterSpark.ignore`：診断を出さないファイルの ID のパターン（`animated_java:**` など）。一致したファイルも宣言は読みます。
- `mcfLinterSpark.maxDepth`：データパックを探すディレクトリの深さ。指定しなければコマンドと同じです。
- `mcfLinterSpark.serverPath`：同梱の実行ファイルの代わりに使う mcf-linter-spark の実行ファイル。

## コマンドの使い方

`<root>`（指定しなければカレントディレクトリ）と、その 2 階層下までにある、`pack.mcmeta` と `data/` を持つディレクトリをデータパックとして読みます。設定は `<root>/.vscode/settings.json` から読みます。

```sh
mcf-linter-spark check [<root>] [--config <settings.json>] [--ignore <pattern>]... [--max-depth <n>] [--format text|github] [--json <file>] [--symbols <file>]
```

- `--config`：設定をこのファイルから読みます。`datapack.lint.x` のような平らなキーと、入れ子のキーのどちらも読めます。
- `--ignore`：診断を出さないファイルの ID のパターン（`animated_java:**` など）。一致したファイルも宣言は読みます。
- `--max-depth`：データパックを探す深さ。
- `--format github`：error と warning を GitHub Actions の注釈で出します。
- `--json`：すべての診断を、1 行に 1 つの JSON で書き出します。
- `--symbols`：宣言と定義を、DHP が `.cache/dls.json` に書くキャッシュと同じ形の JSON で書き出します。対象は `#declare`・`#define`・`#alias`、function などのファイル、`scoreboard objectives add` などのコマンドです。それぞれの位置と IMP-Doc の公開範囲も書き出します。参照（`ref`）と doc は書き出さないので、datapack-linter のキャッシュから宣言と定義だけを読むスクリプトに渡せます。`uri` は実行したときの絶対パスから作る `file://` の URI です。error や warning で終了コードが 1 になったときも書き出します。
- 終了コード：error か warning があれば 1、データパックが見つからない・[バニラのデータ](#バニラのデータ)を cache からも取得でも読めないなどで最後まで実行できなければ 2、それ以外は 0 です。

### GitHub Actions

GitHub Actions でデータパックを検査する設定例です。

```yaml
- uses: actions/checkout@v5
- uses: actions/cache@v4
  with:
    path: ~/.cache/mcf-linter-spark
    key: mcf-linter-spark-data-1.20.4-c85548aae6f2-5aab1da2ff00
- run: cargo install --git https://github.com/EllaCoat/mcf-linter-spark --tag v0.2.0 --locked mcf-linter-spark
- run: mcf-linter-spark check . --ignore 'animated_java:**' --format github
```

- `--tag` で使う版を固定します。
- `actions/cache` でバニラのデータを実行の間で残し、取得できない時に CI が落ちるのを防ぎます。cache は job が成功した時に保存されます。
- key には取得するデータの commit を入れています。データの commit が違うバージョンの mcf-linter-spark では、新しい cache になります。
- 例の key は 1.20.4 を検査するときのものです。ほかのバージョンでは、`1.20.4-c85548aae6f2` をそのバージョンの cache のフォルダ名（バージョンと、[`version.rs`](crates/spark-core/src/version.rs) にある commit の先頭 12 文字。26.3 なら `26.3-d96c75fec200`）にします。

## バニラのデータ

Minecraft のデータは同梱していません。初回の実行で、決まった commit のファイルを `curl` で取得し、ユーザーの cache ディレクトリ（Windows は `%LOCALAPPDATA%`、macOS は `~/Library/Caches`、ほかは `$XDG_CACHE_HOME` か `~/.cache`）の `mcf-linter-spark/<バージョン>-<commit>/` に置きます。各バージョンの commit は [`version.rs`](crates/spark-core/src/version.rs) にあります。

- コマンドツリー、registry、ブロックステート、バニラのリソースと tag の一覧：バージョンごとに、[mcmeta](https://github.com/misode/mcmeta) の `<バージョン>-summary` タグの summary から取得します（約 750 KB、1.20.4 の取得元：`https://raw.githubusercontent.com/misode/mcmeta/c85548aae6f200b4cd823bca81528eedfc790de0/<名前>/data.min.json`）。
- NBT とデータパックの JSON の型：[vanilla-mcdoc](https://github.com/SpyglassMC/vanilla-mcdoc) の `generated` branch の `symbols.json` から取得します（約 2.7 MB、取得元：`https://raw.githubusercontent.com/SpyglassMC/vanilla-mcdoc/5aab1da2ff00955cdb66f0d6c2a1154ef691a015/symbols.json`）。1 つのファイルにすべてのバージョンの型が入っているので、どのバージョンでも同じ commit のファイルを使います。
- 環境変数 `MCF_LINTER_SPARK_DATA_DIR` で、`<cache ディレクトリ>/mcf-linter-spark` の代わりの置き場を指定できます。CI の cache から戻したディレクトリや、ネットワークの無い環境でファイルを置いたディレクトリに使います。
- ネットワークの無い環境では、上の URL のファイルを次の名前で置きます。

```
<MCF_LINTER_SPARK_DATA_DIR>/1.20.4-c85548aae6f2/commands.json                    # mcmeta の commands/data.min.json
<MCF_LINTER_SPARK_DATA_DIR>/1.20.4-c85548aae6f2/registries.json                  # mcmeta の registries/data.min.json
<MCF_LINTER_SPARK_DATA_DIR>/1.20.4-c85548aae6f2/blocks.json                      # mcmeta の blocks/data.min.json
<MCF_LINTER_SPARK_DATA_DIR>/1.20.4-c85548aae6f2/vanilla-mcdoc-5aab1da2ff00.json  # vanilla-mcdoc の symbols.json
```

## spyglass.json があるプロジェクト

root に `spyglass.json` があると、それを Spyglass v4 で動く [tsb-spyglass-linter](https://github.com/EllaCoat/tsb-spyglass-linter) の設定として読み、DHP と食い違う所はそちらに合わせます。

- `lint` で有効にした IMP-Doc の rule を報告します：`impDocVisibilityConflict`（public と制限付きの両方で宣言した symbol）、`impDocBareDeclaration`（ドキュメントコメントの外の `#declare`）、`impDocPrivateBestEffort`（マクロ行の中の、宣言が無いか見えない function の呼び出し）と、`@within` の後ろの知らない修飾子。
- `@private`・`@internal`・`@within` が許さない参照は、未解決ではなく `impDocPrivate` として、対応する `strict*Check` の重さで報告します。
- data コマンドの storage と、コマンドが書き込む score holder は、その symbol の定義として扱い、未解決にも制限付きにもしません。ドキュメントコメントの下のコマンドは、その公開範囲を `impDocVisibilityConflict` のための symbol に足します。
- `data modify <entity|block> ... value` の値を、対象のパスの末尾の型で検査します。数値の種類は互いに入れ替えられますが、真偽値は byte でなければなりません。
- summon する entity や、`merge` 以外の `data modify ... value` の値には、型が必須とする key を求め、型の範囲を外れた数値は error にします。
- 文字列の field の、引用符の無い文字列も `nbtStringQuote` の対象にします。`interpret` は `nbt` のテキストにだけ使えます。
- データパックを root の下のどの深さまでも探します。

## Special Thanks

開発で参考にしたプロジェクトと、検査に使うデータの提供元です。

- [Spyglass](https://github.com/SpyglassMC/Spyglass)：補完、データパックの JSON の検査、診断の文面を参考にしました。
- Datapack Helper Plus（Spyglass の前身）：lint の設定と IMP-Doc の扱い、診断の文面を合わせています。
- [datapack-linter](https://github.com/ChenCMD/datapack-linter)：CI での診断の文面を合わせています。
- [vanilla-mcdoc](https://github.com/SpyglassMC/vanilla-mcdoc) と [mcmeta](https://github.com/misode/mcmeta)：検査に使う型とバニラのデータです。

## ライセンス

[MIT License](LICENSE) で公開しています。

- 実行ファイルに入る Rust の crate と、拡張機能に入る npm のパッケージのライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にあります。
