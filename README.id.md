# Workspace publik Jose

Jose adalah workspace pencarian kerja lokal dan privat untuk tailoring CV berbasis bukti serta proses lamaran dengan kendali manusia. Installer memakai folder privat yang sedang dibuka di OpenCode sebagai workspace. Pengguna tidak perlu mengelola source code, membuat akun, atau memilih folder data kedua.

- [Panduan setup Bahasa Indonesia](SETUP.id.md) · [English setup guide](SETUP.md)
- Versi client yang ditargetkan: OpenCode **1.18.28** dan DeepSeek Harness **@deepseek-ai/dsh 0.2.1-rc.2**. Sesi DeepSeek live belum terverifikasi.
- Bahasa percakapan dapat English atau Bahasa Indonesia; CV dan resume yang dibuat selalu dalam Bahasa Inggris. Cover letter secara default berbahasa Inggris; jawaban portal mengikuti pilihan pengguna.
- Sumber, SQLite, context, file hasil, profil browser, dan kredensial client disimpan di workspace privat. Jangan gunakan folder instalasi Jose publik sebagai workspace.
- Windows adalah platform pertama yang diverifikasi. Path macOS/Linux dirancang portabel tetapi belum diklaim terverifikasi.

## Privasi dan batasan

OpenCode dijalankan dengan overlay HOME/XDG data/config privat-workspace, `opencode.json` nonrahasia, conversation sharing dinonaktifkan, allowlist provider hanya DeepSeek, permission yang meminta approval untuk tindakan, akses direktori luar workspace ditolak, dan web-fetch/search ditolak. Harness memakai `DSH_HOME` khusus; overlay yang diperiksa menonaktifkan kontribusi session-log DeepSeek dan ekspor OpenTelemetry yang terpisah, menonaktifkan web tool/provider umum, dan hanya mengaktifkan preset Jose untuk workspace lokal. `jose doctor` memeriksa versi client yang tepat dan konfigurasi privasi efektif sebelum launch; proses berhenti bila pengaturan wajib tidak dapat dibuktikan. Hasil doctor bukan uji kompatibilitas model/provider.

**Data dari hosted provider meninggalkan perangkat ini.** Saat memakai model yang di-host, prompt serta potongan CV/lowongan yang dipilih, context, draft, dan hasil tool dapat dikirim ke provider dan tunduk pada kebijakan provider tersebut. Dua jalur logging/ekspor tambahan Harness dinonaktifkan, tetapi request model biasa tetap meninggalkan perangkat. Jose tidak pernah meminta API key di chat atau argumen command; masukkan key hanya lewat kontrol kredensial interaktif client. Jose tidak memilih model atau mengklaim model/provider tertentu pasti menerima key Anda.

Alur Jobstreet Jose memakai browser Playwright terlihat dengan profil privat khusus, melalui command Jose yang sama di kedua client. Fitur saved-job dan bantuan lamaran sudah diimplementasikan, tetapi perilaku portal live belum terverifikasi. Pengguna sendiri menangani login, CAPTCHA/OTP, dan setiap jawaban faktual; menyetujui disclosure sebelum upload; serta memberi approval final terpisah untuk setiap target submit. Jose tidak boleh mengubah CV utama, profil, visibility, atau boost. Draft maupun upload bukan bukti lamaran sudah dikirim. Generic browser MCP dan desktop computer-use tidak diaktifkan.

## Instalasi

Buka client yang dapat memakai tool, buka folder privat di OpenCode, lalu tempel prompt di [`prompts/bootstrap.id.md`](prompts/bootstrap.id.md) atau [`prompts/bootstrap.en.md`](prompts/bootstrap.en.md). Setiap prompt sudah berisi link rilis terpercaya dan memandu instalasi ke folder yang sama. Node dan client pilihan harus tersedia untuk chat setup pertama.

## Status verifikasi

`jose doctor` memeriksa versi/konfigurasi client lokal dan, untuk Harness, memeriksa konfigurasi DSH hasil komposisi tanpa request model. Ia tidak memverifikasi kompatibilitas model DeepSeek, melakukan paid/model call, login ke Jobstreet, atau mengirim lamaran. Perilaku provider dan portal live hanya boleh diuji sendiri oleh pengguna setelah membaca langkah privasi dan approval.
