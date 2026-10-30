<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.id.md)
<!-- doc-navigation:end -->

# Bangun peralatan dari sumber publik

Titik masuk orkestrasi baru didokumentasikan di [SOURCE-INSTALL.md](SOURCE-INSTALL.id.md). Ini mengotomatiskan resep di bawah ini; status verifikasi peralatan lengkapnya dinyatakan di sana. Resep manual ini tetap tersedia untuk pemelihara dan diagnosis tahap individu.

Ini adalah jalur sumber-ke-paket. Itu tidak mengimpor instalasi Team AI Box sebelumnya, container, akun, sertifikat, tamu, atau databasenya. Mesin build memerlukan akses internet; paket lengkap yang dihasilkan diinstal secara offline. Pelanggan menyediakan media instalasi Windows/Linux secara terpisah.

Gunakan Linux ARM64 (Ubuntu 24.04), Docker/BuildKit, Python 3.10+, PyYAML, jq, Git, Go 1.26 dan ruang disk yang cukup untuk pengunduhan sumber, lapisan build, dan bundel terakhir yang tidak terkompresi. Kuantisasi model juga memerlukan GPU NVIDIA yang kompatibel dengan memori bebas yang memadai. Jangan hentikan beban kerja lain untuk mendapatkan memori tersebut tanpa izin pemilik mesin. Docker dan NVIDIA merupakan prasyarat, bukan komponen yang digantikan oleh penginstal.

Jalankan perintah dari checkout publik baru. Setel `BUILD` ke direktori build absolut baru **di luar** pembayaran. Keluaran, model, dan laporan tidak boleh dikomit. Setiap helper menolak output yang ditempati kecuali ia mendokumentasikan operasi resume tertentu. Gunakan referensi/ID laporan yang berhasil, bukan nama gambar yang disalin dari mesin orang lain. ID konten Docker lokal bukanlah referensi registri yang dapat diunduh; Argumen induk Dockerfile memerlukan tag lokal yang sesuai atau intisari upstream yang memenuhi syarat.

## 1. Layanan dan aplikasi

```sh
python3 install/build_public_services.py --output "$BUILD/services" \
  --network host \
  --guacamole-image docker.io/guacamole/guacamole@sha256:f344085e618bb05e22b964b0208dbd06d3468275bac70206f93805245e067b40 \
  --guacd-image docker.io/guacamole/guacd@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f \
  --roles platform-api web postgres event-bus node-agent agent-bridge \
  object-service messaging scheduler plugin-runtime observability \
  compute-gateway appliance-gateway maintenance-controller source-gateway \
  agent-sandbox computer-runtime desktop-gateway desktop-proxy \
  casting-receiver casting-media assistant-worker embedding-worker \
  translation-worker drawing-worker ocr-worker asr-worker batch-asr-worker \
  speaker-diarization-worker messaging-plugin team-drive-plugin drawing-plugin \
  ocr-plugin asr-plugin translation-plugin virtual-phones-plugin \
  virtual-computers-plugin wireless-casting-plugin

python3 install/build_public_sfu.py \
  --cache "$BUILD/downloads" --output "$BUILD/sfu"
```

`--network host` memengaruhi **build** online, bukan jaringan layanan yang diinstal. Tahapan ketergantungan node memungkinkan 2 detik per upaya koneksi, bukan 250 ms default Node. Hal ini membuat unduhan npm resmi dapat digunakan pada tautan dengan latensi lebih tinggi, termasuk VPN yang dikelola pengguna, tanpa berpindah registri, menonaktifkan IPv6, atau melemahkan pemeriksaan integritas TLS/paket. Pengaturan ini merupakan argumen tahap pembangunan, bukan perubahan lingkungan dalam aplikasi yang diinstal. Untuk link yang lebih lambat, build Docker langsung dapat menggantikan `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`. Gambar web membangun dependensi dan asetnya sendiri yang terkunci. Layanan node berbagi penutupan ketergantungan API yang baru dibangun. OCR menyertakan adaptor publiknya; itu tidak memerlukan paket pekerja yang tidak dipublikasikan dari proyek lain. Terjemahan menggunakan gambar vLLM publik NVIDIA yang dipasangi pin. Penyematan, batch ASR, dan media casting sengaja membagikan gambar runtime publik masing-masing. Citra komputer ini membangun QEMU 11.1.1 yang terverifikasi tanda tangan dengan dukungan ARM TPM/PPI, KVM, VNC, dan PulseAudio, sehingga mempertahankan kemampuan runtime Windows asli. Debian menyediakan perpustakaan runtime, namun QEMU paket lamanya tidak boleh menggantikan executable ini. Gambar akhir memeriksa properti ARM TIS `ppi` dan backend PulseAudio serta menyertakan ROM framebuffer RAM yang cocok. Lihat [panduan waktu proses komputer virtual](../deploy/windows-computer/README.id.md) untuk pemeriksaan waktu proses terbatas dan persyaratan pembaruan pelestarian data.

Setiap peran memiliki log. Laporan yang gagal mempertahankan keluaran peran yang berhasil; buat hanya peran yang gagal dan gabungkan laporan yang berhasil nanti. Jangan mengganti wadah pengembangan yang sedang berjalan dengan gambar yang hilang.

## 2. Waktu proses Android dan kamera bebas akun

Kunci tersebut menyematkan build AOSP Google, paket host, input kernel, dan revisi sumber. Unduhan diperiksa sebelum digunakan. Tidak ada tamu yang di-boot selama perakitan.

```sh
python3 install/build_public_android.py --cache "$BUILD/android-downloads" \
  --output "$BUILD/android"
PHONE_BASE=$(jq -r '.images.network.reference' "$BUILD/android/build.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_BASE" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:phone-tools deploy/android/cuttlefish

python3 install/build_public_camera_backend.py --cache "$BUILD/camera-downloads" \
  --output "$BUILD/camera-backend"
CAMERA_COMPILER=$(jq -r '.compiler' "$BUILD/camera-backend/build.json")
python3 install/fetch_public_camera_kernel.py --output "$BUILD/kernel"
python3 tools/prepare_phone_camera_guest_driver.py --output "$BUILD/guest-source"
python3 tools/build_phone_camera_guest_driver.py --inputs "$BUILD/kernel" \
  --source "$BUILD/guest-source" --compiler-image "$CAMERA_COMPILER" \
  --output "$BUILD/guest-driver"
```

Untuk patch APK kamera, instal alat baris perintah Android publik Google, platform `android-36.1`, alat build `36.1.0`, dan JDK yang mendukung rilis Java
8. Setel `ANDROID_SDK_ROOT` and `JDK_HOME` ke direktori alat tersebut. Alat tersebut adalah dependensi build, bukan profil pengguna Android yang diekspor. Di ARM64 Linux, paket `zipalign` Google mungkin hanya untuk x86: instal paket ARM64 `zipalign` Ubuntu dan teruskan `--zipalign /usr/bin/zipalign` di bawah. D8 dan apksigner adalah program Java. Sebagai alternatif, versi APK dapat berjalan pada host SDK terpisah yang didukung; hanya transfer dua file keluarannya (`Camera2.apk`, `camera-preview.json`), jangan pernah mentransfer setelan Android atau profil pengguna host tersebut.

Ekstrak APK stok dari build AOSP yang bersih (direktori output harus ada dan dapat ditulis oleh container build):

```sh
mkdir "$BUILD/stock-camera"
docker run --rm --network none --read-only --user 0:0 --tmpfs /tmp:size=2g \
  --entrypoint python3 \
  --mount "type=bind,src=$PWD/deploy/android/cuttlefish,dst=/build,readonly" \
  --mount "type=bind,src=$BUILD/stock-camera,dst=/work" \
  teamaibox-build:phone-tools /build/prepare_camera_rom_inputs.py
python3 install/build_public_camera_apk.py \
  --stock "$BUILD/stock-camera/inputs/stock-Camera2.apk" \
  --sdk "$ANDROID_SDK_ROOT" --java-home "$JDK_HOME" --output "$BUILD/camera-apk"
python3 install/build_public_phone_rom.py --base-image "$PHONE_BASE" \
  --tools-image teamaibox-build:phone-tools --apk "$BUILD/camera-apk" \
  --module "$BUILD/guest-driver" --output "$BUILD/camera-rom"
PHONE_PARTITIONS=$(jq -r '.reference' "$BUILD/camera-rom/build.json")
python3 install/build_public_phone_runtime.py --base-image "$PHONE_PARTITIONS" \
  --backend "$BUILD/camera-backend" --cache "$BUILD/camera-downloads" \
  --output "$BUILD/phone"
```

APK menyimpan **penanda tangan pengujian AOSP publik** yang diketahui, bukan kunci produk pribadi. Helper memverifikasi sertifikat asli dan yang dihasilkan serta sumber daya APK yang tidak diubah, dan menghapus materi penandatanganan sementara. Ini bukan akun atau identitas perangkat Google.

Kontrak pemasang lengkap saat ini juga mencakup varian Google Android eksperimental. Kunci masukan publik dan pemeriksaan tanda tangannya **tidak** memberikan sertifikasi atau hak redistribusi kepada Google. Bangun/gunakan hanya sesuai ketentuan pihak ketiga yang berlaku; jangan publikasikan bundel lengkap yang dihasilkan sebagai unduhan MIT yang tidak dibatasi.

```sh
PHONE_RUNTIME=$(jq -r '.references["phone-runtime"]' "$BUILD/phone/images.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_RUNTIME" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:google-tools deploy/android/cuttlefish
python3 install/inspect_public_phone_inputs.py --cache "$BUILD/google-downloads" \
  --tools-image teamaibox-build:google-tools --output "$BUILD/google-inputs"
python3 install/build_public_google_phone.py --base-image "$PHONE_RUNTIME" \
  --tools-image teamaibox-build:google-tools --inspection "$BUILD/google-inputs" \
  --output "$BUILD/google-phone"
```

## 3. File model penerbit dan resep kuantisasi publik

```sh
for role in embedding-model drawing-model ocr-model asr-model; do
  python3 install/fetch_public_models.py --role "$role" \
    --output "$BUILD/assets/$role"
done
for role in assistant translation; do
  python3 install/fetch_public_models.py --role "$role-source" \
    --output "$BUILD/model-sources/$role"
done
OFFICE_ENGINE=$(jq -r '.references["assistant-worker"]' "$BUILD/services/images.json")
docker build --network host --build-arg OFFICE_ENGINE_IMAGE="$OFFICE_ENGINE" \
  -f deploy/compute/qwen38-modelopt/Dockerfile \
  -t teamaibox-build:modelopt deploy/compute/qwen38-modelopt
for role in assistant translation; do
  python3 install/prepare_public_quantized.py --role "$role" \
    --source "$BUILD/model-sources/$role" --tools-image teamaibox-build:modelopt \
    --output "$BUILD/quantized/$role"
done
```

Semua download model menggunakan revisi yang tidak dapat diubah di `deploy/compute/*profile*` dan hash Git/LFS penerbit. Opsional `--cache <directory>` bersifat hanya baca dan menerima file hanya jika byte-nya cocok dengan penerbit. Ini bukan cara untuk mengimpor direktori model yang terinstal tanpa pandang bulu. Teks MIT mandiri ASR disematkan ke rilis Whisper asli karena snapshot model yang dikonversi hanya mendeklarasikan lisensi. OCR memegang lisensinya sendiri, bukan MIT. Terjemahan yang dipasangi pin dan kartu model penyematan mendeklarasikan Apache-2.0 tanpa mengirimkan teks mandiri; pembantunya menyertakan lisensi Apache yang disematkan checksum dan catatan asal setelah memeriksa deklarasi tersebut.

Unduhan pencocokan yang terputus mendukung `--resume`. `--transfer ranges` menggunakan rentang HTTP yang dapat dilanjutkan dan dibatasi; `--transfer huggingface` memerlukan paket resmi `huggingface_hub`/`hf_xet` dan menonaktifkan penggunaan token. Cache parsial dan unduhan tetap berada di luar direktori model yang dapat diterbitkan. Checksum wajib dilakukan pada setiap transportasi. Jangan melemahkannya untuk halaman login/tantangan HTML atau download terpotong.

Kuantisasi berjalan offline dalam wadah build terpisah menggunakan data kalibrasi sintetik publik ModelOpt, tidak pernah riwayat obrolan. Hanya keluaran yang `build.json` menyatakan `quantized` yang dapat menyediakan `assistant-model` and `translation-model`; pilih subdirektori `model/`, bukan sumber mentah atau seluruh ruang kerja build. Setelah memvalidasi input, versi Linux menyarankan kernel untuk melepaskan halaman cache file tertentu tersebut. Hal ini menghindari pembacaan memori GPU yang langsung bebas dan menyesatkan pada memori bersama GB10; itu tidak menghapus bobot, menghapus cache seluruh host, atau menghentikan beban kerja. Untuk satu GPU GB10, helper menganggarkan dari Linux `MemAvailable` dan mencadangkan kapasitas untuk kalibrasi dan host. Ia menolak kapasitas yang tidak mencukupi daripada diam-diam menerima pembangunan yang sebagian besar menggunakan CPU. Ketika model lengkap cocok, anggaran ModelOpt yang eksplisit menghindari jalur ekspor pembongkaran CPU yang tidak perlu dari Accelerate. Kontainer build juga menetapkan memori terkunci tanpa batas dan tumpukan 64 MiB, mengikuti [NVIDIA persyaratan peluncuran kuantisasi](https://build.nvidia.com/spark/nvfp4-quantization/instructions). Pengaturan ini tercakup dalam kontainer build, bukan batas seluruh host.

## 4. Input paket lengkap

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

Penggabungan harus melaporkan **41 peran dan tidak ada peran yang hilang**. Ini memverifikasi arsitektur gambar/ID konten dan menolak keluaran yang bertentangan. Sumber daya hanya berisi firmware UEFI upstream (termasuk templat penyimpanan variabel baru), ISO driver virtio yang disematkan checksum, runtime gambar sumber, dan pemberitahuan Android yang terikat pada gambar yang baru dibuat. ISO bukan media instalasi Windows. Cermin Microsoft OpenVMM yang identik dengan checksum menghindari ketergantungan pada halaman unduh Fedora yang interaktif.

Kumpulkan paket host dengan `collect_host_packages.py` seperti yang dijelaskan dalam [README.md](README.id.md), lalu buat templat dengan `prepare-release.py --template`. Isi peta gambarnya dari `images.json`; isi seluruh 12 peran aset dari keluaran model, `resources/assets.json` and `guest-tools`. Setel `sourceCommit` ke checkout dan versi agen sebenarnya. Tidak ada placeholder atau konfigurasi instalasi sebelumnya yang dapat diterima.

Jalankan `prepare-release.py --inputs … --output …`, lalu `build-package.sh` menggunakan rilis yang telah disiapkan. Sumber yang dimodifikasi/tidak dikomit memerlukan tanda kandidat `--allow-working-tree` yang eksplisit; mereka bukan komit yang dirilis. Lihat [PACKAGE-README.md](PACKAGE-README.id.md) untuk instalasi. Database akun kosong baru mendapat `admin/admin`; semua kredensial layanan dan identitas perangkat dihasilkan secara independen. Build saja tidak membuktikan instalasi berhasil.

## Resep berlapis sejarah dan pemeriksaan publikasi

Dockerfile diagnostik/berlapis yang lebih lama dipertahankan untuk pemeliharaan sumber, tidak digunakan oleh pipeline ini. Argumen `BUILD_PARENT_N` mereka sengaja tidak memiliki gambar pribadi default. Berikan induk kompatibel yang Anda buat, atau gunakan saluran publik di atas; jangan menebak intisari pengembangan yang tidak tersedia.

Sebelum menerbitkan, jalankan penjaga sumber dan pemindai rahasia, tinjau riwayat secara terpisah, dan kecualikan semua direktori build, paket, disk tamu, data akun, dan situs web pribadi. Laporan yang berisi jalur lokal berada di luar pohon publik. Verifikasi untuk pekerjaan ini terbatas pada penutupan input build, identitas artefak, instalasi dan jalur layanan minimum yang baru diinstal; itu tidak menjalankan kembali penerimaan bisnis yang tidak terkait.
