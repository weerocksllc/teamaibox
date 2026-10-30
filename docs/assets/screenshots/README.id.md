<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../../README.id.md)
<!-- doc-navigation:end -->

# Tangkapan layar produk publik

Ini adalah tangkapan meja kerja Team AI Box yang sebenarnya, satu gambar terang dan satu gambar gelap untuk masing-masing dari 17 lokal UI. Ini adalah aset dokumentasi produk, bukan sumber, templat, atau hasil pembuatan situs web pemasaran swasta.

## Tangkap aturan

- Gunakan bahasa produk dan kontrol tema yang sebenarnya; jangan menerjemahkan label ke tangkapan layar bahasa Inggris atau menciptakan hasil yang sukses.
- Gunakan akun demonstrasi dan periksa setiap gambar untuk pesan pribadi, nama file, kredensial, PIN penerima, alamat jaringan, dan chrome browser. Jangan pernah mempublikasikan disk tamu yang masuk atau ekspor sesi/cookie dengan gambar.
- Pengambilan meja kerja saat ini hanya menampilkan status tugas demonstrasi umum dan akun Administrator umum. Mereka tidak mengekspos muatan tugas.
- Pertahankan pengaturan produk seperti setelah diambil. Jangan hapus data pengguna atau jalankan kembali beban kerja bisnis untuk mendapatkan tangkapan layar.
- `workbench-light.jpg` and `workbench-dark.jpg` adalah yang asli. Sebagian besar menggunakan pengambilan satu halaman penuh. Bahasa Arab menggunakan area pandang sebenarnya karena tangkapan RTL satu halaman penuh browser menggantikan halaman tersebut; tidak ada label atau hasil yang diubah.
- Beberapa kata status tugas yang aktif masih dalam bahasa Inggris dalam tampilan yang dilokalkan. Gambar-gambar ini sengaja mempertahankan UI yang dikirimkan alih-alih memperbaikinya. Sistem operasi tamu, respons model, dan nama yang ditentukan pengguna memiliki pengaturan bahasa terpisah dan tidak diterjemahkan oleh pemilih UI.

Perender README memerlukan kedua gambar untuk setiap lokal produk dan gagal alih-alih kembali ke tangkapan layar bahasa Inggris secara diam-diam. Saat menyegarkan UI, ganti kedua tema dan buat ulang manifes gambar dengan `node tools/screenshot-manifest.mjs`. Jauhkan pengidentifikasi jaringan/perangkat dan log tangkapan lokal dari direktori publik ini.
