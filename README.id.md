<!-- Generated from docs/readme-locales/ and docs/readme-features/id.json by tools/render-readmes.mjs. -->
# Team AI Box — Perangkat lunak sumber terbuka untuk NVIDIA DGX Spark

<p><img src="docs/assets/brand/mascot.png" alt="Team AI Box" width="160" height="160"></p>

**Powered by NVIDIA DGX Spark · MIT · Weerocks LLC**

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

**Jadikan NVIDIA DGX Spark ruang kerja AI tim Anda.** Jalankan AI lokal, pembuatan gambar, dan alat dokumen di NVIDIA DGX Spark. Team AI Box menyatukan file tim, pesan, dan perangkat virtual dalam ruang kerja sumber terbuka melalui browser.

[teamaibox.com](https://teamaibox.com/) · [GitHub](https://github.com/weerocksllc/teamaibox) · [MIT](LICENSE) · [teamaibox@weerocks.llc](mailto:teamaibox@weerocks.llc)

[Daftar lengkap fitur](#features) · [Instal pada DGX Spark baru](#install) · [Mari berkontribusi](#contribute)

## Mengapa Team AI Box?

- **Satu ruang kerja:** antarmuka dan akun yang konsisten untuk AI, kolaborasi, dan perangkat.
- **Mengutamakan AI lokal.** Jalankan inferensi model pada Spark Anda dan hubungkan API model eksternal bila diperlukan.
- **Dibuat untuk DGX Spark.** Instal pada Ubuntu ARM64 dengan kontainer GPU NVIDIA dan virtualisasi KVM.
- **Terbuka untuk kontribusi:** kode asli MIT, 17 bahasa, tema terang/gelap dan pilihan manual tersimpan. Bahasa awal adalah Inggris.

## Ruang kerja sebenarnya

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/id/workbench-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/id/workbench-light.jpg">
  <img src="docs/assets/screenshots/id/workbench-light.jpg" alt="Ruang kerja Team AI Box untuk NVIDIA DGX Spark dengan aplikasi AI dan alat tim — Bahasa Indonesia" width="1280">
</picture>

[Tema terang](docs/assets/screenshots/id/workbench-light.jpg) · [Tema gelap](docs/assets/screenshots/id/workbench-dark.jpg)

<a id="features"></a>

## Daftar lengkap fitur

**Langsung ke modul**

- [Ruang kerja dan navigasi sehari-hari](#feature-workspace)
- [Asisten AI dan alur kerja Agen yang terkendali](#feature-assistant)
- [Pembuatan gambar dengan AI](#feature-drawing)
- [Pengenalan dan koreksi teks](#feature-ocr)
- [Transkripsi rekaman dan ucapan langsung](#feature-transcription)
- [Terjemahan teks, berkas, dan media](#feature-translation)
- [Pesan tim](#feature-messaging)
- [Drive tim dan kolaborasi berkas](#feature-drive)
- [Pencerminan layar nirkabel yang kompatibel dengan AirPlay](#feature-casting)
- [Ponsel Android virtual dengan data persisten](#feature-phones)
- [Komputer Windows dan Linux virtual](#feature-computers)
- [Administrasi, izin, dan keamanan](#feature-administration)
- [Instalasi dari kode sumber dan pemeliharaan](#feature-installation)
- [Pengembangan sumber terbuka dan ekstensi](#feature-developers)

<a id="feature-workspace"></a>

### Ruang kerja dan navigasi sehari-hari

- Gunakan satu ruang kerja di peramban untuk AI lokal, kolaborasi tim, dan perangkat virtual pada satu DGX Spark.
- Jelajahi aplikasi berdasarkan kategori, cari di katalog aplikasi, dan buka aplikasi dari bilah samping.
- Lihat kemajuan pemuatan, ketersediaan, dan status layanan setiap aplikasi.
- Pantau pekerjaan yang mengantre, berjalan, selesai, gagal, dan dibatalkan di pusat tugas; buka hasil yang tersedia.
- Lihat undangan pencerminan layar yang menunggu tanggapan di menu notifikasi dan buka aplikasi pencerminan layar untuk menanggapinya.
- Pilih dari 17 bahasa antarmuka, termasuk bahasa Arab yang ditulis dari kanan ke kiri; bahasa Inggris menjadi bawaan sampai Anda memilih bahasa lain.
- Gunakan tampilan terang, gelap, atau sesuai sistem; pilihan bahasa dan tema manual tetap tersimpan setelah memuat ulang, masuk kembali, dan berpindah aplikasi.

<a id="feature-assistant"></a>

### Asisten AI dan alur kerja Agen yang terkendali

- Mulai percakapan, simpan riwayatnya, dan buka kembali diskusi sebelumnya.
- Pilih mode Otomatis, Jawaban, atau Agen untuk permintaan saat ini.
- Lampirkan beberapa berkas pada permintaan dan hapus lampiran sebelum mengirim.
- Baca jawaban saat dihasilkan, hentikan proses aktif, dan lanjutkan aliran peristiwanya setelah tersambung kembali.
- Periksa detail model yang dikembalikan, aktivitas alat, sumber, dan penggunaan; unduh artefak saat suatu proses menghasilkannya.
- Tinjau cakupan tindakan Agen yang memerlukan konfirmasi, lalu setujui atau tolak tindakan tersebut.
- Jalankan pekerjaan Agen di lingkungan terisolasi per pengguna dengan ruang kerja persisten; alat dan akses jaringan mengikuti kebijakan administrator.

<a id="feature-drawing"></a>

### Pembuatan gambar dengan AI

- Buat gambar dari perintah teks dengan model gambar yang tersedia; aplikasi saat ini bukan editor gambar atau alat untuk menggambar ulang bagian tertentu pada gambar.
- Pilih mode pembuatan Otomatis atau Cepat jika didukung oleh konfigurasi model yang tersedia.
- Pilih proporsi persegi, mendatar, atau tegak, dimensi keluaran yang didukung, serta nilai benih acak atau tetap.
- Minta keluaran PNG, WebP, atau JPEG, pratinjau hasilnya, lalu unduh gambar.
- Pantau antrean dan kemajuan pembuatan, batalkan pekerjaan, dan pulihkan tugas saat ini setelah membuka kembali halaman.
- Periksa model yang benar-benar digunakan dan parameter pembuatan yang dicatat bersama hasilnya.

<a id="feature-ocr"></a>

### Pengenalan dan koreksi teks

- Unggah PNG, JPEG, WebP, atau PDF, atau pilih berkas yang sudah ada di drive tim.
- Berikan petunjuk bahasa dan kenali teks, tabel Markdown, atau rumus LaTeX sesuai kemampuan model yang dipilih.
- Tinjau hasil pengenalan per halaman dan blok teks, lalu koreksi teks yang dikenali secara manual.
- Ekspor konten yang sudah ditinjau sebagai teks, Markdown, atau JSON.
- Kirim hasil pengenalan tersimpan ke Terjemahan tanpa mengunggah dan mengenali sumbernya lagi.
- Pantau dan batalkan tugas pengenalan. Model saat ini tidak menyediakan koordinat kotak pembatas atau skor keyakinan.

<a id="feature-transcription"></a>

### Transkripsi rekaman dan ucapan langsung

- Pilih audio atau video lokal atau dari drive tim: WAV, FLAC, OGG, WebM, MP3, M4A, AIFF, atau MP4.
- Pratinjau media sumber dan gunakan deteksi bahasa otomatis atau petunjuk bahasa yang didukung.
- Tinjau segmen transkrip bertanda waktu dan edit teksnya.
- Ekspor teks, JSON, atau takarir SRT maupun WebVTT.
- Teruskan transkrip tersimpan ke Terjemahan dan pantau atau batalkan tugas transkripsi saat ini.
- Transkripsikan masukan mikrofon secara langsung saat HTTPS, izin peramban, MediaRecorder, dan layanan waktu nyata tersedia.
- Gunakan penanda waktu per kata atau pemisahan pembicara hanya dengan profil yang mendukung; alur pemisahan pembicara eksperimental memerlukan masukan WAV.

<a id="feature-translation"></a>

### Terjemahan teks, berkas, dan media

- Pilih dari katalog 60 bahasa yang didukung model, deteksi bahasa sumber secara otomatis, atau pilih dan tukar bahasa sumber dan tujuan. Ini tidak menjamin kualitas yang sama untuk setiap pasangan bahasa.
- Terjemahkan teks yang diketik atau ditempel dan bandingkan segmen sumber dengan terjemahannya.
- Unggah gambar atau PDF, atau pilih dari drive tim; kenali teksnya sebelum menerjemahkan saat OCR siap.
- Terjemahkan audio atau video yang didukung melalui transkripsi, dengan mempertahankan waktu segmen saat layanan transkripsi siap.
- Gunakan kembali hasil OCR atau transkripsi tersimpan dan unduh hasil antara yang tersedia.
- Edit teks terjemahan dan ekspor sebagai teks, Markdown, atau JSON; hasil audio dan video juga mendukung SRT serta WebVTT.
- Ikuti tahap ekstraksi, transkripsi, dan penerjemahan, batalkan pekerjaan, dan pulihkan tugas saat ini setelah membuka kembali halaman.
- Bahasa terjemahan berbeda dari cakupan bahasa antarmuka dan OCR/ASR. Terjemahan PDF berbasis teks, bukan pembuatan ulang tata letak asli atau pengeditan umum DOCX/XLSX.

<a id="feature-messaging"></a>

### Pesan tim

- Temukan rekan tim, mulai percakapan langsung, dan buat obrolan grup bernama dengan anggota yang dipilih.
- Filter semua obrolan, yang belum dibaca, atau grup, lalu cari percakapan dan pesan yang boleh Anda akses.
- Kirim teks dan lampiran berkas; unduh versi asli berkas lampiran.
- Terima pesan secara langsung, pulihkan riwayat obrolan setelah tersambung kembali, pantau posisi baca dan pesan belum dibaca, serta lihat kehadiran anggota.
- Kirim dengan Enter, tambahkan baris baru dengan Shift+Enter, dan beralih antara daftar percakapan dan obrolan pada layar sempit.
- Hapus pesan dari tampilan Anda sendiri atau bersihkan riwayat obrolan Anda; catatan peserta lain tidak dihapus.
- Hapus obrolan dari daftar percakapan Anda sendiri tanpa keluar dari grup; pesan baru dapat membuatnya muncul kembali.

<a id="feature-drive"></a>

### Drive tim dan kolaborasi berkas

- Atur ruang berkas pribadi dan tim dengan folder serta navigasi jejak lokasi.
- Beralih antara tampilan daftar dan kisi, periksa detail berkas, cari berkas atau folder, dan lihat perubahan terbaru.
- Unggah beberapa berkas, pantau kemajuannya, dan batalkan unggahan.
- Lanjutkan unggahan berkas besar multipart dengan memilih berkas yang sama lagi; bagian yang telah diunggah diverifikasi oleh server.
- Buat folder serta ubah nama, pindahkan, atau salin berkas dan folder.
- Pratinjau gambar, audio, video, teks, dan PDF yang didukung, serta unduh berkas; pemutaran media bergantung pada peramban.
- Unggah versi baru berkas, periksa riwayat versi, dan unduh versi sebelumnya.
- Pindahkan item ke tempat sampah dan pulihkan kembali.
- Bagikan secara internal kepada anggota atau tim dengan izin melihat atau mengedit dan masa berlaku opsional; ini bukan berbagi lewat tautan publik anonim.
- Jelajahi berkas dan folder yang dibagikan kepada Anda, dengan pemeriksaan ulang akses berdasarkan izin serta keanggotaan saat ini.

<a id="feature-casting"></a>

### Pencerminan layar nirkabel yang kompatibel dengan AirPlay

- Mulai dan hentikan penerima sementara untuk perangkat Apple yang kompatibel di LAN yang sama, dengan nama penerima dan PIN sendiri.
- Pilih masa aktif penerima selama 15, 30, 60, atau 120 menit; penghentian atau kedaluwarsa mengakhiri pengumumannya di jaringan dan akses menonton.
- Batasi penonton hanya kepada diri sendiri, anggota pilihan, atau satu tim; undang penonton yang dapat menerima atau menolak.
- Tonton layar dan putar audio di peramban; aturan putar otomatis peramban mungkin mengharuskan klik untuk mengaktifkan suara.
- Lihat dan keluarkan penonton yang tersambung; administrator dapat menghentikan sesi tanpa mendapat izin menonton konten pribadi.
- Lihat status terputus dan tersambung kembali; izin menonton diperiksa ulang saat bergabung kembali.
- Memerlukan lingkungan eksekusi media yang siap, penemuan perangkat LAN yang dapat dijangkau, serta versi peramban dan perangkat yang kompatibel. Menonton di peramban tidak menyediakan keluaran HDMI, pemutaran DRM/FairPlay, atau sertifikasi Apple.

<a id="feature-phones"></a>

### Ponsel Android virtual dengan data persisten

- Buat ponsel Android independen dari profil sistem yang terpasang, dengan aplikasi dan data setiap ponsel tetap tersimpan antarsesi.
- Mulai, matikan, mulai ulang, ganti nama, dan hapus setiap ponsel melalui tindakan eksplisit.
- Kendalikan Android dengan papan ketik, penunjuk, serta tombol Kembali, Beranda, Aplikasi Terbaru, dan volume.
- Gunakan audio dan tampilan layar penuh, sambungkan kembali, atau pindahkan koneksi ponsel aktif ke halaman lain.
- Unggah berkas ke ponsel dan unduh berkas dari folder transfer Team AI Box di ponsel tersebut.
- Pasang berkas APK Anda sendiri setelah konfirmasi; izin aplikasi Android tidak diberikan diam-diam.
- Masukkan gambar, video, atau kamera peramban ke kamera virtual jika didukung; kamera USB fisik dan masukan jaringan juga memerlukan pengaturan serta izin administrator.
- Izinkan sementara penelusuran kesalahan ADB khusus perangkat melalui relai berumur pendek, menggunakan alat ADB standar dan klien relai Node.js.
- Periksa laju bingkai, kehilangan paket, dan statistik waktu bolak-balik koneksi sesuai kebutuhan; angka ini bukan jaminan latensi ujung ke ujung.
- Pilih profil sistem Google Play hanya jika sumber dayanya tersedia; ketersediaan bukan sertifikasi Play Protect atau jaminan bahwa setiap aplikasi Android bekerja.

<a id="feature-computers"></a>

### Komputer Windows dan Linux virtual

- Buat komputer ARM64 Windows/Linux independen dengan pilihan CPU, memori, dan ukuran disk.
- Mulai komputer, matikan secara normal, dan hapus komputer yang telah berhenti setelah konfirmasi eksplisit.
- Buka monitor virtual di peramban untuk melihat firmware, proses boot, instalasi, dan layar sistem operasi tanpa harus masuk ke desktop jarak jauh terlebih dahulu.
- Gunakan papan ketik, penunjuk, suara, layar penuh, dan kontrol sambung kembali.
- Buka komputer virtual yang sama di beberapa tab atau jendela browser.
- Undang rekan tim untuk melihat atau mengendalikan monitor dan cabut akses mereka.
- Serahkan kendali kepada peserta lain, lepaskan, atau ambil kembali sebagai pemilik; pilih mode pengendali tunggal atau kendali bersama.
- Unggah ISO instalasi dengan kontrol jeda, lanjutkan, dan batalkan, atau pilih ISO yang sudah ada dari drive pribadi atau tim.
- Pasang atau keluarkan media optik virtual dan pilih boot dari disk untuk satu kali; mengganti media tidak otomatis memulai ulang komputer.
- Pasang sistem operasi ARM64 milik Anda yang sah untuk digunakan dan gunakan desktop jarak jauh opsional secara terpisah. Lisensi Windows tetap menjadi tanggung jawab Anda; Windows yang sudah diaktifkan dan dukungan umum sistem tamu x86 tidak disertakan.

<a id="feature-administration"></a>

### Administrasi, izin, dan keamanan

- Buat anggota lokal, kelola status akun, dan atur ulang kata sandi jika peran Anda mengizinkan.
- Tetapkan peran bawaan, periksa izin, dan kelola keanggotaan tim dengan pengamanan untuk tindakan pemilik.
- Filter peristiwa audit menurut domain atau ID korelasi, periksa detailnya, dan minta verifikasi integritas riwayat audit.
- Periksa status perangkat, aplikasi, penyimpanan, dan layanan eksekusi dari ruang administrasi.
- Konfigurasikan penyedia AI eksternal dan pemetaan model atau operasi, ganti kredensial secara berkala, serta aktifkan atau nonaktifkan penyedia.
- Tetapkan kebijakan perutean lokal atau eksternal yang diizinkan dengan persetujuan eksplisit untuk pemrosesan eksternal; AI lokal tidak memerlukan kunci API eksternal.
- Lihat profil model terpasang, versi runtime, kesiapan, dan detail validasi.
- Impor paket plugin terverifikasi dan kelola instalasi, peningkatan, pengaktifan, penonaktifan, serta penghapusan plugin yang memenuhi syarat; plugin resmi yang dilindungi memiliki batasan.
- Periksa antrean dan pekerjaan eksekusi, sesuaikan kebijakan penjadwalan yang diizinkan, dan batalkan pekerjaan yang memenuhi syarat.
- Lihat pengaturan penyimpanan terenkripsi dan perlindungan saat memulai sistem. Pembukaan kunci otomatis memakai kunci lokal; mengaktifkan frasa sandi saat memulai sistem memerlukan verifikasi pemulihan dan konfirmasi.

<a id="feature-installation"></a>

### Instalasi dari kode sumber dan pemeliharaan

- Pasang dari klon Git publik dengan satu perintah instalasi sumber yang terdokumentasi pada DGX Spark baru yang kompatibel.
- Siapkan alat build, unduh bahan model dan lingkungan eksekusi, bangun citra aplikasi, kemas, lalu pasang dengan menggunakan kembali lingkungan Docker/NVIDIA yang sudah ada.
- Lanjutkan persiapan yang terputus dengan perintah dan direktori kerja yang sama, menggunakan kembali unduhan terverifikasi serta tahap yang sudah selesai.
- Jalankan pemeriksaan prasyarat, persiapan hanya untuk mengunduh, atau pembuatan paket hanya melalui build.
- Siapkan paket portabel lengkap untuk dipasang pada target luring; persiapan dari sumber itu sendiri memerlukan akses jaringan.
- Verifikasi masukan dengan versi yang telah ditetapkan dan gunakan sumber alternatif terdokumentasi atau cache portabel terverifikasi jika diperlukan; tidak ada jaminan untuk mirror pihak ketiga.
- Inisialisasi kredensial baru khusus perangkat dan akun admin/admin yang terdokumentasi, lalu ubah kata sandinya; jangan menyalin akun atau disk sistem tamu dari perangkat lain.
- Tinjau kandidat pemeliharaan, temuan kompatibilitas, rencana eksekusi eksplisit, dan riwayat rencana, dengan instruksi pengembalian serta pemulihan yang terbatas cakupannya—bukan peningkatan OS atau driver otomatis secara sembarangan.

<a id="feature-developers"></a>

### Pengembangan sumber terbuka dan ekstensi

- Baca, ubah, dan distribusikan ulang kode serta dokumentasi asli produk di bawah MIT; komponen pihak ketiga tetap memakai lisensinya sendiri.
- Bangun ekstensi ApplicationPlugin atau ComputePlugin menggunakan kontrak SDK publik dan contoh plugin yang disertakan.
- Gunakan manifes paket bertanda tangan serta pemeriksaan integritas dan izin untuk impor plugin; ini tidak berarti tersedia pasar plugin publik.
- Kontribusikan perbaikan, terjemahan, dokumentasi, dan integrasi melalui laporan masalah dan permintaan penggabungan; gunakan pelaporan keamanan privat untuk kerentanan.

## Apa itu NVIDIA DGX Spark?

NVIDIA DGX Spark adalah sistem AI desktop ringkas dengan GB10 Grace Blackwell Superchip. Konfigurasi 128 GB menggabungkan CPU Arm 20 inti, GPU Blackwell, dan memori sistem terpadu 128 GB dengan bandwidth 273 GB/s. NVIDIA menyatakan komputasi AI teoretis hingga 1 PFLOP pada presisi FP4 dengan sparsitas.

Memori terpadu adalah memori sistem bersama, bukan VRAM khusus. Spesifikasi berbeda menurut konfigurasi; komputasi teoretis tidak menjamin kecepatan aplikasi atau jumlah pengguna bersamaan.

DGX Spark menyediakan komputasi. Team AI Box menambahkan antarmuka bersama untuk inferensi lokal, pembuatan gambar, OCR, transkripsi, terjemahan, dan kolaborasi. Instalasi pertama dari sumber mengunduh dependensi dan membangun runtime sebelum penyiapan.

[Spesifikasi perangkat keras resmi NVIDIA DGX Spark](https://docs.nvidia.com/dgx/dgx-spark/hardware.html)

Team AI Box adalah proyek independen Weerocks LLC, bukan produk, sertifikasi, atau dukungan resmi NVIDIA. Dukungan perangkat keras proyek ini ditentukan oleh persyaratan instalasi di bawah.

<a id="install"></a>

## Instal pada DGX Spark baru

Siapkan **DGX Spark kosong dengan Ubuntu 24.04 ARM64**, Docker Engine/Compose v2, driver dan dukungan kontainer NVIDIA, KVM, Git, serta Python 3.10+ yang berfungsi. Sediakan ratusan GB ruang sementara untuk model, build, dan paket. Jangan lakukan instalasi baru di atas data yang ada.

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Jalankan perintah **pada Spark**. Skrip mengunduh input dan model, membangun image, membuat paket offline lengkap, lalu memasangnya. Build pertama memerlukan Internet dan waktu; clone saja belum menginstal produk. Docker/NVIDIA dipakai kembali.

### Pemeriksaan dan melanjutkan

`--check` memeriksa prasyarat. Jika terputus, simpan `/var/tmp/teamaibox-source-build` dan jalankan **perintah yang sama** untuk menggunakan ulang unduhan dan tahap terverifikasi. Jangan hapus cache atau menjalankan build bersamaan. Sumber resmi digunakan secara bawaan. Jika tidak terjangkau, lihat [panduan](install/SOURCE-INSTALL.id.md) untuk sumber alternatif atau transfer cache/paket terverifikasi; mirror tidak dijamin tersedia. Kode berubah memerlukan `--work-dir` baru, bukan melewati pemeriksaan.

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh
```

### Setelah instalasi

1. Buka `https://<BOX_LAN_IP>/` dengan alamat LAN terkini dan pastikan sertifikat HTTPS lokal milik perangkat Anda.
2. Masuk dengan `admin` / `admin`, **ubah kata sandi awal**, lalu buat akun biasa. Jangan paparkan kredensial awal ke Internet.
3. Tunggu tiap aplikasi siap dan pilih bahasa/tema melalui profil.
4. Sediakan ISO ARM64 Windows/Linux dan lisensi yang sah. Untuk target offline, siapkan paket lengkap dahulu lalu ikuti [panduan paket](install/README.id.md); persiapan sumber tetap online.

## Lisensi dan batasan

Kode asli serta dokumentasi berlisensi MIT, **bukan semua biner instalasi**. Komponen pihak ketiga, model, NVIDIA, firmware, Google, dan Windows mempertahankan syarat masing-masing. Git tidak menyertakan bobot, disk tamu terinstal, sesi login, ISO, atau paket. Kompatibilitas Google bukan sertifikasi Play Protect; casting tidak mencakup DRM maupun sertifikasi Apple. Dukungan Windows 10 ARM64 tidak diklaim. Kinerja dan konkurensi bergantung pada beban dan perangkat keras.

<a id="contribute"></a>

## Mari berkontribusi

Laporan bug, dokumentasi, terjemahan, aksesibilitas, integrasi, dan kode sangat diterima. Jelaskan masalah dalam issue, buat fork dan branch terfokus, lalu PR dengan pemeriksaan dan gambar terkait. Spark tidak wajib untuk dokumen atau komponen terisolasi; jelaskan bukti perangkat keras dengan jujur. Jangan unggah rahasia, berkas pribadi, atau image yang sudah login. Laporkan kerentanan secara privat sesuai SECURITY.md. Tidak ada CLA wajib atau izin berbayar.

[Issues](https://github.com/weerocksllc/teamaibox/issues) · [Pull requests](https://github.com/weerocksllc/teamaibox/pulls) · [CONTRIBUTING](CONTRIBUTING.id.md) · [SECURITY](SECURITY.id.md)

## Pelajari lebih lanjut

- [Instalasi sumber dan pemulihan](install/SOURCE-INSTALL.id.md)
- [Paket offline](install/README.id.md)
- [Pengembangan dan build](docs/open-source/BUILDING.id.md)
- [Alur kontribusi](CONTRIBUTING.id.md)
- [Pelaporan keamanan privat](SECURITY.id.md)
- [Lisensi pihak ketiga dan cakupan rilis](THIRD_PARTY_NOTICES.id.md)

`apps/` · `services/` · `packages/` · `install/` · `deploy/` · `docs/`

© 2026 Weerocks LLC. [MIT](LICENSE) · [Lisensi pihak ketiga dan cakupan rilis](docs/open-source/RELEASING.id.md)
