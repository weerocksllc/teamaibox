<!-- doc-navigation:start -->
[English](RELEASING.md) · [简体中文](RELEASING.zh-CN.md) · [繁體中文](RELEASING.zh-TW.md) · [日本語](RELEASING.ja.md) · [한국어](RELEASING.ko.md) · [Français](RELEASING.fr.md) · [Deutsch](RELEASING.de.md) · [Español](RELEASING.es.md) · [Português](RELEASING.pt-BR.md) · [Русский](RELEASING.ru.md) · [العربية](RELEASING.ar.md) · [हिन्दी](RELEASING.hi.md) · [Bahasa Indonesia](RELEASING.id.md) · [Italiano](RELEASING.it.md) · [Türkçe](RELEASING.tr.md) · [Tiếng Việt](RELEASING.vi.md) · [ไทย](RELEASING.th.md)

[Team AI Box — README](../../README.id.md)
<!-- doc-navigation:end -->

# Lepaskan batasan

## Pisahkan artefak

1. **MIT kandidat sumber**: kode asli, spesifikasi terkini, alat build/test yang telah ditinjau, dan pemberitahuan; tidak ada riwayat Git atau bukti laboratorium swasta.
2. **Materi pihak ketiga**: sumber/biner/model upstream yang tepat dengan lisensi dan atribusinya sendiri. Kewajiban sumber Copyleft berjalan dengan biner.
3. **Paket peralatan offline lengkap**: dibuat oleh `install/`; tidak secara otomatis dilisensikan untuk didistribusikan kembali kepada publik. Komponen GMS, HunyuanOCR, NVIDIA dan lisensi tamu/firmware memerlukan peninjauan khusus artefak. Jangan publikasikan paket pribadi, paket model, atau gambar login di bawah label MIT.
4. **Situs web pemasaran**: `website/`, termasuk templat artikel, konten, aset desain, analitik, dan konfigurasi penerapannya, tetap berada di repositori GitHub `weerocksllc/teamaibox.com` pribadi. GitLab adalah arsip sejarah, bukan gudang pengembangan situs web. Situs web bukan bagian dari distribusi sumber produk publik. UI browser peralatan di `apps/` tetap menjadi bagian dari produk sumber terbuka.

Skrip penerapan, pemulihan, dan pencatatan bukti pada satu perangkat secara historis bukanlah alat produk yang dapat digunakan kembali. Kebijakan rilis tidak termasuk skrip dan snapshot yang dihentikan; jangan pulihkan dari arsip pribadi. Alat yang dipertahankan memerlukan target eksplisit yang disediakan oleh operator, bukan host, akun, kontainer, atau file bukti milik pengembang. Jalankan pemindaian sensitif tambahan serta Gitleaks: ID perangkat, ID kontainer, hash GSF, dan nama akun pribadi sedang menguji metadata meskipun kredensial login tersebut tidak dapat digunakan. Pembersihan riwayat publik memerlukan otorisasi pemilik yang jelas dan tidak boleh menulis ulang arsip pribadi atau tag pengirimannya. Setelah penulisan ulang resmi, gunakan klon publik baru daripada menggabungkan kembali riwayat yang dihentikan ke dalam repositori yang dikelola.

Repositori pengembangan internal dan tagnya tetap utuh. Riwayat yang dapat dijangkau berisi catatan penerapan lama dan aset SDK milik yang sudah tidak digunakan lagi; itu tidak boleh dipublikasikan tanpa perubahan. Pohon segar yang diekspor memberikan titik awal kepada publik tanpa secara diam-diam menulis ulang riwayat pengiriman asli.

## Persiapan lokal

Gunakan **Gitleaks 8.30.1**, diunduh dari rilis resmi GitHub dan verifikasi checksumnya. Alat audit tidak pernah menginstal paket sistem atau mengunggah data. Keluaran pribadi diabaikan `.runtime/open-source-audit/`, bukan PR publik.

```sh
python3 tools/open_source_release.py baseline --output .runtime/open-source-audit/before.json
python3 tools/open_source_release.py scan --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/review
python3 tools/open_source_sensitive.py --output .runtime/open-source-audit/project-review.json
python3 tools/open_source_inventory.py
python3 tools/open_source_release.py export --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/source-candidate
```

Keluaran harus berupa jalur baru; alat tersebut tidak pernah menimpa kandidat sebelumnya. Tinjau lokasi yang disunting, tidak hanya penting. Dokumentasikan perlengkapan sintetis, kredensial bootstrap publik, pengidentifikasi positif palsu, dan kredensial pribadi aktual/mungkin secara terpisah. Pemindaian pola tidak dapat memvalidasi kredensial atau tangkapan layar OCR. Artefak biner tidak termasuk, tidak dinyatakan bersih-scan. Pengekspor sumber hanya menerima file yang dikenal Git dan input eksplisit yang tidak terlacak di [release-policy.json](release-policy.json). Masukan baru yang belum terlacak perlu ditinjau. Ini menolak symlink dan traversal jalur dan mengeluarkan pengecualian SHA-256 plus per file. `website/` selalu dikecualikan, meskipun dilacak atau dicantumkan sebagai masukan yang tidak terlacak. Jangan pernah menyalin direktori `.git` repositori pribadi ke checkout publik. Sebelum memublikasikan, verifikasi bahwa pohon dan semua komitmen publik yang dapat dijangkau tidak berisi file situs web; menghapus file di komit selanjutnya tidak menghapus riwayat lama.

Pemeriksaan tambahan mencakup pesan komit/tag yang dapat dijangkau, kredensial entropi rendah dan literal login, identitas perangkat, dan alamat pengembangan. Pengujian tidak secara otomatis dikecualikan: jelaskan mengapa setiap perlengkapan yang disimpan adalah sintetis. Nilai pribadi yang diketahui dapat diberikan dengan `--denylist` sebagai larik JSON eksternal yang berisi data `{id, value, word?}`. Gunakan ID yang buram dan tidak sensitif; simpan file ini di luar checkout sumber. Laporan menunjukkan lokasi dan hash, bukan nilainya. Kecocokan penanda yang diketahui membuat pemeriksaan gagal. Gunakan `--scope worktree` saat membersihkan; periksa `--scope all` di repositori rilis tanpa orang tua yang baru sebelum dipublikasikan. Jangan publikasikan riwayat lama atau laporan ulasan pribadi.

Satu-satunya default administrator pabrik yang disengaja adalah `admin / admin`; mengubahnya selama penerapan. Alat pengujian penerapan/browser harus menerima kredensial akun yang ada melalui input lokal yang dilindungi. Akun uji asap yang baru dibuat menggunakan kredensial acak dan dinonaktifkan selama pembersihan. Pembersihan yang gagal adalah kegagalan pengujian, bukan keberhasilan pelaksanaan. Penghentian proses secara tiba-tiba dapat mencegah pembersihan; operator harus merekonsiliasi akun sementara mereka setelah gangguan tersebut. Tidak ada dokumen publik yang mengklaim bahwa kredensial tes saat ini valid.

Hanya titik masuk `install/` yang dipertahankan yang merupakan jalur pemasangan peralatan bersih. Penilaian kepemilikan komponen ada di [OWNERSHIP.md](OWNERSHIP.id.md).

Tidak ada perintah di sini yang mendorong Git, mengubah visibilitas, menulis ulang riwayat, merotasi kredensial langsung, mengubah perangkat, atau memberikan hak redistribusi pihak ketiga. Rilis publik memerlukan tujuan publik yang dipilih secara eksplisit dan tinjauan artefak akhir. Pertahankan `delivery-2026-10-22` di repositori pribadi.
