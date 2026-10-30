<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../README.id.md)
<!-- doc-navigation:end -->

# Waktu proses komputer virtual ARM

`Public.Dockerfile` membangun kemampuan kehadiran fisik (PPI) ARM TPM yang sama yang dibutuhkan oleh runtime `windows-arm64-ppi` asli. Ia membangun QEMU 11.1.1 dari rilis resmi setelah memverifikasi tanda tangannya yang terpisah terhadap sidik jari manajer rilis yang disematkan. Debian memasok perpustakaan dan alat kontainer, bukan executable QEMU yang digunakan untuk menjalankan tamu.

Jangan ganti executable ini dengan paket QEMU distribusi yang lebih lama. Profil Windows mengaktifkan `tpm-tis-device,...,ppi=on`; build tanpa properti ARM tersebut keluar sebelum firmware dimulai. Menghapus `ppi=on`, menonaktifkan TPM, atau menyetel ulang TPM tamu bukanlah perbaikan yang kompatibel.

Pembuatan gambar akhir memeriksa dukungan ARM TIS PPI dan PulseAudio dan menyertakan ROM framebuffer RAM yang cocok. Pada host ARM KVM, `python3 /usr/local/bin/probe-ppi` yang dibundel melakukan pemeriksaan QEMU/TPM yang dijeda tanpa disk. Itu tidak memasang disk tamu yang ada atau membuktikan bahwa instalasi Windows telah selesai. Booting Windows harus diperiksa secara terpisah pada tamu pengujian yang ditunjuk secara eksplisit.

Untuk instalasi yang sudah ada, gunakan kebijakan pembaruan runtime platform dan ringkasan gambar profil Agen Node yang cocok. Pertahankan disk, firmware, identitas dan status TPM. Jangan membuat ulang guest atau mengubah image guest Linux yang sedang berjalan hanya untuk memperbaiki runtime Windows. Rekam gambar yang dibuat secara lokal sebagai tidak dipublikasikan hingga perubahan sumbernya diterapkan dan dirilis.

Pertahankan kepemilikan konfigurasi yang diinstal dan izin baca saat memperbaruinya. Jika Platform API dibuat ulang untuk memuat kebijakan pembaruan waktu proses, buat juga dependen namespace jaringannya (`node-agent`, `appliance-gateway`, `desktop-proxy`, `desktop-gateway`, dan `maintenance-controller`) dari gambarnya yang tidak diubah. Mereka harus bergabung dengan namespace jaringan kontainer API baru. Ini bukan restart tamu, daemon Docker, atau pekerja AI. Tunggu hingga detak jantung node yang diautentikasi normal untuk memulihkan kesiapan sebelum mengirimkan operasi start Windows.
