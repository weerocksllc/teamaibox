<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../README.id.md)
<!-- doc-navigation:end -->

# Team AI Box alat paket offline

Pemasang asli berlisensi MIT. Paket mencakup lisensi root, inventaris pihak ketiga, dan teks lisensi dalam inventaris hash filenya. Ini tidak melisensikan kembali model, layanan Google, driver, atau dependensi container sebagai MIT. Baca [batas rilis](../docs/open-source/RELEASING.id.md) sebelum didistribusikan; paket tes lengkap yang ada tidak secara otomatis memiliki izin redistribusi.

Pelanggan menjalankan **`sudo ./install.sh` di dalam paket yang telah disiapkan**. Pengelola membuat paket tersebut dengan `build-package.sh`. Pelanggan offline tidak memerlukan repositori Git, Node, Go, pip, atau paket publik.

Untuk pengunduhan, pembuatan, dan pemasangan otomatis dari klon publik, jalankan `sudo bash install/from-source.sh`. Jaringan di Tiongkok dapat menggunakan `--region cn`. Lihat [SOURCE-INSTALL.md](SOURCE-INSTALL.id.md) untuk pengoperasian, melanjutkan, dan transfer offline. Resume didukung; hanya hasil kesiapan akhir yang menentukan penyelesaian instalasi. Pra-penerbangan atau pengunduhan yang berhasil tidaklah cukup.

Targetnya adalah DGX Spark baru dengan sistem pabrik Ubuntu 24.04 ARM64 dan Docker Engine yang berfungsi, Compose v2, NVIDIA Container Toolkit/GPU dan KVM. Penginstal tidak menggantikan Docker/NVIDIA, memulai ulang Docker, atau menyalin akun, database, kunci, atau mesin virtual alat pengembangan.

> Catatan penerimaan instalasi pribadi tetap berada di repositori pengembangan historis. Itu bukan file sumber publik atau input build. Bukti penginstalan pertama, resume, dan pemulihan boot yang ada tidak dijalankan ulang hanya untuk publikasi sumber, dan tidak memenuhi syarat untuk gambar baru yang dibuat secara sewenang-wenang atau memberikan hak redistribusi untuk biner pihak ketiga.

## Pemelihara: menyiapkan input rilis

**Untuk build GitHub publik baru, mulailah dengan [PUBLIC-BUILD.md](PUBLIC-BUILD.id.md).** Ini mencakup gambar publik, waktu proses kamera, download/kuantisasi model, dan firmware tanpa memerlukan gambar dari alat pengembangan. Pembantu gambar berlapis di bawah mendukung pembaruan bertahap pada artefak terverifikasi; itu bukan prasyarat untuk pembangunan baru.

Persiapannya boleh menggunakan internet. Instalasi dari paket yang dikirimkan tidak boleh mengunduh dependensi. Host pengemasan memerlukan Python 3.10+, PyYAML, Git, Docker, `dpkg-deb` dan penyimpanan yang memadai. Model dan gambar bisa berukuran besar; pembuat paket mempertahankan pohon yang diekstraksi dan `.tar`, memperkirakan ruang dari masukan sebenarnya. Itu tidak memindai seluruh alat pengembangan atau mengekspor lapisan yang dapat ditulis dari container yang sedang berjalan.

1. Siapkan image ARM64 dari **satu versi rilis** untuk semua peran yang diperlukan. Gunakan titik masuk build pada `deploy/images/`, `deploy/appliance/` dan direktori tamu/model yang sesuai. API Platform, Agen Node, penjadwal, dan pengontrol agen harus mendukung ID gambar lokal; gambar PostgreSQL harus berisi manifes migrasi saat ini, termasuk migrasi 116. Pemaket tidak mengkompilasi gambar lama secara sembarangan menjadi gambar saat ini. Dengan gambar induk dengan versi yang sama terverifikasi, gunakan `build_runtime_images.py --bases … --node-agent-binary … --output …` untuk membuat lima gambar penerus. `--bases` adalah peta ID peran-ke-gambar-penuh JSON. Agen Node pertama yang dibuat dengan `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build`. Pembantu ini melarang penarikan/pembangunan jaringan, mencatat identitas induk/sumber, dan membuat gambar baru tanpa menerapkan atau mengubah tag aktif. ROM Android yang bersih juga memerlukan adaptor jaringan kontrol saat ini. Gunakan `build_phone_images.py --bases <phone-role-image-ids.json> --output <new-directory>` untuk menambahkan `phone_network.py` ke kedua lapisan penerus ROM tanpa akses jaringan atau perubahan data ROM. Ini mencatat ID gambar dan ringkasan sumber yang tepat. Ikat sespan Android ke kedua ID baru, bukan yang sebelumnya. Bangun web dan sembilan aplikasi resmi menggunakan `build_application_images.py --node-base <clean-arm64-node-image-id> --guacamole-image <offline-guacamole-image-id> --output <new-directory>`. Pertama-tama buat web seperti yang ditentukan oleh `apps/web/package.json`. Helper menggunakan Dockerfiles produksi, memperbaiki direktori web di `/opt/teamaibox/web`, dan membandingkan file gambar dengan hash input build saat ini. Jangan berasumsi bahwa gambar kontainer pengembangan adalah build web yang lengkap: gambar tersebut mungkin bergantung pada variabel direktori statis tambahan atau berisi direktori lama. Pembantu offline ini tidak diterapkan. Masukkan sepuluh ID gambar baru ke dalam input rilis.
2. Kumpulkan direktori yang lengkap dan bersih untuk enam model: konfigurasi, pecahan, tokenizer, kode dan lisensi yang diperlukan. Siapkan juga dua image Android bersih, UEFI `CODE.fd`/`VARS.fd`, `virtio.iso` dan skrip runtime gambar. Jangan kumpulkan direktori instance telepon, disk pengguna, status login Google, ISO pengguna, atau kredensial global. ROM Android sudah ada di dalam `phone-runtime` / `phone-google-runtime`; jangan menyalin disk kedua. Direktori aset `android-standard` / `android-google` hanya berisi asal, lisensi dan `manifest.json`: `schemaVersion: 1`, `androidVersion: "17"`, `baseBuildId: "16102939"`, `systemFamily: "standard"` or `"google-play"`, dan `runtimeImageId: "sha256:…"`. ID harus cocok dengan gambar runtime yang diekspor. Direktori driver hanya berisi `virtio.iso`; direktori pengembangan yang juga berisi `windows.iso` ditolak.
3. Bangun dua paket alat host Linux ARM64 tanpa menginstalnya pada host build:

   ```sh
   python3 install/build_guest_tools.py --output /build/artifacts/guest-host-tools
   ```

4. Pada host build ARM64 yang terhubung ke internet, kumpulkan dependensi alat host menggunakan image lokal Ubuntu 24.04 yang eksplisit. Gunakan ID gambar yang diverifikasi pada host tersebut, bukan ID yang disalin dari alat pengembangan:

   ```sh
   python3 install/collect_host_packages.py \
     --base-image "$UBUNTU_ARM64_IMAGE_ID" --output /build/artifacts/host-packages
   ```

   Kumpulkan hanya dependensi untuk cryptsetup, ext4, USB/kamera, alat gambar QEMU, jaringan, dan utilitas sistem kecil. Paket pengganti Docker, containerd, NVIDIA, CUDA, dan kernel dilarang. Instalasi hanya menyediakan alat yang hilang; apt membaca repositori file lokal paket dengan `--no-download --no-remove`, tanpa fallback online.

5. Buat manifes input rilis dan berikan **jalur artefak eksplisit dan ID konten gambar lokal**:

   ```sh
   python3 install/prepare-release.py --template /build/artifact-inputs.json
   python3 install/prepare-release.py --inputs /build/artifact-inputs.json \
     --output /build/prepared-release
   ```

   Templat ini mencakup 41 peran gambar dan 12 kategori aset eksternal; aset pabrik lainnya dihasilkan oleh alat tersebut. Placeholder tidak dapat memasukkan paket. `sourceCommit` harus cocok dengan checkout, `agentVersion` build Agen sebenarnya, dan `hostPackageCollection` langkah ke-4 `collection.json`. Jalur build-host adalah masukan kumpulan, bukan konfigurasi runtime pelanggan. Gunakan generator pabrik saat ini: rute `drawing.automatic` / `drawing.fast` UI gambar harus cocok dengan konfigurasi model lokal. Kesehatan pekerja atau panggilan model langsung saja tidak menentukan kesiapan penerapan. Pengemasan menolak templat pabrik basi yang tidak memiliki pemetaan ini.

Kontrak peran gambar dilaporkan oleh `python3 install/package.py --describe-contract`:

- Inti, web, penggerak tim, perpesanan, gateway, penjadwal, pemeliharaan, plugin, kotak pasir agen dinamis, dan gateway sumber paket.
- Sembilan plugin aplikasi, enam pekerja model kantor, dan runtime ASR/speaker sesuai permintaan.
- Standar Android, Google Android, runtime komputer, dan tampilan web/gateway audio.
- Penerima transmisi, pemrosesan media dan SFU.

Dua peran dapat berbagi satu ID konten gambar; arsipnya hanya diekspor sekali. Indeks pecahan model juga diperiksa: hash file yang cocok tidak menyebabkan hilangnya pecahan. Alat host harus berupa biner ARM64 ELF yang sebenarnya.

## Bangun paketnya

```sh
./install/build-package.sh --release /build/prepared-release/release-input.json \
  --output /build/output
```

Outputnya adalah `teamaibox-<releaseId>-linux-arm64.tar`, file `.sha256` dan direktori yang diekstraksi. Penyalinan, ekspor gambar, hashing, dan pengarsipan terjadi di direktori sementara sebelum checksum akhir diterbitkan. Keluaran yang ada tidak ditimpa; build yang terputus tidak boleh terlihat seperti rilis lengkap. Untuk perubahan khusus penginstal dengan identitas gambar tidak berubah, gunakan `--image-cache <previous-extracted-package>`. Seluruh paket lama diverifikasi sebelum arsipnya digunakan kembali dengan ID gambar sebenarnya, dan paket baru diverifikasi lagi. Tidak ada data yang diambil dari instalasi lama atau lapisan kontainer yang dapat ditulisi. Hal ini untuk menghindari pengeksporan lagi gambar identik berukuran ratusan GB.

Rilis normal memerlukan file sumber yang dibundel untuk menjadi milik Git commit yang dinyatakan. `--allow-working-tree` yang eksplisit menciptakan kandidat pengembangan; manifesnya mencatat `candidate: true` dan mengubah file. Melewati penerimaan terfokus tidak mengubah sumber yang tidak terikat menjadi rilis yang dipublikasikan.

Tata letak paket:

```text
teamaibox-<releaseId>-linux-arm64/
  install.sh, installer.py, offline_common.py, offline_host_packages.py
  README.zh-CN.md, release.json, checksums.sha256
  images/          # Docker archives deduplicated by content ID
  assets/          # Models, Android, computers, tools and factory configuration by role
  host-packages/   # Complete .deb dependency set
  runtime/         # Installer adapters and recovery-tool module closure
```

Verifikasi secara mandiri dengan `./install/build-package.sh --verify /build/output/teamaibox-<releaseId>-linux-arm64`. Ini memeriksa integritas; itu tidak membuktikan booting berhasil pada perangkat keras baru.

## Pelanggan: instalasi offline dan melanjutkan

Baca [panduan instalasi paket](PACKAGE-README.id.md). Akar bawaannya adalah `/srv/teamaibox/installation`. LUKS/ext4 dibuat hanya di dalam `volume/data.img` baru, bukan pada disk sistem atau disk yang sudah ada. Kumpulan data menggunakan penyimpanan yang tersedia dikurangi margin keamanan fisik, bukan batas tetap 256 GiB. Model, file bisnis, dan data tamu berada dalam volume terenkripsi; Docker yang ada mengelola image container.

Instalasi baru membuat administrator `admin` dengan kata sandi awal `admin`. Pengguna biasa dibuat oleh administrator. Ubah kata sandi awal sebelum pengiriman/penggunaan. Ini hanya berlaku untuk database akun yang kosong: melanjutkan, menjalankan ulang, mem-boot ulang, dan meningkatkan versi tidak menyetel ulang akun atau kata sandi yang ada. Identitas perangkat, kredensial layanan, sertifikat, dan kode pemulihan administrator dibuat secara independen, tidak disalin dari peralatan lain. Persiapan cache kernel GPU awal dijalankan pada alat menggunakan alat dan model yang dibundel; cache yang kompatibel dipertahankan. Pemulihan boot memulihkan layanan data dan perangkat terlebih dahulu, kemudian layanan inti dan masing-masing pekerja AI. Penginstal hanya berjalan selama instalasi; itu tidak menambahkan manajer pemasang residen.

Setelah interupsi, ulangi perintah awal. Langkah-langkah yang telah selesai diverifikasi; jangan menyembunyikan konflik dengan menghapus data atau membuat ulang container. Menjalankan kembali instalasi versi yang sama yang telah selesai hanya akan memeriksanya; versi yang berbeda menggunakan jalur peningkatan formal. Detail kegagalan ada di `install-state.json`, `readiness.json` dan catatan tahapan di bawah root instalasi.

## Batasan verifikasi

Pengujian khusus penginstal menggunakan artefak struktural kecil, file sementara, dan database offline/daemon Docker yang terisolasi. Mereka tidak boleh mengakses database bisnis atau memasang disk VM yang ada. Instalasi baru yang sebenarnya memerlukan DGX Spark yang kompatibel dan secara eksplisit ditujukan untuk tujuan tersebut; jangan hapus peralatan bisnis. Penerimaan mencakup startup minimum, melanjutkan, dan pemulihan boot untuk instalasi baru, bukan pengujian bisnis yang tidak terkait. Persiapan pelepasan sumber itu sendiri tidak menghapus, menginstal ulang, atau menyebarkan peralatan yang ada.

Pada host build, jalankan `sudo python3 install/verify_bundle_offline.py --package <extracted-package> --output <new-test-directory>` untuk mengimpor paket lengkap ke daemon Docker terpisah dengan cache kosong dan tanpa jaringan publik. Itu tidak memanggil skrip instalasi baru, menggunakan GPU, memasang direktori pelanggan, atau memulai ulang Docker sistem. Laporannya secara eksplisit tidak mengklaim instalasi perangkat keras secara penuh. Gambar pengujian tetap berada di direktori pengujian khusus, memerlukan ruang disk tambahan dan tidak masuk ke penyimpanan gambar sistem Docker.
