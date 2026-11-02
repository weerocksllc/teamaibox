<!-- doc-navigation:start -->
[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md) · [繁體中文](CONTRIBUTING.zh-TW.md) · [日本語](CONTRIBUTING.ja.md) · [한국어](CONTRIBUTING.ko.md) · [Français](CONTRIBUTING.fr.md) · [Deutsch](CONTRIBUTING.de.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [Русский](CONTRIBUTING.ru.md) · [العربية](CONTRIBUTING.ar.md) · [हिन्दी](CONTRIBUTING.hi.md) · [Bahasa Indonesia](CONTRIBUTING.id.md) · [Italiano](CONTRIBUTING.it.md) · [Türkçe](CONTRIBUTING.tr.md) · [Tiếng Việt](CONTRIBUTING.vi.md) · [ไทย](CONTRIBUTING.th.md)

[Team AI Box — README](README.ja.md)
<!-- doc-navigation:end -->

# 貢献する

Team AI Box の改善にご協力いただきありがとうございます。初めての寄稿者を歓迎します。バグ レポート、翻訳、ドキュメント、アクセシビリティ、アプリケーションの統合、重点的なコード変更はすべて重要です。独立してチェックできるドキュメントやコンポーネントを改善するために、DGX Spark は必要ありません。

## アイデアからプルリクエストまで

1. [既存の問題](https://github.com/weerocksllc/teamaibox/issues) を検索します。ユーザーの問題、予想される動作、実際の動作、および関連するバージョンについて説明します。実装に投資する前に、より大きな変更について話し合ってください。
2. パブリック リポジトリをフォークし、フォークのクローンを作成します。焦点を絞ったブランチを作成します。プライベート マーケティング Web サイト、ランタイム データ、ダウンロードされたモデルは含まれません。
3. ノード、pnpm、およびローカル コンポーネントのビルドについては、[BUILDING](docs/open-source/BUILDING.ja.md) に従ってください。 Fresh-Appliance インストーラーは別のワークフローです。UI を開発するためだけにビジネス データを含むマシン上でインストーラーを実行しないでください。
4. 最小限の一貫した変更を加え、影響を受けるドキュメントを更新し、関連するチェックを実行します。実行できなかったハードウェアに依存するチェックについて説明します。
5. 問題、解決策、互換性への影響、チェックを記述したプル リクエストを開きます。目に見える変更については、サニタイズされたスクリーンショットを含めてください。レビューのフィードバックに返信します。メンテナはマージ前にレビューします。

ローカル OpenSpec ワークスペースはオプションであり、このリポジトリでは公開されません。一般の寄稿者は、提案や承認基準を号や PR に直接入れることができます。参加するにはプライベート仕様が欠けている必要はありません。

## 翻訳とスクリーンショット

詳細な機能チェックリストを更新する場合は `docs/readme-features/<locale>.json` を編集し、グループ・項目の ID と順序を英語版に合わせ、`docs/readme-features/evidence.json` のソース参照も保守してください。

17 の製品言語すべてに README があります。 `docs/readme-locales/<locale>.json` を編集して、`node tools/render-readmes.mjs` and `node tools/render-readmes.mjs --check` を実行します。生成された README を手動で編集しないでください。ロケール リストは `packages/ui-system/src/locale-registry.mjs` から取得されます。リンクされたインストール、ビルド、コントリビューション、セキュリティ、およびライセンスのガイドでは、同じ 17 言語が使用されています。彼らの文書リストは `docs/document-locales/manifest.json` にあります。 `docs/document-locales/<locale>.json` でソース言語のページと段落の翻訳を編集し、`node tools/render-documents.mjs`, `node tools/render-readmes.mjs` and `node tools/check-document-locales.mjs` を実行します。翻訳キーはソース段落の SHA-256 ハッシュです。ソースの変更は、対応する翻訳が更新されるまでレンダラーで失敗します。コード例はそのまま共有され、選択した言語に対してドキュメントのリンクが生成されます。新しい翻訳は、保護されたコードとリンクを含む機械支援の下書きです。言語や用語のレビューは歓迎です。生成とチェックは、翻訳サービス、API キー、またはアプライアンスへのアクセスを必要とせずに、ローカルで実行されます。公開画像を追加する前に、[スクリーンショット ポリシー](docs/assets/screenshots/README.ja.md) を参照してください。用語や自然な表現を含む翻訳は、レビューへの貢献を歓迎します。

## 投稿ルール

- オリジナルの投稿は、リポジトリの MIT ライセンスに基づいて送信されます。サードパーティのヘッダーを保持し、コピーされた素材のソース/ライセンスを記載します。別途の必須の CLA や有料の寄稿者の許可は必要ありません。
- ノード 24 と、`package.json` に固定された pnpm バージョンを使用します。 Python と Go の要件については、[BUILDING](docs/open-source/BUILDING.ja.md) で説明されています。
- 変更に関連するテストのみを実行し、実行された内容を正確に報告します。ローカル フィクスチャは、実際のデバイスの受け入れを保証するものではありません。文書の変更を終了するためだけに、過去の合格結果を繰り返したり消去したりしないでください。
- ユーザーのデータに対して削除、再インストール、または回復をテストしないでください。合成フィクスチャまたは明示的に指定された一時リソースを使用します。
- 問題/PR には、秘密キー、トークン、Cookie、顧客プロンプト/ファイル、サインインしたゲスト イメージ、プライベート展開スナップショット、または個人のスクリーンショットは含まれません。非公開レポートについては、[セキュリティ](SECURITY.ja.md) を参照してください。
- ワークスペース パッケージに `private: true` を保持します。共有 Git 履歴を書き換えたり、配信タグを移動したり、PR の一部としてプライベート ビルド アーティファクトを公開したりしないでください。

関連するテスト、移行、および動作の変更をコントリビューション内で文書化します。ハードウェアに依存するチェックでは、実際の構成と制限を特定する必要があります。
