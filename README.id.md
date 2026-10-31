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

Sebelum memproses CV atau teks karier pribadi dengan hosted model, Jose menjelaskan bahwa konten terpilih dapat meninggalkan perangkat dan meminta persetujuan. Jika Anda punya CV, Anda bisa mengirimkannya setelah penjelasan itu; jika belum, onboarding mengumpulkan konteks bertahap dari jawaban Anda. Usulan fakta tetap belum terkonfirmasi sampai Anda memilihnya secara eksplisit di chat; Jose menyimpan pilihan itu secara lokal lalu memeriksa `context` sebelum menggunakannya. Jose tidak mengarang perusahaan, tanggal, angka, skill, atau pencapaian.

Kirim lowongan → tinjau dan revisi draft CV/resume English lewat chat → lamar sendiri lalu laporkan hasilnya. Scraper saved jobs dan assisted apply Jobstreet tetap tersedia lewat Playwright Jose yang terlihat; Anda menangani login, CAPTCHA/OTP, dan jawaban faktual. Disclosure sebelum upload dan submit final memerlukan approval chat yang terpisah dan terikat pada file serta target persis. Generic browser MCP dan tool computer-use untuk seluruh desktop tidak diaktifkan.

Request hosted model tetap dikirim ke provider pilihan Anda; Jose tidak dapat menjamin kebijakan retensi atau penghapusan provider tersebut. Doctor lokal memeriksa file workspace dan Node.js, lalu meluncurkan Chromium sebentar secara headless untuk memastikan browser bisa berjalan. Doctor tidak menguji model, login Jobstreet, upload file, atau mengirim lamaran. Perilaku live model dan Jobstreet belum terverifikasi.
