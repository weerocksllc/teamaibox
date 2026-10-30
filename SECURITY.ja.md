<!-- doc-navigation:start -->
[English](SECURITY.md) · [简体中文](SECURITY.zh-CN.md) · [繁體中文](SECURITY.zh-TW.md) · [日本語](SECURITY.ja.md) · [한국어](SECURITY.ko.md) · [Français](SECURITY.fr.md) · [Deutsch](SECURITY.de.md) · [Español](SECURITY.es.md) · [Português](SECURITY.pt-BR.md) · [Русский](SECURITY.ru.md) · [العربية](SECURITY.ar.md) · [हिन्दी](SECURITY.hi.md) · [Bahasa Indonesia](SECURITY.id.md) · [Italiano](SECURITY.it.md) · [Türkçe](SECURITY.tr.md) · [Tiếng Việt](SECURITY.vi.md) · [ไทย](SECURITY.th.md)

[Team AI Box — README](README.ja.md)
<!-- doc-navigation:end -->

# セキュリティレポート

脆弱性の疑いがある場合は、**teamaibox@weerocks.llc** に非公開で報告してください。影響を受けるバージョン、最小限の複製、影響および編集されたログを含めます。資格情報、顧客のコンテンツ、またはエクスプロイトの詳細を公開問題に含めないでください。機密ファイルを送信する前に、適切な安全な転送チャネルを要求してください。応答時間の保証や独立したセキュリティ認証は主張されていません。

現在、新しいオフライン インストールでは、文書化されたブートストラップ管理者 `admin` / `admin` が使用されます。アプライアンスをユーザーまたは信頼できないネットワークに公開する前に、そのパスワードを変更してください。これは公開の初期認証情報であり、スキャナーの許可リストに隠す秘密ではありません。通常のユーザー アカウントは自動的には作成されません。このオンボーディング動作の変更は、このライセンス変更の範囲外です。

## ソース/履歴のレビュー

除外されるデータ、履歴レビュー、資格情報ローテーションの責任については、[パブリック ソースのプライバシー境界](docs/open-source/SOURCE-PRIVACY.ja.md) を参照してください。

[リリースの準備](docs/open-source/RELEASING.ja.md) の説明に従って、固定されたローカル スキャナーを実行します。レポートは非​​公開で編集され、外部のスキャン サービスにアップロードされることはありません。実際の資格情報がプライベート履歴に表示される場合、HEAD からの削除は失効ではありません。所有者と一緒に取り消し/ローテーションします。履歴の書き換えや削除には別途許可が必要です。元の配送タグはサニタイズのために移動されません。

パブリック ソースの候補は、`.git`、プライベート証拠、デバイス スナップショット、ゲスト データ、または制限付きバイナリを含まない新しいファイル エクスポートです。この開発リポジトリの可視性を単に変更したり、古い参照を公開したりすることは**しないでください**。
