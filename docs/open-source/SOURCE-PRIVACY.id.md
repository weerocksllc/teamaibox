<!-- doc-navigation:start -->
[English](SOURCE-PRIVACY.md) · [简体中文](SOURCE-PRIVACY.zh-CN.md) · [繁體中文](SOURCE-PRIVACY.zh-TW.md) · [日本語](SOURCE-PRIVACY.ja.md) · [한국어](SOURCE-PRIVACY.ko.md) · [Français](SOURCE-PRIVACY.fr.md) · [Deutsch](SOURCE-PRIVACY.de.md) · [Español](SOURCE-PRIVACY.es.md) · [Português](SOURCE-PRIVACY.pt-BR.md) · [Русский](SOURCE-PRIVACY.ru.md) · [العربية](SOURCE-PRIVACY.ar.md) · [हिन्दी](SOURCE-PRIVACY.hi.md) · [Bahasa Indonesia](SOURCE-PRIVACY.id.md) · [Italiano](SOURCE-PRIVACY.it.md) · [Türkçe](SOURCE-PRIVACY.tr.md) · [Tiếng Việt](SOURCE-PRIVACY.vi.md) · [ไทย](SOURCE-PRIVACY.th.md)

[Team AI Box — README](../../README.id.md)
<!-- doc-navigation:end -->

# Batas privasi sumber publik

Repositori produk publik adalah cuplikan sumber baru, bukan cerminan sejarah pengembangan pribadi. Situs web pemasaran memiliki repositori pribadinya dan tidak disertakan di sini.

## Materi yang dihapus

- Memperbaiki nama akun dan kata sandi pengujian penerapan, dan daftar akun pribadi.
- Pembungkus dan skrip penerapan/pemulihan satu perangkat yang mencatat riwayat identitas perangkat atau menegaskan hasil dari bukti pribadi.
- Alamat host aktual, direktori beranda, identitas wadah/perangkat, dan cuplikan riwayat pemeliharaan. Pengujian yang dipertahankan menggunakan perlengkapan sintetis yang eksplisit; alat operasional yang dipelihara memerlukan masukan target yang eksplisit.
- Disk tamu, status login Android, sesi browser, paket instalasi, bobot model, dan bukti pribadi berada di luar distribusi sumber publik.

Arsip pribadi dan tag pengiriman asli tetap utuh. Tidak ada apa pun dalam pembersihan sumber ini yang mengubah akun peralatan, data tamu, layanan yang berjalan, atau penerapan situs web. Default pabrik `admin / admin` sengaja dipertahankan; ini bukan kredensial pribadi. Administrator harus mengubahnya sebelum pemaparan.

## Tinjau dan verifikasi

Tinjau pohon kerja dan setiap komit/tag yang dapat dijangkau dalam repositori yang sedang diterbitkan. Gunakan Gitleaks plus `tools/open_source_sensitive.py`; tidak satu pun bukti bahwa kata sandi dengan entropi rendah atau metadata pribadi tidak ada. Bandingkan nilai-nilai pribadi lama yang dikonfirmasi menggunakan daftar penolakan eksternal pribadi, bukan perlengkapan pengujian yang berkomitmen. Tinjau temuan yang tersisa satu per satu, termasuk file pengujian.

Pemeriksaan pembersihan adalah kebijakan sumber, regresi sintetik, konfigurasi, dan pemeriksaan sintaksis. Mereka tidak masuk menggunakan kredensial yang ditemukan, menginstal ulang kotak, atau mengulangi penerimaan produk. Koreksi pengemasan API sebelumnya (termasuk sumber UI bersama dan pemeriksaan titik masuk khusus impor) tetap ada di sumbernya.

Klon baru tidak boleh mengimpor komitmen, referensi, atau tag yang sudah tidak digunakan lagi. Menghapus repositori tidak akan mengingat salinan yang telah diunduh oleh orang lain. Tidak ada pemindaian yang dapat memastikan bahwa kredensial yang tidak diketahui tidak pernah disalin; kredensial yang benar-benar digunakan harus dirotasi oleh operatornya. Pembersihan ini tidak mengklaim telah memutarnya.

Lihat [RELEASING.md](RELEASING.id.md) untuk ekspor sumber dan petunjuk peninjauan dan [BUILDING.md](BUILDING.id.md) untuk prasyarat pembangunan dan aset yang diperoleh secara terpisah.
