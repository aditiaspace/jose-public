# Mulai Jose di folder OpenCode ini — Bahasa Indonesia

Tempel prompt ini ke chat OpenCode baru saat OpenCode membuka folder privat yang ingin Anda pakai untuk Jose. Folder yang sama akan menyimpan CV, fakta karier, draft, profil browser, dan riwayat lamaran. Anda tidak perlu mengelola source code, membuat akun, atau memilih folder data kedua.

---

Bantu saya menyiapkan Jose di folder yang sedang dibuka OpenCode. Jelaskan tindakan dengan sederhana dan kerjakan setup yang biasa untuk saya. Sesi setup pertama ini bukan untuk CV atau API key saya.

1. Pastikan folder saat ini privat dan bukan bagian dari proyek kode bersama. Jika folder terhubung ke proyek kode online, jelaskan bahwa file pribadi dapat ikut dibagikan, berhenti sebelum menulis apa pun, lalu minta saya membuka folder privat baru di OpenCode dan menempel prompt ini lagi.
2. Tanyakan bahasa percakapan: Bahasa Indonesia atau English. Prompt ini default ke Bahasa Indonesia. Gunakan OpenCode sebagai pilihan awal karena sudah terbuka; tanyakan sebelum beralih ke Harness.
3. Periksa Node.js `>=24.15.0 <25` dan npm. Jika belum tersedia atau versinya salah, jelaskan langkah instalasi resmi Node.js dan tunggu persetujuan saya; jangan jalankan remote script yang belum diperiksa.
4. Jelaskan bahwa CLI Jose akan dipasang global, sementara data tetap di folder yang sedang dibuka. Sebelum mengubah instalasi global, minta approval saya. Pasang hanya rilis terpercaya ini: `npm install --global "https://github.com/aditiaspace/jose-public/releases/latest/download/jose-workspace.tgz"`. Jangan clone repository atau memakai sumber download lain.
5. Gunakan bahasa dan client yang sudah dipilih. Jika `.jose-workspace` sudah ada, jalankan `jose doctor --workspace .` dan gunakan workspace itu kembali tanpa reset. Jika belum ada, jalankan `jose init --workspace . --client <opencode|harness> --language <id|en>`, lalu `jose doctor --workspace .`. Jika init atau doctor gagal, jelaskan masalah sebenarnya dan berhenti.
6. Periksa versi client yang dipin: OpenCode `1.18.28` atau Harness `@deepseek-ai/dsh 0.2.1-rc.2`. Jika belum terpasang atau versinya berbeda, jelaskan command tepat—`npm install --global opencode-ai@1.18.28` atau `npm install --global @deepseek-ai/dsh@0.2.1-rc.2`—dan minta izin sebelum mengubah instalasi client global. Jalankan `jose client-launch --workspace . --client <client-pilihan>` hanya setelah doctor lulus. Saya memasukkan API key di dalam client, bukan di chat, prompt, file, atau command.
7. Di sesi Jose yang baru, jelaskan pemrosesan data hosted model sebelum membaca informasi pribadi. Lalu tanyakan nama saya, minta CV lengkap, klarifikasi fakta berdasarkan sumber, dan minta saya mengonfirmasi fakta di halaman review lokal. Jangan melamar, upload, submit, atau mengeluarkan biaya tanpa approval terpisah. Setelah onboarding, minta saya memulai sesi baru di folder yang sama dan mengirim satu lowongan.

Jangan mengarang hasil atau melewati langkah privasi, login, review, atau approval.
