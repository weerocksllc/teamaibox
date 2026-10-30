<!-- doc-navigation:start -->
[English](SOURCE-INSTALL.md) · [简体中文](SOURCE-INSTALL.zh-CN.md) · [繁體中文](SOURCE-INSTALL.zh-TW.md) · [日本語](SOURCE-INSTALL.ja.md) · [한국어](SOURCE-INSTALL.ko.md) · [Français](SOURCE-INSTALL.fr.md) · [Deutsch](SOURCE-INSTALL.de.md) · [Español](SOURCE-INSTALL.es.md) · [Português](SOURCE-INSTALL.pt-BR.md) · [Русский](SOURCE-INSTALL.ru.md) · [العربية](SOURCE-INSTALL.ar.md) · [हिन्दी](SOURCE-INSTALL.hi.md) · [Bahasa Indonesia](SOURCE-INSTALL.id.md) · [Italiano](SOURCE-INSTALL.it.md) · [Türkçe](SOURCE-INSTALL.tr.md) · [Tiếng Việt](SOURCE-INSTALL.vi.md) · [ไทย](SOURCE-INSTALL.th.md)

[Team AI Box — README](../README.id.md)
<!-- doc-navigation:end -->

# Instal dari klon publik

Titik masuk ini mempersiapkan masukan publik yang diperlukan, membangun gambar aplikasi dan menghasilkan paket lengkap sebelum menginstalnya. Kemajuan pembangunan dapat dilanjutkan; hanya hasil kesiapan pemasangan akhir yang menunjukkan peralatan terpasang. Keberhasilan pengunduhan atau pra-penerbangan saja tidak cukup.

Simpan model yang dihasilkan, gambar kontainer, paket instalasi, catatan pengujian, dan kredensial di luar repositori. Ketersediaan mirror pihak ketiga tidak dijamin; cache portabel terverifikasi dan paket offline dijelaskan di bawah ini.

Pada DGX Spark baru dengan Ubuntu 24.04, Docker/Compose yang berfungsi, NVIDIA dan KVM, kloning repositori publik dan jalankan dari root-nya:

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Untuk jaringan Tiongkok daratan di mana titik akhir model/gambar upstream tidak dapat dijangkau, gunakan titik masuk yang sama dengan sumber unduhan regional:

```sh
sudo bash install/from-source.sh --region cn
```

Ini adalah **pembuatan sumber online diikuti dengan pemasangan offline**, bukan pembuatan sumber offline. Secara otomatis menyiapkan alat pembangunan yang hilang, mengunduh enam input model, membangun dan merakit Android dan semua gambar aplikasi, mengkuantisasi dua model sumber, mengumpulkan paket firmware/host, membuat paket offline lengkap dan menjalankan penginstal yang ada. Itu tidak menggantikan Docker/NVIDIA, memulai ulang daemon Docker, menghapus instalasi yang ada, atau mengubah perutean host, pengaturan DNS atau VPN. Model, status login tamu, dan situs web pemasaran pribadi tidak diambil dari instalasi lain.

Ruang kerja defaultnya adalah `/var/tmp/teamaibox-source-build`; unduh cache dan log per tahap langsung di sana, di luar klon. Instalasi defaultnya adalah `/srv/teamaibox/installation`. Harapkan unduhan besar dan penggunaan disk sementara beberapa ratus GB. Pemuatan model dan kuantisasi GPU dapat memakan waktu lama; tidak ada waktu penyelesaian tetap yang dijanjikan.

## Melanjutkan instalasi dan memeriksa status

Jika terputus, **jalankan kembali perintah yang sama persis**. Jaga ruang kerja. Build yang berjalan mengecualikan penulis lain; file tahap dan gambar yang telah selesai diverifikasi sebelum digunakan kembali. Upaya yang gagal tetap tersedia untuk diagnosis, sedangkan upaya berikutnya hanya menjalankan tahap yang gagal. Rentang byte model dan file terverifikasi dipertahankan. `state.json` mengidentifikasi tahapan saat ini dan direktori lognya. Pengunduhan model resmi menggunakan konkurensi file/rentang yang dibatasi; sumber regional menggunakan konkurensi konservatif untuk mengurangi pembatasan tarif. Laporan kemajuan byte per file yang ditransfer atau digunakan kembali berkisar secara terpisah dari verifikasi hash penerbit akhir. Kompilasi alat tamu juga berfungsi di bawah layanan sistem tanpa login home: kompilasi ini membuat cache build terisolasi di luar aset instalasi yang dihasilkan.

Perubahan sumber memerlukan `--work-dir` baru; gunakan kembali cache unduhan dengan `--cache-dir /path/to/public-cache`. Sidik jari sumber mencegah penggabungan keluaran dari kode yang berbeda secara diam-diam. Instalasi yang sudah ada bukan merupakan undangan untuk mengatur ulang: hanya instalasi paket yang sama di ruang kerja ini yang dapat dilanjutkan; instalasi lain harus menggunakan proses peningkatannya.

Mode yang berguna:

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh --region cn --download-models-only
sudo bash install/from-source.sh --region cn --build-only
```

`--check` bersifat hanya baca dan tidak mengklaim pengunduhan akan berhasil. Download-only dan build-only secara eksplisit tidak mengklaim kesiapan instalasi.

## Sumber dan integritas regional

Mode Tiongkok menggunakan `https://hf-mirror.com` untuk transfer model dan `https://docker.m.daocloud.io` untuk input Docker Hub yang disematkan intisari. Ini adalah mirror pihak ketiga, bukan layanan yang dioperasikan oleh Weerocks atau penerbit model. Model Git commit disematkan oleh profil produk; pohon Git dan penunjuk LFS yang terverifikasi menetapkan ukuran file dan hash yang diharapkan. Respons API mirror saja tidak dapat membangun kepercayaan. Docker memverifikasi manifes/cernaan lapisan yang disematkan. Tag yang tidak dipasangi pin tidak akan dialihkan secara otomatis (alat build Go memiliki kunci intisari yang eksplisit). NVIDIA gambar tetap ada di registri penerbitnya. Verifikasi TLS tetap aktif dan tidak ada token akun yang dikirim ke mirror model.

Anda dapat memilih asal HTTPS Anda sendiri menggunakan `--model-endpoint` and `--registry-mirror`. Nilai titik akhir tidak boleh menyertakan kredensial atau parameter kueri. Pembungkus Docker yang tercakup hanya berlaku untuk proses pembangunan ini, bukan daemon sistem atau proyek lainnya. Metadata SDK dan arsip lisensi masih berasal dari penerbit HTTPS resminya; cermin tidak dapat menciptakan hash.

Cermin dapat dibatasi tarifnya atau tidak tersedia. Pengunduhan model dijalankan dengan konkurensi terbatas dan menghormati cooldown. Tidak ada skrip yang dapat menjamin konektivitas ke setiap upstream di setiap jaringan. Jika kedua rute tidak tersedia, siapkan unduhan atau paket lengkap pada mesin kompatibel yang dapat diakses dan salin ke:

- `--download-models-only --cache-dir <public-cache>` menyiapkan file model terverifikasi dan cache yang dapat dilanjutkan. Salin direktori tersebut, lalu teruskan dengan `--cache-dir` pada target. Setiap model yang digunakan kembali diperiksa identitasnya yang disematkan. Cache ini **bukan** paket instalasi offline penuh.
- `--build-only` menyiapkan paket lengkap untuk instalasi offline. Salin tar dan checksumnya, verifikasi dan buka kemasannya, lalu jalankan `sudo ./install.sh` di dalamnya. Ini adalah rute host terputus yang dapat diandalkan; itu tidak memerlukan VPN pada target atau akses ke kotak pengembangan.

Jangan pernah menyalin direktori data Docker langsung, disk tamu, profil browser, database akun, kredensial, atau cache pribadi sebagai pengganti input publik. Jangan menonaktifkan checksum atau menerima halaman login/tantangan sebagai file model.

## Lisensi dan penggunaan pertama

Tinjau `THIRD_PARTY_NOTICES.md`, persyaratan SDK Android, dan lisensi model individual sebelum membuat. Mengunduh komponen pihak ketiga tidak mengubahnya menjadi aset MIT atau memberikan hak sertifikasi/distribusi ulang kepada Google. Media ISO Windows/Linux masih disediakan oleh pengguna. Login pabrik tetap `admin/admin`; gantilah sebelum memaparkan alat. Penginstal yang ada menghasilkan kredensial layanan independen dan melaporkan kesiapan aktual.

Setelah selesai, buka `https://<BOX_LAN_IP>/` di LAN yang sama; gantikan alamat jaringan fisik Spark saat ini, bukan jembatan Docker atau alamat VPN. `state.json` mencatat kemajuan pembangunan. `/srv/teamaibox/installation/readiness.json` mencatat pemeriksaan instalasi. Baik kompilasi yang berhasil maupun pemeriksaan kesehatan wadah pendengaran tidak dapat menggantikan operasi end-to-end aplikasi yang terlihat.

Waktu proses casting harus berisi penerima UxPlay, D-Bus pribadi, dan executable penemuan Avahi serta plugin medianya. Pembuatan citra publik akhir memeriksa executable ini; perpustakaan klien saja tidak cukup. Penginstalan baru akan mendaftarkan proksi desktop dan gateway dengan dependen namespace jaringan API lainnya sehingga pemutakhiran API yang dikelompokkan dapat mempertahankan jalur koneksi desktop. Jangan membuat ulang hanya sebagian dari grup tersebut selama pemeliharaan.
