# Workspace publik Jose

Jose adalah workspace pencarian kerja pribadi dan lokal serta skill untuk agent—bukan tracker SaaS bersama. Jose memakai model dan credential yang sudah dikonfigurasi di harness Anda. Fakta karier, CV, draft, dan riwayat lamaran disimpan di folder privat yang Anda buka.

> **Rilis:** `v0.1.0` adalah preview lama yang terikat ke client tertentu. Gunakan `v0.2.0` atau yang lebih baru; installer memeriksa rilis dan berhenti jika versinya belum tersedia.

- [Panduan Bahasa Indonesia](SETUP.id.md) · [English setup guide](SETUP.md) · [Halaman getting started](https://aditiaspace.github.io/jose-public/)
- Bahasa percakapan: Bahasa Indonesia atau English. CV dan resume yang dibuat selalu berbahasa Inggris; cover letter secara default English.
- Entry point skill/instruksi project-level yang didukung: Claude Code, Codex, OpenCode, dan DeepSeek Harness. Model, credential, dan permission tetap disediakan harness aktif.
- Tidak perlu akun GitHub, fork, Git repository, akun Jose, instalasi client global, API key, atau folder data kedua.

## Sebelum instalasi

Kalau agent Anda sudah bisa dipakai, lanjutkan dengan agent itu—Jose tidak memilih atau memasang model. Kalau belum punya LLM yang bisa dipakai, halaman getting started menjelaskan opsi OpenCode atau DeepSeek Harness dengan DeepSeek API. Harga dan setup provider dapat berubah, jadi halaman itu menautkan sumber resmi tanpa mengunci angka harga.

## Instalasi

Buka **folder privat yang bukan proyek kode bersama** di agent Anda, lalu tempel prompt singkat ini:

```text
Pasang Jose di folder privat ini dengan mengikuti https://raw.githubusercontent.com/aditiaspace/jose-public/main/INSTALL.md.
```

CLI Jose dipasang di `.jose/` dalam folder yang sama. Data karier dan riwayat lamaran lokal berada di folder ini juga; Git tidak diperlukan. Jose tidak boleh mengubah pengaturan harness global atau membaca, menyalin, maupun menyimpan credential host. Installer memeriksa bahwa rilis saat ini `v0.2.0` atau lebih baru sebelum inisialisasi.

## Privasi dan alur kerja

Sebelum memproses CV atau teks karier pribadi dengan hosted model, Jose menjelaskan bahwa konten terpilih dapat meninggalkan perangkat dan meminta persetujuan. Jika Anda punya CV, Anda bisa mengirimkannya setelah penjelasan itu; jika belum, onboarding mengumpulkan konteks secara bertahap dari jawaban Anda sendiri. Fakta tetap belum dikonfirmasi sampai Anda meninjaunya di halaman review lokal Jose. Jangan menerima perusahaan, tanggal, angka, skill, atau pencapaian yang dikarang.

Kirim lowongan → tinjau dan revisi draft tailor berbahasa Inggris → lamar sendiri lalu laporkan hasilnya ke Jose. Jose hanya mencatat hal yang Anda laporkan atau yang benar-benar terlihat dari alur Jobstreet yang disetujui. Scraper saved jobs Jobstreet dan assisted apply tetap tersedia melalui alur Playwright Jose yang terlihat; login, CAPTCHA/OTP, jawaban faktual, approval disclosure sebelum upload, dan approval final terpisah untuk target tertentu tetap di tangan Anda. Generic browser MCP dan tool computer-use untuk seluruh desktop tidak diaktifkan.

Request hosted model tetap dikirim ke provider pilihan Anda; Jose tidak dapat menjamin kebijakan retensi atau penghapusan provider tersebut. Doctor lokal hanya memeriksa file workspace dan versi Node—bukan menguji model, login Jobstreet, upload file, atau mengirim lamaran. Perilaku live model dan Jobstreet belum terverifikasi.
