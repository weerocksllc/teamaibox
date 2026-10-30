<!-- doc-navigation:start -->
[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md) · [繁體中文](THIRD_PARTY_NOTICES.zh-TW.md) · [日本語](THIRD_PARTY_NOTICES.ja.md) · [한국어](THIRD_PARTY_NOTICES.ko.md) · [Français](THIRD_PARTY_NOTICES.fr.md) · [Deutsch](THIRD_PARTY_NOTICES.de.md) · [Español](THIRD_PARTY_NOTICES.es.md) · [Português](THIRD_PARTY_NOTICES.pt-BR.md) · [Русский](THIRD_PARTY_NOTICES.ru.md) · [العربية](THIRD_PARTY_NOTICES.ar.md) · [हिन्दी](THIRD_PARTY_NOTICES.hi.md) · [Bahasa Indonesia](THIRD_PARTY_NOTICES.id.md) · [Italiano](THIRD_PARTY_NOTICES.it.md) · [Türkçe](THIRD_PARTY_NOTICES.tr.md) · [Tiếng Việt](THIRD_PARTY_NOTICES.vi.md) · [ไทย](THIRD_PARTY_NOTICES.th.md)

[Team AI Box — README](README.ja.md)
<!-- doc-navigation:end -->

# ライセンスの範囲とサードパーティの通知

著作権 © 2026 Weerocks LLC。ルート [MIT ライセンス](LICENSE) は、所有者によって承認された元の Team AI Box コードとドキュメントをカバーします。サードパーティのコード、コピーまたは変更されたアップストリーム ファイル、依存関係、モデル、ファームウェア、オペレーティング システム、フォント、またはイメージの再ライセンスは行われません。既存の著作権、ライセンス、および通知ファイルは、それぞれの素材に対して優先されます。パッケージ メタデータ `license: MIT` は、デプロイされたイメージに含まれるすべてではなく、そのパッケージの元のコードを指します。 `private: true` は、パッケージ レジストリの誤った公開を避けるために保持されます。 MIT の付与は取り消されません。

## 在庫

機械可読の [コンポーネント インベントリ](docs/open-source/components.json) には、バージョンまたはバージョン ソース、ライセンスの証拠、再配布範囲、および未解決のバイナリ義務が記録されます。 [依存関係インベントリ](docs/open-source/dependencies.json) は、ロックファイル、インストールされた依存関係メタデータ、Go モジュール、Python 要件ファイルから生成されます。欠落しているライセンス メタデータは明示的に不明であり、MIT とは想定されていません。 `python3 tools/open_source_inventory.py` で再生成します。

|成分・材質 |ライセンス境界 |配布要件 |
| --- | --- | --- |
| UxPlay レシーバーと `deploy/casting/uxplay-*.patch` | GPL-3.0-only | GPL、通知、正確な上流ソース、パッチを保持し、受信側バイナリを使用してスクリプトをビルドします。アップストリームにリンクするだけでは、バイナリ リリースには不十分です。 |
| gst-plugins-rs / `gst-webrtc-*.patch` | MPL-2.0 |通知を保持し、修正された対象ソース ファイルを利用できるようにします。 |
|ジーストリーマー | LGPL および個々のプラグインのライセンス |実際のプラグイン セットを検査し、対応する義務を果たします。 |
| LiveKitサーバー/ブラウザSDK | Apache-2.0 |著作権、ライセンス、および該当する通知を保持します。 |
|イカ / AOSP | Apache-2.0 およびファイルごとのライセンス (GPL カーネルを含む) |上流の通知と該当する対応するソースを保存します。 AOSP には Google サービス ライセンスは含まれません。 |
| QEMU / Linux / EDK II / virtio ドライバー |プロジェクトごとおよびファイルごとのライセンス |実際のバイナリ ビルド、ファームウェア、ドライバーを監査します。 MIT を包括的にラベル付けしないでください。 |
|ワカモレ | Apache-2.0 |コンピューター プラグインの Dockerfile によってコピーされたライセンスと通知を保存します。 |
| Node / React / Vite および JS 依存関係ツリー |パッケージごとのライセンス |バンドルされた出力を配布するときに依存関係の通知を保持します。 |
| PostgreSQL とコンテナ OS パッケージ | PostgreSQL / パッケージごと |インストール済みパッケージのライセンス レコードをバイナリ リリースに含めます。 |
| OCR で使用される PyMuPDF / MuPDF | AGPL-3.0-or-later または商用ライセンス | OCR ワーカーのディストリビューションとサービスを組み合わせたものは、包括的な MIT ではありません。 AGPL の義務を遵守するか、商業権を取得します。元のコードはその MIT 付与を保持する場合があります。 |
| Qwen / LMT / Whisper / FLUX モデル アセット |正確なモデルの条件 |モデルは、MIT ソース付与とは別のものです。 FLUX **4B** の用語を別の FLUX モデルに置き換えてはなりません。 |
| HunyuanOCR 重み | Tencent Hunyuan コミュニティ ライセンス |条件付きモデルライセンス。各リリースの受信者、地域、使用法、帰属、再配布条件を確認してください。 |
| NVIDIA ソフトウェア | NVIDIA およびサードパーティの規約を含む |既存のホスト Docker/NVIDIA インストールは、このソース パッケージでは再配布されません。バンドルされた CUDA/コンテナ ライブラリは依然として独自のレビューが必要です。 |
| Google モバイル サービス / Play ストア |独自の |公開ソース候補には含まれていません。ランタイム統合コードは、GMS イメージを配布する権限を付与しません。 |
| Windows インストール メディア、ゲスト ディスク、アカウント |対象外 |ユーザーは、承認された ISO メディアとライセンスを提供します。テスト VM ディスクやサインインしたゲスト状態は決して出荷しないでください。 |
|廃止された ViKey SDK |独自の/公的助成金は確立されていない | SDK が作業ソースから削除されました。プライベートな履歴コミットと保持されている SDK コピーは公開してはなりません。 USB キーは必要ありません。 |

正確なキャスト通知は [NOTICE.v4.txt](deploy/legal/airplay-compatible/NOTICE.v4.txt) に残っています。 ADB トランスポート通知は電話クライアントの横に残ります。縮小中またはパッケージ化中にこれらを取り外さないでください。コンテナーを分離しても、それ自体ではコピーレフトの義務が取り消されるわけではありません。分布分析は、実際に組み合わされたアーティファクトに依存します。

## ブランドと貢献者

MIT は著作権の許可を与えるものであり、商標権や承認を与えるものではありません。 Team AI Box および Weerocks の名前/ロゴは、変更された製品の公式サポートを暗示してはなりません。 NVIDIA、DGX Spark、Android、Google Play、Windows および Apple/AirPlay はそれぞれの所有者に属します。互換性は認証ではありません。

ローカル作成者のメタデータは目録であり、著作権譲渡の証拠ではありません。確認された所有権カテゴリは [OWNERSHIP.md](docs/open-source/OWNERSHIP.ja.md) に記録されます。プロジェクト所有者の承認は、その元の投稿に適用されます。寄稿者は、ライセンスを取得する権利のある作品のみを提出する必要があります。帰属が不明である可能性があります:teamaibox@weerocks.llc。
