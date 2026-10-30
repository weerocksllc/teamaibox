<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../README.ja.md)
<!-- doc-navigation:end -->

# ARM 仮想コンピュータ ランタイム

`Public.Dockerfile` は、元の `windows-arm64-ppi` ランタイムに必要な同じ ARM TPM 物理プレゼンス (PPI) 機能を構築します。固定されたリリースマネージャーのフィンガープリントに対して切り離された署名を検証した後、正式リリースから QEMU 11.1.1 をビルドします。 Debian は、ゲストの実行に使用される QEMU 実行可能ファイルではなく、コンテナ ライブラリとツールを提供します。

この実行可能ファイルを古い配布 QEMU パッケージに置き換えないでください。 Windows プロファイルは `tpm-tis-device,...,ppi=on` を有効にします。その ARM プロパティを持たないビルドは、ファームウェアが開始される前に終了します。 `ppi=on` の削除、TPM の無効化、ゲストの TPM のリセットは互換性のある修復ではありません。

最終的なイメージ ビルドでは、ARM TIS PPI と PulseAudio のサポートがチェックされ、一致する RAM フレームバッファ ROM が含まれます。 ARM KVM ホストでは、バンドルされている `python3 /usr/local/bin/probe-ppi` がディスクレスの一時停止された QEMU/TPM チェックを実行します。既存のゲスト ディスクをマウントしたり、Windows のインストールが完了したことを証明したりするものではありません。 Windows のブートは、明示的に指定されたテスト ゲストで個別にチェックする必要があります。

既存のインストールの場合は、プラットフォームのランタイム更新ポリシーと、一致するノード エージェント プロファイル イメージ ダイジェストを使用します。ディスク、ファームウェア、TPM の ID と状態を保持します。 Windows ランタイムを修復するためだけにゲストを再作成したり、実行中の Linux ゲスト イメージを変更したりしないでください。ソースの変更がコミットされてリリースされるまで、ローカルで構築されたイメージを未公開として記録します。

インストールされた構成を更新するときに、その所有権と読み取り権限を保持します。ランタイム更新ポリシーをロードするためにプラットフォーム API が再作成された場合は、変更されていないイメージからそのネットワーク名前空間依存 (`node-agent`, `appliance-gateway`, `desktop-proxy`, `desktop-gateway` および `maintenance-controller`) も再作成されます。これらは、新しい API コンテナのネットワーク名前空間に参加する必要があります。これはゲスト、Docker デーモン、AI ワーカーの再起動ではありません。 Windows の開始操作を送信する前に、ノードの通常の認証済みハートビートが準備完了状態に戻るのを待ちます。
