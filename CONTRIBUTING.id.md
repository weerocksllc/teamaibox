<!-- doc-navigation:start -->
[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md) · [繁體中文](CONTRIBUTING.zh-TW.md) · [日本語](CONTRIBUTING.ja.md) · [한국어](CONTRIBUTING.ko.md) · [Français](CONTRIBUTING.fr.md) · [Deutsch](CONTRIBUTING.de.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [Русский](CONTRIBUTING.ru.md) · [العربية](CONTRIBUTING.ar.md) · [हिन्दी](CONTRIBUTING.hi.md) · [Bahasa Indonesia](CONTRIBUTING.id.md) · [Italiano](CONTRIBUTING.it.md) · [Türkçe](CONTRIBUTING.tr.md) · [Tiếng Việt](CONTRIBUTING.vi.md) · [ไทย](CONTRIBUTING.th.md)

[Team AI Box — README](README.id.md)
<!-- doc-navigation:end -->

# Berkontribusi

Terima kasih telah membantu meningkatkan Team AI Box. Kami menyambut kontributor pemula: laporan bug, terjemahan, dokumentasi, aksesibilitas, integrasi aplikasi, dan perubahan kode terfokus, semuanya diperhitungkan. Anda tidak memerlukan DGX Spark untuk menyempurnakan dokumen atau komponen yang dapat diperiksa secara independen.

## Dari ide hingga permintaan tarik

1. Cari [masalah yang ada](https://github.com/weerocksllc/teamaibox/issues). Jelaskan masalah pengguna, perilaku yang diharapkan, perilaku aktual, dan versi yang relevan. Diskusikan perubahan yang lebih besar sebelum berinvestasi dalam implementasi.
2. Fork repositori publik dan clone fork Anda. Buat cabang yang terfokus; tidak menyertakan situs web pemasaran pribadi, data runtime, atau model yang diunduh.
3. Ikuti [BUILDING](docs/open-source/BUILDING.id.md) untuk pembuatan Node, pnpm, dan komponen lokal. Penginstal peralatan baru memiliki alur kerja yang berbeda: jangan pernah menjalankannya di mesin yang berisi data bisnis hanya untuk mengembangkan UI.
4. Buat perubahan terkecil yang koheren, perbarui dokumentasi yang terpengaruh, dan jalankan pemeriksaan yang relevan. Jelaskan pemeriksaan apa pun yang bergantung pada perangkat keras yang tidak dapat Anda jalankan.
5. Buka permintaan tarik yang menjelaskan masalah, solusi, dampak kompatibilitas, dan pemeriksaan. Sertakan tangkapan layar yang sudah dibersihkan untuk perubahan yang terlihat. Menanggapi umpan balik ulasan; tinjauan pengelola sebelum penggabungan.

Ruang kerja OpenSpec lokal bersifat opsional dan tidak dipublikasikan dalam repositori ini. Kontributor publik dapat mencantumkan proposal dan kriteria penerimaan secara langsung dalam suatu terbitan atau PR; tidak diperlukan spesifikasi pribadi yang hilang untuk berpartisipasi.

## Terjemahan dan tangkapan layar

Semua 17 bahasa produk memiliki README. Edit `docs/readme-locales/<locale>.json`, lalu jalankan `node tools/render-readmes.mjs` and `node tools/render-readmes.mjs --check`. Jangan mengedit README yang dihasilkan secara manual. Daftar lokal berasal dari `packages/ui-system/src/locale-registry.mjs`. Panduan instalasi, pembuatan, kontribusi, keamanan, dan lisensi tertaut menggunakan 17 bahasa yang sama. Daftar dokumennya ada di `docs/document-locales/manifest.json`. Edit halaman bahasa sumber dan terjemahan paragraf di `docs/document-locales/<locale>.json`, lalu jalankan `node tools/render-documents.mjs`, `node tools/render-readmes.mjs` and `node tools/check-document-locales.mjs`. Kunci terjemahan adalah hash SHA-256 dari paragraf sumber; perubahan sumber membuat penyaji gagal hingga terjemahan terkait diperbarui. Contoh kode dibagikan kata demi kata, dan tautan dokumen dibuat untuk bahasa yang dipilih. Terjemahan baru adalah draf yang dibantu mesin dengan kode dan tautan yang dilindungi; tinjauan linguistik dan terminologi diterima. Pembuatan dan pemeriksaan dijalankan secara lokal, tanpa layanan terjemahan, kunci API, atau akses ke peralatan. Lihat [kebijakan tangkapan layar](docs/assets/screenshots/README.id.md) sebelum menambahkan gambar publik. Terjemahan, termasuk terminologi dan ungkapan alami, merupakan kontribusi ulasan yang diterima.

## Aturan kontribusi

- Kontribusi asli dikirimkan di bawah lisensi repositori MIT. Pertahankan header pihak ketiga dan sebutkan sumber/lisensi materi yang disalin. Tidak diperlukan CLA wajib terpisah atau izin kontributor berbayar.
- Gunakan Node 24 dan versi pnpm yang disematkan di `package.json`. Persyaratan Python dan Go dijelaskan di [BANGUNAN](docs/open-source/BUILDING.id.md).
- Jalankan hanya pengujian yang relevan dengan perubahan Anda dan laporkan dengan tepat apa yang dijalankan. Perlengkapan lokal bukan merupakan klaim penerimaan perangkat sebenarnya. Jangan mengulangi atau menghapus riwayat hasil penerimaan hanya untuk menutup perubahan dokumentasi.
- Jangan pernah menguji penghapusan, penginstalan ulang, atau pemulihan terhadap data pengguna. Gunakan perlengkapan sintetis atau sumber daya sementara yang ditentukan secara eksplisit.
- Tidak ada kunci pribadi, token, cookie, perintah/file pelanggan, gambar tamu yang masuk, snapshot penerapan pribadi, atau tangkapan layar pribadi dalam terbitan/PR. Lihat [KEAMANAN](SECURITY.id.md) untuk pelaporan pribadi.
- Pertahankan `private: true` pada paket ruang kerja. Jangan pernah menulis ulang riwayat Git yang dibagikan, memindahkan tag pengiriman, atau mempublikasikan artefak bangunan pribadi sebagai bagian dari PR.

Dokumentasikan pengujian, migrasi, dan perubahan perilaku yang relevan dalam kontribusi Anda. Pemeriksaan yang bergantung pada perangkat keras harus mengidentifikasi konfigurasi dan batasan sebenarnya.
