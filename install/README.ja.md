<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../README.ja.md)
<!-- doc-navigation:end -->

# Team AI Box オフライン パッケージ ツール

元のインストーラーは MIT ライセンスを取得しています。パッケージには、ファイル ハッシュ インベントリ内のルート ライセンス、サードパーティ インベントリ、およびライセンス テキストが含まれています。これにより、モデル、Google サービス、ドライバー、コンテナの依存関係が MIT として再ライセンスされることはありません。配布前に [リリース境界](../docs/open-source/RELEASING.ja.md) をお読みください。既存の完全なテスト パッケージには、自動的には再配布許可が与えられません。

お客様は、準備されたパッケージ**内で**`sudo ./install.sh`を実行します。メンテナは、`build-package.sh` を使用してそのパッケージをビルドします。オフラインの顧客は、Git、Node、Go、pip、またはパブリック パッケージ リポジトリを必要としません。

パブリック クローンから自動的にダウンロード、ビルド、インストールするには、`sudo bash install/from-source.sh` を実行します。中国のネットワークでは `--region cn` を使用できます。操作、再開、オフライン転送については、[SOURCE-INSTALL.md](SOURCE-INSTALL.ja.md)を参照してください。再開はサポートされています。最終的な準備結果のみがインストールの完了を確定します。プリフライトやダウンロードが成功しただけでは十分ではありません。

ターゲットは、工場出荷時の Ubuntu 24.04 ARM64 システムと動作する Docker エンジン、Compose v2、NVIDIA コンテナ ツールキット/GPU、および KVM を備えた新しい DGX Spark です。インストーラーは、Docker/NVIDIA の置き換え、Docker の再起動、開発アプライアンスのアカウント、データベース、キー、または仮想マシンのコピーを行いません。

> プライベート インストールの受け入れ記録は、開発履歴リポジトリに残ります。これらは公開ソース ファイルでもビルド入力でもありません。既存の初回インストール、再開、およびブートリカバリの証拠は、ソース公開のためだけに再実行されることはなく、任意の新しく構築されたイメージを認定したり、サードパーティのバイナリの再配布権を付与したりすることはありません。

## メンテナ: リリース入力を準備する

**新しいパブリック GitHub ビルドの場合は、[PUBLIC-BUILD.md](PUBLIC-BUILD.ja.md) から始めてください。** これには、開発アプライアンスからのイメージを必要とせずに、パブリック イメージ、カメラ ランタイム、モデルのダウンロード/量子化、およびファームウェアが含まれています。以下の階層化されたイメージ ヘルパーは、検証済みアーティファクトの増分更新をサポートします。これらは新規ビルドの前提条件ではありません。

準備にはインターネットを使用できます。配布されたパッケージからのインストールでは、依存関係をダウンロードしてはなりません。パッケージング ホストには、Python 3.10 以降、PyYAML、Git、Docker、`dpkg-deb`、および十分なストレージが必要です。モデルと画像は大きくなる場合があります。パッケージャーは抽出されたツリーと `.tar` の両方を保持し、実際の入力からスペースを推定します。開発アプライアンス全体をスキャンしたり、実行中のコンテナから書き込み可能なレイヤーをエクスポートしたりすることはありません。

1. 必要なすべてのロールに対して **1 つのリリース バージョン**から ARM64 イメージを準備します。 `deploy/images/`, `deploy/appliance/` の下のビルド エントリ ポイントと、対応するゲスト/モデル ディレクトリを使用します。プラットフォーム API、ノード エージェント、スケジューラ、およびエージェント コントローラはローカル イメージ ID をサポートする必要があります。 PostgreSQL イメージには、移行 116 を含む現在の移行マニフェストが含まれている必要があります。パッケージャーは、任意の古いイメージを現在のイメージにコンパイルしません。検証済みの同じバージョンの親イメージを使用して、`build_runtime_images.py --bases … --node-agent-binary … --output …` を使用して 5 つの後続イメージを構築します。 `--bases` は、JSON ロールからフルイメージ ID へのマップです。まず、`GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build` を使用してノード エージェントを構築します。このヘルパーは、プル/ネットワークの構築を禁止し、親/ソースの ID を記録し、ライブ タグのデプロイや変更を行わずに新しいイメージを作成します。クリーンな Android ROM には、最新の制御ネットワーク アダプターも必要です。 `build_phone_images.py --bases <phone-role-image-ids.json> --output <new-directory>` を使用して、ネットワーク アクセスや ROM データの変更を行わずに、両方の ROM 後継層に `phone_network.py` を追加します。正確なイメージ ID とソース ダイジェストを記録します。 Android サイドカーを以前の ID ではなく、両方の新しい ID にバインドします。 `build_application_images.py --node-base <clean-arm64-node-image-id> --guacamole-image <offline-guacamole-image-id> --output <new-directory>` を使用してウェブと 9 つの公式アプリを構築します。まず、`apps/web/package.json` の指定に従って Web を構築します。ヘルパーは実稼働 Dockerfile を使用し、Web ディレクトリを `/opt/teamaibox/web` に修正し、イメージ ファイルを現在のビルド入力ハッシュと比較します。開発コンテナ イメージが完全な Web ビルドであると想定しないでください。追加の静的ディレクトリ変数に依存していたり​​、古いディレクトリが含まれている可能性があります。このオフライン ヘルパーは展開されません。 10 個の新しいイメージ ID をすべてリリース入力に入力します。
2. 6 つのモデル (構成、シャード、トークナイザー、必要なコード、ライセンス) の完全でクリーンなディレクトリを収集します。また、2 つのクリーンな Android イメージ、UEFI `CODE.fd`/`VARS.fd`, `virtio.iso` と描画ランタイム スクリプトも準備します。電話インスタンス ディレクトリ、ユーザ ディスク、Google ログイン状態、ユーザ ISO、またはグローバル クレデンシャルを収集しないでください。 Android ROM はすでに `phone-runtime` / `phone-google-runtime` 内にあります。 2 番目のディスクをコピーしないでください。 `android-standard` / `android-google` アセット ディレクトリには、来歴、ライセンス、`manifest.json`: `schemaVersion: 1`, `androidVersion: "17"`, `baseBuildId: "16102939"`, `systemFamily: "standard"` or `"google-play"`、および `runtimeImageId: "sha256:…"` のみが含まれます。 ID はエクスポートされたランタイム イメージと一致する必要があります。ドライバー ディレクトリには `virtio.iso` のみが含まれています。 `windows.iso` も含まれる開発ディレクトリは拒否されます。
3. バンドルされている 2 つの Linux ARM64 ホスト ツールをビルド ホストにインストールせずにビルドします。

   ```sh
   python3 install/build_guest_tools.py --output /build/artifacts/guest-host-tools
   ```

4. インターネットに接続された ARM64 ビルド ホストで、明示的なローカル Ubuntu 24.04 イメージを使用してホスト ツールの依存関係を収集します。開発アプライアンスからコピーした ID ではなく、そのホストで検証されたイメージ ID を使用します。

   ```sh
   python3 install/collect_host_packages.py \
     --base-image "$UBUNTU_ARM64_IMAGE_ID" --output /build/artifacts/host-packages
   ```

   cryptsetup、ext4、USB/カメラ、QEMU イメージ ツール、ネットワーキング、小規模システム ユーティリティの依存関係のみを収集します。 Docker、containerd、NVIDIA、CUDA、およびカーネル置換パッケージは禁止されています。インストールでは不足しているツールのみが提供されます。 apt は、オンライン フォールバックなしで、`--no-download --no-remove` を使用してパッケージのローカル ファイル リポジトリを読み取ります。

5. リリース入力マニフェストを生成し、**明示的なアーティファクト パスとローカル イメージ コンテンツ ID** を指定します。

   ```sh
   python3 install/prepare-release.py --template /build/artifact-inputs.json
   python3 install/prepare-release.py --inputs /build/artifact-inputs.json \
     --output /build/prepared-release
   ```

   テンプレートには、41 のイメージ ロールすべてと 12 の外部アセット カテゴリが含まれています。別のファクトリ アセットはツールによって生成されます。プレースホルダをパッケージに入れることはできません。 `sourceCommit` はチェックアウト、`agentVersion` は実際のエージェント ビルド、および `hostPackageCollection` はステップ 4 `collection.json` と一致する必要があります。ビルド ホスト パスはコレクションの入力であり、顧客のランタイム構成ではありません。現在のファクトリ ジェネレーターを使用します。描画 UI の `drawing.automatic` / `drawing.fast` ルートはローカル モデル構成と一致する必要があります。ワーカーの状態や直接モデル呼び出しだけでは、アプリケーションの準備状態は確立されません。パッケージ化では、これらのマッピングが欠落している古いファクトリ テンプレートは拒否されます。

イメージロールコントラクトは、`python3 install/package.py --describe-contract` によって報告されます。

- コア、Web、チーム ドライブ、メッセージング、ゲートウェイ、スケジューラー、メンテナンス、プラグイン、動的エージェント サンドボックス、およびパッケージ ソース ゲートウェイ。
- 9 つのアプリケーション プラグイン、6 つのオフィス モデル ワーカー、およびオンデマンドの ASR/スピーカー ランタイム。
- 標準 Android、Google Android、コンピュータ ランタイム、Web ディスプレイ/オーディオ ゲートウェイ。
- キャスティング受信機、メディア処理、および SFU。

2 つの役割が 1 つの画像コンテンツ ID を共有できます。そのアーカイブは 1 回だけエクスポートされます。モデルのシャード インデックスもチェックされます。ファイル ハッシュが一致していても、シャードの欠落は許容されません。ホスト ツールは実際の ARM64 ELF バイナリである必要があります。

## パッケージをビルドする

```sh
./install/build-package.sh --release /build/prepared-release/release-input.json \
  --output /build/output
```

出力は、`teamaibox-<releaseId>-linux-arm64.tar`、その `.sha256` ファイル、および抽出されたディレクトリです。コピー、イメージのエクスポート、ハッシュ、およびアーカイブは、最終的なチェックサムが公開される前に一時ディレクトリで行われます。既存の出力は上書きされません。中断されたビルドが完全なリリースのように見えてはなりません。イメージ ID が変更されていないインストーラーのみの変更の場合は、`--image-cache <previous-extracted-package>` を使用します。古いパッケージ全体がそのアーカイブが実際のイメージ ID によって再利用される前に検証され、新しいパッケージが再度検証されます。古いインストールまたはコンテナーの書き込み可能レイヤーからデータは取得されません。これにより、何百 GB もの同一のイメージを再度エクスポートする必要がなくなります。

通常のリリースでは、バンドルされたソース ファイルが宣言された Git コミットに属する必要があります。明示的な `--allow-working-tree` は開発候補を作成します。そのマニフェスト レコード `candidate: true` と変更されたファイル。集中的な承認に合格しても、コミットされていないソースが公開されたリリースになるわけではありません。

パッケージレイアウト:

```text
teamaibox-<releaseId>-linux-arm64/
  install.sh, installer.py, offline_common.py, offline_host_packages.py
  README.zh-CN.md, release.json, checksums.sha256
  images/          # Docker archives deduplicated by content ID
  assets/          # Models, Android, computers, tools and factory configuration by role
  host-packages/   # Complete .deb dependency set
  runtime/         # Installer adapters and recovery-tool module closure
```

`./install/build-package.sh --verify /build/output/teamaibox-<releaseId>-linux-arm64` を使用して個別に検証します。これにより整合性がチェックされます。新しいハードウェアでの起動が成功したことは証明されません。

## お客様: オフライン インストールと再開

[パッケージ インストール ガイド](PACKAGE-README.ja.md) をお読みください。デフォルトのルートは `/srv/teamaibox/installation` です。 LUKS/ext4 は、システム ディスクや既存のディスクではなく、新しい `volume/data.img` 内にのみ作成されます。データ プールは、固定の 256 GiB 制限ではなく、利用可能なストレージから物理的な安全マージンを差し引いたものを使用します。モデル、ビジネス ファイル、ゲスト データは暗号化されたボリュームに存在します。既存の Docker がコンテナ イメージを管理します。

新規インストールでは、初期パスワード `admin` を持つ管理者 `admin` が作成されます。一般ユーザーは管理者によって作成されます。初期パスワードは納品・使用前に変更してください。これは空のアカウント データベースにのみ適用されます。再開、再実行、再起動、アップグレードでは、既存のアカウントやパスワードはリセットされません。デバイス ID、サービス資格情報、証明書、および管理者リカバリ コードは、別のアプライアンスからコピーされるのではなく、個別に生成されます。初期の GPU カーネル キャッシュの準備は、バンドルされたツールとモデルを使用してアプライアンス上で実行されます。互換性のあるキャッシュは保持されます。ブート リカバリでは、最初にデータとデバイス サービスが復元され、次にコア サービスと個々の AI ワーカーが復元されます。インストーラーはインストール中にのみ実行されます。常駐インストーラー マネージャーは追加されません。

中断後、元のコマンドを繰り返します。完了したステップが検証されます。データを削除したりコンテナを再作成したりして競合を隠蔽しないでください。完了した同じバージョンのインストールを再実行すると、チェックのみが行われます。異なるバージョンでは正式なアップグレード パスが使用されます。障害の詳細は、インストール ルートの下の `install-state.json`, `readiness.json` とステージ レコードにあります。

## 検証境界

インストーラー固有のテストでは、小さな構造アーティファクト、一時ファイル、分離されたオフライン データベース/Docker デーモンが使用されます。ビジネス データベースにアクセスしたり、既存の VM ディスクをマウントしたりしてはなりません。実際の新規インストールには、その目的のために明示的に指定された互換性のある DGX Spark が必要です。ビジネス アプライアンスを消去しないでください。承認には、新規インストールの最小限の起動、再開、ブート リカバリが含まれますが、無関係なビジネス テストは含まれません。ソースリリースの準備自体は、既存のアプライアンスの消去、再インストール、または展開を行いません。

ビルドホストで `sudo python3 install/verify_bundle_offline.py --package <extracted-package> --output <new-test-directory>` を実行して、空のキャッシュとパブリック ネットワークを持たない別の Docker デーモンに完全なパッケージをインポートします。新規インストール スクリプトの呼び出し、GPU の使用、顧客ディレクトリのマウント、システム Docker の再起動は行いません。そのレポートでは、ハードウェアの完全なインストールを明示的に主張していません。テスト イメージは専用のテスト ディレクトリに残り、追加のディスク領域が必要となり、システムの Docker イメージ ストアには入りません。
