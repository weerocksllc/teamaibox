<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.ja.md)
<!-- doc-navigation:end -->

# Team AI Box オフライン インストール パッケージ

元のコードのライセンスはバンドルされた `LICENSE` に含まれています。サードパーティのコンポーネントは元のライセンスを保持します。 `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json`を参照してください。 MIT は、Google サービス、Windows、モデルの重量、またはサードパーティのブランドに対する追加の再配布権を付与しません。パッケージの整合性チェックに合格しても、すべてのコンポーネントの再配布許可が確立されるわけではありません。

このパッケージは、互換性のある工場出荷時の Linux システムを保持する新しい DGX Spark 用です。既存の Docker、Compose、および NVIDIA GPU 環境を、置き換えたりシステム ディスクをフォーマットしたりせずに使用します。

## インストール

付属の `.sha256` ファイルを使用してアーカイブを確認し、抽出します。

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

通常のインストールでは、公共のインターネット アクセスや手動の環境変数の編集は必要ありません。インストーラーは、必要なバンドル ツールを提供し、独立したローカル構成を生成し、新しいデータベースを初期化し、サービスを開始します。初期モデルの読み込みには時間がかかる場合があります。読み込みインジケーターは、インストールが成功したことを確認するものではありません。

`sudo ./install.sh --check` を実行して、インストールせずに環境とパッケージを確認します。 `./install.sh --verify-package` はパッケージの内容のみをチェックし、パッケージ化ワークステーション上でも実行できます。 `--installation-root /dedicated/path/installation` を使用して、新しいインストール ルートを指定します。決して既存のデータを指さないでください。

## 中断と既存のデータ

障害または中断が発生した後、報告された問題を解決し、元のコマンドを繰り返します。インストールディレクトリは削除しないでください。インストーラーは、生成した ID とデータを保存します。完全に同じバージョンのインストールを再実行すると、その状態がチェックされるだけです。他のバージョンでは、消去と再インストールではなく、正式なアップグレード パスが使用されます。強制上書きオプションはありません。

## 初めての使用

アプライアンスの現在の IP で HTTPS アドレスを開き、サインインします。

- 管理者のユーザー名: `admin`
- 初期パスワード: `admin`

インストーラーはこの管理者を自動的に作成します。セットアップ トークンの抽出や手動登録は必要ありません。初期パスワードは公開されており簡単です。配信/使用前にユーザー管理で変更してください。一般ユーザーにはデフォルトのアカウントはなく、管理者によって作成されます。これは空のアカウント データベースにのみ適用されます。再開、再実行、再起動、アップグレードでは、既存のアカウントやパスワードがデフォルトにリセットされることはありません。独自に生成された管理者リカバリ コードは、インストール ルートの `secrets/initial-owner-recovery.json` に保存され、root のみが読み取ることができます。リカバリ コードをチャット、チケット、または公開ログに送信しないでください。既存のインストールでは、リカバリ コードが生成または置き換えられません。ローカルで発行された HTTPS 証明書の場合は、管理者の CA の指示に従ってブラウザの信頼を構成します。証明書内の名前は、LAN DNS/mDNS の解決を保証するものではありません。ローカル CA パブリック証明書は通常、`/srv/teamaibox/installation/https/ca.crt` にあります。その公開証明書のみを配布し、その傍らに秘密キーを配布しないでください。

インストールには、既存の仮想マシン、Google ログイン状態、ユーザー ファイルは含まれません。ユーザーは Windows/Linux ISO をアップロードするか、チーム ドライブから ISO を選択して、ゲスト システムを自分でインストールします。 Google Play と外部 API にはインターネット アクセスが必要ですが、オフライン利用の約束には含まれていません。

コンポーネントのライセンス テキストは、リリース リソースとともに保持されます。著作権 © Weerocks LLC。連絡先:teamaibox@weerocks.llc。
