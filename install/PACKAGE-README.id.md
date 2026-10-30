<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.id.md)
<!-- doc-navigation:end -->

# Team AI Box paket instalasi offline

Lisensi untuk kode asli ada dalam paket `LICENSE`. Komponen pihak ketiga tetap mempertahankan lisensi aslinya; lihat `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json`. MIT tidak memberikan hak redistribusi tambahan untuk layanan Google, Windows, bobot model, atau merek pihak ketiga. Melewati pemeriksaan integritas paket tidak memberikan izin redistribusi untuk setiap komponen.

Paket ini ditujukan untuk DGX Spark baru yang mempertahankan sistem Linux pabrik yang kompatibel. Ia menggunakan lingkungan GPU Docker, Compose, dan NVIDIA yang ada tanpa menggantinya atau memformat disk sistem.

## Instalasi

Verifikasi arsip menggunakan file `.sha256` yang menyertainya, lalu ekstrak:

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

Instalasi normal tidak memerlukan akses internet publik atau pengeditan variabel lingkungan secara manual. Penginstal menyediakan paket alat yang diperlukan, menghasilkan konfigurasi lokal independen, menginisialisasi database baru, dan memulai layanan. Pemuatan model awal dapat memakan waktu; indikator pemuatan bukanlah konfirmasi keberhasilan instalasi.

Jalankan `sudo ./install.sh --check` untuk memeriksa lingkungan dan paket tanpa menginstal. `./install.sh --verify-package` hanya memeriksa isi paket dan juga dapat dijalankan di stasiun kerja pengemasan. Gunakan `--installation-root /dedicated/path/installation` untuk menentukan root instalasi baru; jangan pernah mengarahkannya pada data yang ada.

## Interupsi dan data yang ada

Setelah kegagalan atau gangguan, selesaikan masalah yang dilaporkan dan ulangi perintah awal. Jangan hapus direktori instalasi. Pemasang mempertahankan identitas dan data yang dihasilkannya. Menjalankan kembali instalasi lengkap dengan versi yang sama hanya akan memeriksa statusnya. Versi lain menggunakan jalur pemutakhiran formal, bukan penghapusan dan penginstalan ulang. Tidak ada opsi timpa paksa.

## Penggunaan pertama

Buka alamat HTTPS di IP alat saat ini dan masuk:

- Nama pengguna administrator: `admin`
- Kata sandi awal: `admin`

Pemasang membuat administrator ini secara otomatis; tidak diperlukan ekstraksi token pengaturan atau registrasi manual. Kata sandi awal bersifat publik dan sederhana: ubah di manajemen pengguna sebelum pengiriman/penggunaan. Pengguna biasa tidak memiliki akun default dan dibuat oleh administrator. Ini hanya berlaku untuk database akun yang kosong; lanjutkan, jalankan kembali, boot ulang, dan perbarui, jangan pernah menyetel ulang akun atau kata sandi yang ada ke default. Kode pemulihan administrator yang dibuat secara independen disimpan di bawah root instalasi di `secrets/initial-owner-recovery.json`, hanya dapat dibaca oleh root. Jangan pernah mengirim kode pemulihan ke obrolan, tiket, atau log publik. Instalasi yang ada tidak menghasilkan atau mengganti kode pemulihan. Untuk sertifikat HTTPS yang diterbitkan secara lokal, konfigurasikan kepercayaan browser sesuai dengan instruksi CA administrator. Nama dalam sertifikat tidak menjamin resolusi LAN DNS/mDNS. Sertifikat publik CA lokal biasanya berada di `/srv/teamaibox/installation/https/ca.crt`. Distribusikan hanya sertifikat publik tersebut, jangan pernah membagikan kunci pribadi di sampingnya.

Pemasangan tidak mencakup mesin virtual, status masuk Google, atau file pengguna yang ada. Pengguna mengunggah ISO Windows/Linux atau memilihnya dari drive tim, lalu menginstal sendiri sistem tamu. Google Play dan API eksternal memerlukan akses internet dan tidak termasuk dalam janji ketersediaan offline.

Teks lisensi komponen disimpan bersama sumber daya rilisnya. Hak Cipta © Weerocks LLC. Hubungi: teamaibox@weerocks.llc.
