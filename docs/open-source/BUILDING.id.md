<!-- doc-navigation:start -->
[English](BUILDING.md) · [简体中文](BUILDING.zh-CN.md) · [繁體中文](BUILDING.zh-TW.md) · [日本語](BUILDING.ja.md) · [한국어](BUILDING.ko.md) · [Français](BUILDING.fr.md) · [Deutsch](BUILDING.de.md) · [Español](BUILDING.es.md) · [Português](BUILDING.pt-BR.md) · [Русский](BUILDING.ru.md) · [العربية](BUILDING.ar.md) · [हिन्दी](BUILDING.hi.md) · [Bahasa Indonesia](BUILDING.id.md) · [Italiano](BUILDING.it.md) · [Türkçe](BUILDING.tr.md) · [Tiếng Việt](BUILDING.vi.md) · [ไทย](BUILDING.th.md)

[Team AI Box — README](../../README.id.md)
<!-- doc-navigation:end -->

# Bangun sumbernya

Artefak publik adalah sumber, bukan gambar peralatan offline bawaan. Pembuatan sumber dapat mengunduh dependensi; instalasi menggunakan paket lengkap yang telah disiapkan tetap offline. Tidak ada proses yang memerlukan ViKey SDK atau kunci USB.

Untuk instalasi peralatan lengkap, mulailah dengan root [mulai cepat](../../README.id.md#install) dan [penginstal sumber](../../install/SOURCE-INSTALL.id.md): `sudo bash install/from-source.sh` mengunduh, membangun, mengemas, dan menginstal pada Spark baru yang kompatibel. Pembuatan web pengembangan di bawah ini bukanlah penginstal tersebut dan tidak memulai produk lengkap.

## Pengembangan

Gunakan Node.js 24, pnpm 11.1.3 (lihat root `package.json`), Python 3.10+ dan versi Go yang dideklarasikan di setiap `go.mod` (node-agent saat ini 1.26). Pada mesin build:

Ekspor sumber sengaja tidak memiliki riwayat Git pribadi. Sebelum menjalankan alat sumber pada pohon yang diekspor tersebut, inisialisasi repositori Anda sendiri dan komit pohon yang telah Anda tinjau (`git init`, `git add .`, `git commit`). Klon Git publik normal tidak memerlukan langkah ini. Gunakan komitmen baru tersebut sebagai identitas build; jangan mengklaim pohon yang diekspor dan dimodifikasi adalah komitmen pengiriman yang lama.

```sh
pnpm install --frozen-lockfile
pnpm --filter @teamaibox/web build
python3 tools/open_source_inventory.py --check
```

Pembuatan web adalah pemeriksaan kompilasi, bukan penerimaan produk. Layanan runtime menggunakan Dockerfiles di bawah `deploy/`. Eksekusi DGX Spark memerlukan Linux ARM64 dan lingkungan NVIDIA/Docker yang ada. Checkout sumber desktop bukanlah pengganti perangkat keras tersebut. Jangan gunakan skrip lab historis sebagai penginstal.

Pembantu pembangunan pabrik Python juga memerlukan PyYAML; lihat preflight ketergantungan penginstal. Tidak diperlukan disk sistem operasi atau akun pengembang yang terpasang.

## Input terkompilasi tidak termasuk

Eksportir menghilangkan file biner, meskipun ekstensinya terlihat tidak berbahaya:

- Bangun `services/node-agent` dan pembantunya `cmd/factory-worker-spec` dari sumber Go; executable repositori-root `node-agent` bukan input sumber.
- APK perlengkapan Android dan file penandatanganan tidak dikirimkan. Sumber dan manifesnya pada `tools/fixtures/` tetap tersedia untuk versi pengujian lokal.
- Pembuatan casting peralatan saat ini menggunakan `deploy/appliance/wireless-casting-plugin.Dockerfile`. Itu tidak memerlukan arsip paket Alpine yang lama. Jika Anda menggunakan plugin mandiri Dockerfile, dapatkan paket persis yang diidentifikasi dalam [manifes checksum hulu](../../apps/wireless-casting-plugin/vendor/alpine/security-update-20261010.json) dan verifikasi nilai SHA-256 sebelum membangun. Jangan pernah mengganti paket sembarangan ketika artefak upstream yang disematkan tidak tersedia.
- Modul browser LiveKit dan lisensinya tetap berada di direktori sumber publik plugin; arsip npm `.tgz` yang berlebihan tidak dikirimkan.

Ini adalah pengecualian distribusi sumber, bukan perubahan pada peralatan yang sedang berjalan.

## Paket offline lengkap

Mulailah dengan [pipa sumber publik](../../install/PUBLIC-BUILD.id.md). Ini memasok gambar induk publik dan dependensi runtime yang dibuat oleh sumber; instalasi pengembang sebelumnya tidak diperlukan. Resep gambar berlapis historis bukanlah titik masuk instalasi baru.

Ikuti [install/README.md](../../install/README.id.md) untuk pembuatan gambar aplikasi, alat host tamu, paket host offline, pengumpulan aset, dan pengemasan akhir. Appliance target tidak mengambil dependensi atau menggantikan Docker/NVIDIA. Tetapkan input build ke penerapan sumber aktual Anda, ID konten ARM64 OCI, dan jalur aset bersih. Tidak diperlukan IP host pengembangan, akun, sertifikat, atau volume. Bobot model dan aset tamu/runtime diperoleh secara terpisah dari sumber upstream persis yang diidentifikasi di [components.json](components.json) dan kunci repositori. Pertahankan lisensi mereka dan pemberitahuan sumber yang diperlukan.

**Ketersediaan sumber bukan izin redistribusi biner.** Kontrak paket offline lengkap saat ini mencakup runtime Google Android; bukti pemasangan pribadinya bukanlah izin untuk mendistribusikan RUPS. Packager yang ada tetap dipertahankan tidak berubah, namun paket tersebut bukan merupakan download publik yang disetujui kecuali hak tersebut diperoleh. Edisi biner publik khusus AOSP akan menjadi perubahan kemasan dengan cakupan terpisah, tidak diganti secara diam-diam di sini. File ISO Windows/Linux disediakan oleh setiap pengguna; tidak ada tamu pengujian yang diinstal atau status akun yang merupakan input build publik.
