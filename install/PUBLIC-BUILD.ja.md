<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.ja.md)
<!-- doc-navigation:end -->

# パブリック ソースからアプライアンスを構築する

新しいオーケストレーション エントリ ポイントは、[SOURCE-INSTALL.md](SOURCE-INSTALL.ja.md) に記載されています。以下のレシピを自動化します。完全な適用の検証ステータスがそこに記載されています。これらの手動レシピは、メンテナンス担当者や個々のステージの診断に引き続き利用できます。

これはソースからパッケージへのパスです。以前の Team AI Box インストール、そのコンテナ、アカウント、証明書、ゲスト、データベースはインポートされません。ビルド マシンにはインターネット アクセスが必要です。結果として得られる完全なパッケージはオフラインでインストールされます。お客様は、Windows/Linux インストール メディアを別途提供します。

Linux ARM64 (Ubuntu 24.04)、Docker/BuildKit、Python 3.10+、PyYAML、jq、Git、Go 1.26、およびソースのダウンロード、ビルド層、および最終的な非圧縮バンドルに十分なディスク容量を使用します。モデルの量子化には、十分な空きメモリを備えた互換性のある NVIDIA GPU も必要です。マシン所有者の許可なしに、他のワークロードを停止してそのメモリを取得しないでください。 Docker と NVIDIA は前提条件であり、インストーラーによって置き換えられるコンポーネントではありません。

新しいパブリック チェックアウトからコマンドを実行します。 `BUILD` をチェックアウトの**外部**の新しい絶対ビルド ディレクトリに設定します。出力、モデル、レポートはコミットしないでください。すべてのヘルパーは、特定の再開操作を文書化しない限り、占有された出力を拒否します。他の人のマシンからコピーしたイメージ名ではなく、成功したレポートの参照/ID を使用してください。ローカル Docker コンテンツ ID は、ダウンロード可能なレジストリ参照ではありません。 Dockerfile の親引数には、対応するローカル タグまたは修飾されたアップストリーム ダイジェストが必要です。

## 1. サービスとアプリケーション

```sh
python3 install/build_public_services.py --output "$BUILD/services" \
  --network host \
  --guacamole-image docker.io/guacamole/guacamole@sha256:f344085e618bb05e22b964b0208dbd06d3468275bac70206f93805245e067b40 \
  --guacd-image docker.io/guacamole/guacd@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f \
  --roles platform-api web postgres event-bus node-agent agent-bridge \
  object-service messaging scheduler plugin-runtime observability \
  compute-gateway appliance-gateway maintenance-controller source-gateway \
  agent-sandbox computer-runtime desktop-gateway desktop-proxy \
  casting-receiver casting-media assistant-worker embedding-worker \
  translation-worker drawing-worker ocr-worker asr-worker batch-asr-worker \
  speaker-diarization-worker messaging-plugin team-drive-plugin drawing-plugin \
  ocr-plugin asr-plugin translation-plugin virtual-phones-plugin \
  virtual-computers-plugin wireless-casting-plugin

python3 install/build_public_sfu.py \
  --cache "$BUILD/downloads" --output "$BUILD/sfu"
```

`--network host` は、インストールされたサービス ネットワーキングではなく、オンライン **ビルド**に影響します。ノードの依存関係ステージでは、ノードのデフォルトの 250 ミリ秒ではなく、接続試行ごとに 2 秒が許可されます。これにより、レジストリを切り替えたり、IPv6 を無効にしたり、TLS/パッケージの整合性チェックを弱めたりすることなく、ユーザー管理の VPN などの高遅延リンク上で公式の npm ダウンロードを使用できるようになります。この設定はビルド段階の引数であり、インストールされたアプリケーションの環境変更ではありません。リンクが遅い場合は、直接 Docker ビルドで `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000` をオーバーライドできます。 Web イメージは、独自のロックされた依存関係とアセットを構築します。ノード サービスは、新しく構築された API 依存関係クロージャを共有します。 OCR にはパブリック アダプターが含まれています。別のプロジェクトからの未公開のワーカー パッケージは必要ありません。変換では、固定されたパブリック NVIDIA vLLM イメージを使用します。埋め込み、バッチ ASR、およびキャスト メディアは、それぞれのパブリック ランタイム イメージを意図的に共有します。このコンピューター イメージは、ARM TPM/PPI、KVM、VNC、および PulseAudio をサポートする署名検証済みの QEMU 11.1.1 を構築し、元の Windows ランタイムの機能を維持します。 Debian はランタイム ライブラリを提供しますが、古いパッケージ化された QEMU がこの実行可能ファイルを置き換えてはなりません。最終イメージでは、ARM TIS `ppi` プロパティと PulseAudio バックエンドの両方をチェックし、一致する RAM フレームバッファ ROM を含めます。制限付きランタイム プローブとデータ保持更新の要件については、[仮想コンピューター ランタイム ガイド](../deploy/windows-computer/README.ja.md) を参照してください。

各ロールにはログがあります。失敗したレポートでは、成功したロールの出力が保持されます。失敗したロールのみを構築し、後で成功したレポートをマージします。実行中の開発コンテナを不足しているイメージとして置き換えないでください。

## 2. アカウント不要の Android およびカメラ ランタイム

ロックは、Google の AOSP ビルド、ホスト パッケージ、カーネル入力、ソース リビジョンを固定します。ダウンロードは使用前にチェックされます。アセンブリ中にゲストはブートされません。

```sh
python3 install/build_public_android.py --cache "$BUILD/android-downloads" \
  --output "$BUILD/android"
PHONE_BASE=$(jq -r '.images.network.reference' "$BUILD/android/build.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_BASE" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:phone-tools deploy/android/cuttlefish

python3 install/build_public_camera_backend.py --cache "$BUILD/camera-downloads" \
  --output "$BUILD/camera-backend"
CAMERA_COMPILER=$(jq -r '.compiler' "$BUILD/camera-backend/build.json")
python3 install/fetch_public_camera_kernel.py --output "$BUILD/kernel"
python3 tools/prepare_phone_camera_guest_driver.py --output "$BUILD/guest-source"
python3 tools/build_phone_camera_guest_driver.py --inputs "$BUILD/kernel" \
  --source "$BUILD/guest-source" --compiler-image "$CAMERA_COMPILER" \
  --output "$BUILD/guest-driver"
```

カメラ APK パッチの場合は、Google のパブリック Android コマンドライン ツール、プラットフォーム `android-36.1`、ビルドツール `36.1.0`、および Java リリースをサポートする JDK をインストールします。
8. `ANDROID_SDK_ROOT` and `JDK_HOME` をこれらのツール ディレクトリに設定します。これらのツールはビルドの依存関係であり、エクスポートされた Android ユーザー プロファイルではありません。 ARM64 Linux では、Google にバンドルされている `zipalign` は x86 専用である可能性があります。Ubuntu の ARM64 `zipalign` パッケージをインストールし、以下の `--zipalign /usr/bin/zipalign` を渡します。 D8 と apksigner は Java プログラムです。 APK ビルドは、サポートされている別の SDK ホスト上で実行することもできます。 2 つの出力ファイル (`Camera2.apk`, `camera-preview.json`) のみを転送し、ホストの Android 設定やユーザー プロファイルは転送しません。

クリーンな AOSP ビルドからストック APK を抽出します (出力ディレクトリが存在し、ビルド コンテナーによって書き込み可能である必要があります)。

```sh
mkdir "$BUILD/stock-camera"
docker run --rm --network none --read-only --user 0:0 --tmpfs /tmp:size=2g \
  --entrypoint python3 \
  --mount "type=bind,src=$PWD/deploy/android/cuttlefish,dst=/build,readonly" \
  --mount "type=bind,src=$BUILD/stock-camera,dst=/work" \
  teamaibox-build:phone-tools /build/prepare_camera_rom_inputs.py
python3 install/build_public_camera_apk.py \
  --stock "$BUILD/stock-camera/inputs/stock-Camera2.apk" \
  --sdk "$ANDROID_SDK_ROOT" --java-home "$JDK_HOME" --output "$BUILD/camera-apk"
python3 install/build_public_phone_rom.py --base-image "$PHONE_BASE" \
  --tools-image teamaibox-build:phone-tools --apk "$BUILD/camera-apk" \
  --module "$BUILD/guest-driver" --output "$BUILD/camera-rom"
PHONE_PARTITIONS=$(jq -r '.reference' "$BUILD/camera-rom/build.json")
python3 install/build_public_phone_runtime.py --base-image "$PHONE_PARTITIONS" \
  --backend "$BUILD/camera-backend" --cache "$BUILD/camera-downloads" \
  --output "$BUILD/phone"
```

APK は、プライベート プロダクト キーではなく、既知の **パブリック AOSP テスト署名者**を保持します。ヘルパーは、元の証明書と結果の証明書、および変更されていない APK リソースを検証し、一時的な署名素材を削除します。これはアカウントや Google デバイス ID ではありません。

現在の完全なインストーラー契約には、実験的な Google Android バリアントも含まれています。そのパブリック入力ロックと署名検査は、Google の認定または再配布の権利を**与えるものではありません**。該当するサードパーティの規約内でのみ構築/使用してください。結果の完全なバンドルを無制限の MIT ダウンロードとして公開しないでください。

```sh
PHONE_RUNTIME=$(jq -r '.references["phone-runtime"]' "$BUILD/phone/images.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_RUNTIME" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:google-tools deploy/android/cuttlefish
python3 install/inspect_public_phone_inputs.py --cache "$BUILD/google-downloads" \
  --tools-image teamaibox-build:google-tools --output "$BUILD/google-inputs"
python3 install/build_public_google_phone.py --base-image "$PHONE_RUNTIME" \
  --tools-image teamaibox-build:google-tools --inspection "$BUILD/google-inputs" \
  --output "$BUILD/google-phone"
```

## 3. パブリッシャーモデルファイルと公開量子化レシピ

```sh
for role in embedding-model drawing-model ocr-model asr-model; do
  python3 install/fetch_public_models.py --role "$role" \
    --output "$BUILD/assets/$role"
done
for role in assistant translation; do
  python3 install/fetch_public_models.py --role "$role-source" \
    --output "$BUILD/model-sources/$role"
done
OFFICE_ENGINE=$(jq -r '.references["assistant-worker"]' "$BUILD/services/images.json")
docker build --network host --build-arg OFFICE_ENGINE_IMAGE="$OFFICE_ENGINE" \
  -f deploy/compute/qwen38-modelopt/Dockerfile \
  -t teamaibox-build:modelopt deploy/compute/qwen38-modelopt
for role in assistant translation; do
  python3 install/prepare_public_quantized.py --role "$role" \
    --source "$BUILD/model-sources/$role" --tools-image teamaibox-build:modelopt \
    --output "$BUILD/quantized/$role"
done
```

すべてのモデルのダウンロードでは、`deploy/compute/*profile*` の不変のリビジョンと発行者の Git/LFS ハッシュが使用されます。オプションの `--cache <directory>` は読み取り専用で、バイトが発行者と一致する場合にのみファイルを受け入れます。インストールされたモデルのディレクトリを無差別にインポートする方法ではありません。変換されたモデルのスナップショットはライセンスを宣言するだけであるため、ASR のスタンドアロンの MIT テキストは元の Whisper リリースに固定されます。 OCR は、MIT ではなく、独自のライセンスを保持します。固定された翻訳および埋め込みモデル カードは、スタンドアロン テキストを送信せずに Apache-2.0 を宣言します。彼らのヘルパーには、チェックサムで固定された Apache ライセンスと、その宣言をチェックした後の来歴記録が含まれます。

中断されたマッチング ダウンロードは `--resume` をサポートします。 `--transfer ranges` は、制限された再開可能な HTTP 範囲を使用します。 `--transfer huggingface` には公式の `huggingface_hub`/`hf_xet` パッケージが必要であり、トークンの使用が無効になります。部分キャッシュとダウンロード キャッシュは、公開可能なモデル ディレクトリの外に残ります。チェックサムはすべてのトランスポートで必須です。 HTML ログイン/チャレンジ ページや切り詰められたダウンロードについては弱めないでください。

量子化は、ModelOpt の公開合成キャリブレーション データを使用して別のビルド コンテナーでオフラインで実行され、チャット履歴は使用されません。 `build.json` が `quantized` を示す出力のみが `assistant-model` and `translation-model` を提供できます。生のソースやビルド ワークスペース全体ではなく、`model/` サブディレクトリを選択します。入力を検証した後、Linux ビルドはカーネルにそれらの特定のファイルのキャッシュされたページを解放するようにアドバイスします。これにより、GB10 の共有メモリ上の誤解を招く即時解放 GPU メモリの読み取りが回避されます。重みの削除、ホスト全体のキャッシュのクリア、ワークロードの停止は行いません。 1 GB10 GPU の場合、ヘルパーは Linux `MemAvailable` から予算を割り当て、キャリブレーションとホスト用の容量を予約します。 CPU のみを使用したビルドを黙って受け入れるのではなく、容量不足を拒否します。完全なモデルが適合すると、明示的な ModelOpt バジェットにより、Accelerate の不必要な CPU オフロード エクスポート パスが回避されます。ビルド コンテナは、[NVIDIA の量子化起動要件](https://build.nvidia.com/spark/nvfp4-quantization/instructions) に従って、無制限のロックされたメモリと 64 MiB スタックも設定します。これらの設定は、ホスト全体の制限ではなく、ビルド コンテナーに限定されます。

## 4. パッケージの入力を完了する

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

合併では、**41 の役割と不足している役割がないこと**を報告する必要があります。画像アーキテクチャ/コンテンツ ID を検証し、矛盾する出力を拒否します。リソースには、アップストリームの UEFI ファームウェア (新しい変数ストア テンプレートを含む)、チェックサム固定の virtio ドライバー ISO、ソース描画ランタイム、および新しくビルドされたイメージにバインドされた Android 通知のみが含まれます。 ISO は Windows インストール メディアではありません。チェックサムが同一の Microsoft OpenVMM ミラーにより、インタラクティブな Fedora ダウンロード ページへの依存を回避できます。

[README.md](README.ja.md) の説明に従って、`collect_host_packages.py` でホスト パッケージを収集し、`prepare-release.py --template` でテンプレートを生成します。 `images.json` からイメージ マップを埋めます。モデル出力 `resources/assets.json` and `guest-tools` の 12 個のアセット ロールをすべて満たします。 `sourceCommit` をチェックアウトと実際のエージェントのバージョンに設定します。プレースホルダまたは以前のインストール構成は受け入れられません。

準備されたリリースを使用して、`prepare-release.py --inputs … --output …` を実行してから、`build-package.sh` を実行します。変更された/コミットされていないソースには、明示的な `--allow-working-tree` 候補フラグが必要です。それらはリリースされたコミットではありません。インストールについては、[PACKAGE-README.md](PACKAGE-README.ja.md) を参照してください。新しい空のアカウント データベースは `admin/admin` を取得します。すべてのサービス資格情報とデバイス ID は個別に生成されます。ビルドだけでは、インストールが成功したことは証明されません。

## 歴史的な階層化されたレシピと出版物チェック

古い診断/階層化された Dockerfile は、ソースのメンテナンスのために保持され、このパイプラインでは使用されません。彼らの `BUILD_PARENT_N` 引数には意図的にプライベート イメージのデフォルトがありません。構築した互換性のある親を指定するか、上記のパブリック パイプラインを使用します。入手できない開発ダイジェストを推測しないでください。

公開する前に、ソース ガードとシークレット スキャナーを実行し、履歴を個別に確認して、すべてのビルド ディレクトリ、パッケージ、ゲスト ディスク、アカウント データ、およびプライベート Web サイトを除外します。ローカル パスを含むレポートは、パブリック ツリーの外側に属します。この作業の検証は、ビルド入力クロージャ、アーティファクト ID、インストール、および新しくインストールされた最小サービス パスに限定されます。無関係なビジネスの受け入れを再実行することはありません。
