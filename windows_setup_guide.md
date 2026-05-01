# Panduan Menjalankan BXT-SCRAPPER di Windows

Panduan ini menjelaskan langkah-langkah lengkap untuk menyiapkan dan menjalankan bot scraper di sistem operasi Windows.

## 1. Persiapan Awal (Prerequisites)

Sebelum memulai, pastikan Anda telah menginstal software berikut:

### A. Node.js (Wajib)
1. Buka situs resmi [Node.js](https://nodejs.org/).
2. Unduh versi **LTS (Recommended For Most Users)**.
3. Jalankan installer `.msi` dan ikuti instruksi instalasi sampai selesai.
4. Verifikasi instalasi dengan membuka **Command Prompt (CMD)** atau **PowerShell**, lalu ketik:
   ```cmd
   node -v
   npm -v
   ```
   *Pastikan muncul versi Node (min v18) dan NPM.*

### B. Git (Opsional)
Jika Anda ingin mendownload code langsung dari repository:
1. Unduh di [git-scm.com](https://git-scm.com/download/win).
2. Instal dengan pengaturan default.

---

## 2. Setup Project

1. **Download Code**: 
   - Extract file ZIP project ke folder pilihan Anda (misal: `C:\BXT-SCRAPPER`).

2. **Buka Terminal**:
   - Tekan `Win + S`, cari **PowerShell** atau **Terminal**, lalu buka.
   - Pindah ke direktori project:
     ```powershell
     cd "C:\Path\Ke\BXT-SCRAPPER"
     ```

3. **Instal Dependensi**:
   Jalankan perintah berikut untuk mengunduh library yang dibutuhkan:
   ```powershell
   npm install
   ```

4. **Instal Browser Playwright**:
   Project ini menggunakan Playwright untuk otomatisasi browser. Anda perlu mengunduh browser engine-nya (Chromium):
   ```powershell
   npx playwright install chromium
   ```

---

## 3. Konfigurasi Environment

1. Cari file bernama `.env.example` di folder project.
2. Copy dan Rename menjadi `.env`.
3. Buka file `.env` menggunakan Notepad atau VS Code.
4. Isi bagian yang diperlukan:
   - **GEMINI_API_KEY**: Masukkan API key dari [Google AI Studio](https://aistudio.google.com/).
   - **SCRAPER_TARGET**: Pilih target (misal: `amazon`, `kogan`, dll).
   - **PROXY_URL**: (Opsional) Masukkan jika ingin menggunakan proxy.

---

## 4. Menyiapkan Data Input

1. Pastikan folder `input` sudah ada.
2. Siapkan file CSV (contoh: `products.csv`) di dalam folder `input`.
3. Pastikan kolom di CSV sesuai dengan yang diharapkan (biasanya kolom `sku`, `brand`, `model`).

---

## 5. Cara Menjalankan

Ada beberapa cara untuk menjalankan script ini:

### A. Menggunakan Command Line (Terminal)
Untuk mulai proses scraping:
```powershell
npm run scrape
```

### B. Menggunakan UI Konfigurasi (Jika tersedia)
Untuk membuka dashboard pengaturan:
```powershell
npm run config
```

### C. Mode Uji Coba (Dry Run)
Jika ingin mengetes tanpa benar-benar menyimpan hasil:
```powershell
npm run scrape:dry-run
```

---

## 6. Masalah Umum di Windows (Troubleshooting)

### A. PowerShell Execution Policy
Jika muncul error *"script cannot be loaded because running scripts is disabled on this system"*, jalankan perintah ini di PowerShell (Run as Administrator):
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### B. Browser Tidak Terbuka
Jika browser gagal terbuka, pastikan antivirus atau Windows Firewall tidak memblokir proses `chromium`. Pastikan juga Anda sudah menjalankan `npx playwright install`.

### C. Path File
Windows menggunakan backslash `\` sedangkan script sering menggunakan forward slash `/`. Project ini sudah dirancang agar kompatibel di Windows.

---

## Ringkasan Perintah Cepat (Cheat Sheet)
```powershell
# 1. Instal library
npm install

# 2. Instal browser
npx playwright install chromium

# 3. Jalankan bot
npm run scrape
```
