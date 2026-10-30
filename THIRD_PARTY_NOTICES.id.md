<!-- doc-navigation:start -->
[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md) · [繁體中文](THIRD_PARTY_NOTICES.zh-TW.md) · [日本語](THIRD_PARTY_NOTICES.ja.md) · [한국어](THIRD_PARTY_NOTICES.ko.md) · [Français](THIRD_PARTY_NOTICES.fr.md) · [Deutsch](THIRD_PARTY_NOTICES.de.md) · [Español](THIRD_PARTY_NOTICES.es.md) · [Português](THIRD_PARTY_NOTICES.pt-BR.md) · [Русский](THIRD_PARTY_NOTICES.ru.md) · [العربية](THIRD_PARTY_NOTICES.ar.md) · [हिन्दी](THIRD_PARTY_NOTICES.hi.md) · [Bahasa Indonesia](THIRD_PARTY_NOTICES.id.md) · [Italiano](THIRD_PARTY_NOTICES.it.md) · [Türkçe](THIRD_PARTY_NOTICES.tr.md) · [Tiếng Việt](THIRD_PARTY_NOTICES.vi.md) · [ไทย](THIRD_PARTY_NOTICES.th.md)

[Team AI Box — README](README.id.md)
<!-- doc-navigation:end -->

# Cakupan lisensi dan pemberitahuan pihak ketiga

Hak Cipta © 2026 Weerocks LLC. Lisensi root [MIT](LICENSE) mencakup kode Team AI Box asli dan dokumentasi yang disahkan oleh pemiliknya. Itu tidak melisensikan kembali kode pihak ketiga, file upstream yang disalin/dimodifikasi, dependensi, model, firmware, sistem operasi, font atau gambar. File hak cipta, LISENSI, dan PEMBERITAHUAN yang ada diutamakan untuk materinya masing-masing. Metadata paket `license: MIT` mengacu pada kode asli paket tersebut, tidak semuanya disertakan dalam gambar yang diterapkan. `private: true` disimpan untuk menghindari publikasi registri paket yang tidak disengaja; itu tidak mencabut hibah MIT.

## Inventaris

[Inventaris komponen](docs/open-source/components.json) yang dapat dibaca mesin mencatat versi atau sumber versi, bukti lisensi, cakupan redistribusi, dan kewajiban biner yang belum terselesaikan. [Inventaris ketergantungan](docs/open-source/dependencies.json) dihasilkan dari file kunci, metadata ketergantungan yang diinstal, modul Go, dan file persyaratan Python. Metadata lisensi yang hilang tidak diketahui secara eksplisit, tidak diasumsikan MIT. Regenerasi dengan `python3 tools/open_source_inventory.py`.

| Komponen/bahan | Batas izin | Persyaratan distribusi |
| --- | --- | --- |
| Penerima UxPlay dan `deploy/casting/uxplay-*.patch` | GPL-3.0-only | Pertahankan GPL, pemberitahuan, sumber upstream yang tepat, patch dan buat skrip dengan biner penerima apa pun; hanya menghubungkan ke upstream saja tidak cukup untuk rilis biner. |
| gst-plugins-rs / `gst-webrtc-*.patch` | MPL-2.0 | Simpan pemberitahuan dan sediakan file sumber tercakup yang dimodifikasi. |
| GStreamer | Lisensi LGPL dan plugin individual | Periksa kumpulan plugin yang sebenarnya dan penuhi kewajiban terkait. |
| SDK server/peramban LiveKit | Apache-2.0 | Simpan hak cipta, lisensi, dan PEMBERITAHUAN yang berlaku. |
| Sotong / AOSP | Apache-2.0 dan lisensi per file, termasuk kernel GPL | Pertahankan pemberitahuan hulu dan sumber terkait yang berlaku. AOSP tidak menyertakan lisensi layanan Google. |
| Driver QEMU / Linux / EDK II / virtio | Lisensi per proyek dan per file | Audit build biner, firmware, dan driver aktual; jangan memberi label menyeluruh pada MIT. |
| Guacamole | Apache-2.0 | Pertahankan LISENSI dan PEMBERITAHUAN yang disalin oleh Dockerfile plugin komputer. |
| Pohon ketergantungan Node / React / Vite dan JS | Lisensi per paket | Pertahankan pemberitahuan ketergantungan saat mendistribusikan output yang dibundel. |
| Paket OS PostgreSQL dan container | PostgreSQL / per paket | Sertakan catatan lisensi paket terinstal dalam rilis biner. |
| PyMuPDF / MuPDF digunakan oleh OCR | AGPL-3.0-or-later atau lisensi komersial | Distribusi/layanan gabungan pekerja OCR tidak mencakup MIT; mematuhi kewajiban AGPL atau memperoleh hak komersial. Kode asli dapat mempertahankan hibah MIT. |
| Aset model Qwen / LMT / Whisper / FLUX | Ketentuan model yang tepat | Model terpisah dari hibah sumber MIT. Ketentuan FLUX **4B** tidak boleh menggantikan model FLUX lainnya. |
| Bobot HunyuanOCR | Lisensi Komunitas Tencent Hunyuan | Lisensi model bersyarat; meninjau persyaratan penerima, wilayah, penggunaan, atribusi, dan redistribusi untuk setiap rilis. |
| perangkat lunak NVIDIA | NVIDIA dan menyertakan persyaratan pihak ketiga | Instalasi host Docker/NVIDIA yang ada tidak didistribusikan ulang oleh paket sumber ini. Pustaka CUDA/kontainer yang dibundel masih memerlukan tinjauannya sendiri. |
| Layanan Seluler Google / Play Store | Kepemilikan | Bukan bagian dari kandidat sumber publik. Kode integrasi runtime tidak memberikan hak untuk mendistribusikan gambar GMS. |
| Media instalasi Windows, disk tamu, akun | Tidak tercakup | Pengguna menyediakan media dan lisensi ISO resmi. Jangan pernah mengirimkan disk VM uji atau status tamu yang masuk. |
| Pensiunan ViKey SDK | Kepemilikan / tidak ada hibah publik yang ditetapkan | SDK dihapus dari sumber kerjanya; komitmen historis pribadi dan salinan SDK yang disimpan tidak boleh dipublikasikan. Tidak diperlukan kunci USB. |

Pemberitahuan casting yang sebenarnya tetap ada di [NOTICE.v4.txt](deploy/legal/airplay-compatible/NOTICE.v4.txt). Pemberitahuan transportasi ADB tetap berada di samping klien telepon. Jangan mengeluarkannya saat mengecilkan atau mengemas. Isolasi kontainer dengan sendirinya tidak membatalkan kewajiban copyleft. Analisis distribusi bergantung pada gabungan artefak yang sebenarnya.

## Merek dan kontributor

MIT memberikan izin hak cipta, bukan hak merek dagang atau dukungan. Team AI Box dan nama/logo Weerocks tidak boleh menyiratkan dukungan resmi untuk produk yang dimodifikasi. NVIDIA, DGX Spark, Android, Google Play, Windows dan Apple/AirPlay adalah milik masing-masing pemiliknya. Kompatibilitas bukanlah sertifikasi.

Metadata penulis lokal adalah inventaris, bukan bukti pengalihan hak cipta. Kategori kepemilikan yang ditinjau dicatat di [OWNERSHIP.md](docs/open-source/OWNERSHIP.id.md). Otorisasi pemilik proyek berlaku untuk kontribusi aslinya; kontributor hanya boleh mengirimkan karya yang menjadi hak mereka untuk mendapatkan lisensi. Atribusi yang diduga hilang: teamaibox@weerocks.llc.
