# iSIM-Lite 2.0 🚀

> **The student portal you actually want to use.** 
> A blazing fast, modern, mobile-first Android app & Web portal for GL Bajaj students with MPIN Quick Login, Bunk Simulator, and Timetable Notes.

![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)
![Maintained](https://img.shields.io/badge/maintained-yes-success.svg)
![Platform](https://img.shields.io/badge/platform-Android%20%7C%20Web%20%7C%20PWA-green.svg)

---

## ✨ What's New in 2.0

### 🔐 1. 4-Digit MPIN Quick Login (No More Typing Credentials)
- **First Time Login:** Enter your Admission Number & Password once. The app securely encrypts your credentials locally on your device using **AES-GCM (Web Crypto API)** and sets a 4-digit MPIN.
- **Subsequent Logins:** Next time you open the app, unlock immediately using your 4-digit MPIN with a native touch numeric keypad and haptic feedback!
- **Session Renewal:** If the college session expires, a fast 1-tap captcha dialog renews your session without needing to re-type long roll numbers or passwords.

### ⚡ 2. Attendance "What-If" Simulator & Bunk Calculator
- **Bunk Margin Calculator:** Calculates exactly how many classes you can afford to safely bunk to stay above your target (e.g. 75%, 80%, 85%).
- **Attendance Deficit Recovery:** If you are below 75%, it calculates the exact number of consecutive classes you must attend to recover.
- **Interactive Sandbox:** Tap `+` or `-` to simulate attending or missing future classes and see your predicted percentage update in real time.
- **Subject Breakdown:** Per-subject analytics with individual bunk counts.

### 📅 3. Weekly Timetable with Personal Class Notes
- **Day-Wise Schedule:** Grouped by days (Monday through Saturday) with room/hall numbers, faculty names, and 12-hour formatted time slots.
- **Personal Class Notes:** Tap "Add Note" on any lecture to attach assignment deadlines, quiz dates, or homework reminders, saved locally.
- **Extra Classes / Events:** Add custom study blocks, lab sessions, or club meetings to any day.

### 🎨 4. Complete Redesign (Mobile-First)
- **Mobile Bottom Navigation Bar:** Ergonomic bottom bar with Attendance, Timetable, Simulator, and Profile tabs.
- **Glassmorphic Cards:** Translucent surfaces, subtle shadows, and responsive layouts.
- **Dark Mode & Accent Themes:** 10 curated accent themes (Indigo, Royal Blue, Emerald, Violet, Rose, Mint, etc.) with OLED Dark mode support.
- **Profile Customizer:** Custom display nickname, avatar photo upload, and a 1-tap "Share Attendance Card" for WhatsApp.

### 🔔 5. Background Push Notifications (Absent & Critical Attendance Alerts)
- **Real-Time Absent Alerts:** The backend detects when you are marked **Absent** on the college portal and sends a high-priority push notification: `⚠️ Attendance Alert: You were marked Absent in [Subject] ([Time])!`
- **Threshold Warnings:** Alerts when your attendance in any subject approaches or falls below the critical 75% boundary.
- **Service Worker & Web Push Protocol:** Background push delivery via standard Web Push (VAPID) and `@capacitor/local-notifications` on Android, working even when the app is closed.
- **Test Alert Trigger:** Directly test notifications on your device from the Profile settings tab.

---

## ☁️ Deployment

### ⚡ Option 1: Cloudflare Workers (Recommended - Free, 0ms Cold Start)
Deploy both the backend edge proxy and frontend assets to Cloudflare's edge network:
1. **Login to Cloudflare:**
   ```bash
   npx wrangler login
   ```
2. **Deploy with 1 command:**
   ```bash
   npm run worker:deploy
   ```
3. Cloudflare will give you an instant live URL (e.g. `https://isim-lite.your-subdomain.workers.dev`).
4. **Local Development with Worker:**
   ```bash
   npm run worker:dev
   ```

### 🖥️ Option 2: Traditional Node.js Server (Render.com / VPS)
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- Host on Render, Railway, or your own VPS.

---

## 📱 Android App Setup & Build

This app is configured with **Capacitor** and **PWA** support. You can run or build the Android app in two ways:

### Option A: Install Directly as a PWA (Zero Build Required)
1. Open `http://localhost:3000` (or your deployed URL) in **Chrome on your Android phone**.
2. Tap the browser menu (⋮) and select **"Install App"** or **"Add to Home screen"**.
3. It installs as a full standalone native app with splash screen, app icon, and offline support!

### Option B: Native Android Project (Android Studio / APK)
1. Install dependencies:
   ```bash
   npm install
   ```
2. Build web assets and sync with the Android project:
   ```bash
   npm run cap:sync
   ```
3. Open in Android Studio:
   ```bash
   npm run cap:open
   ```
4. In Android Studio, connect your phone or emulator and click **Run** (or `Build > Build Bundle(s) / APK(s) > Build APK(s)`).

---

## 🚀 Quick Start (Local Development)

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Assemble / Build Frontend:**
   ```bash
   node assemble.js
   ```

3. **Start the Server:**
   ```bash
   npm start
   ```

4. **Open in Browser:**
   Navigate to `http://localhost:3000`.

---

## 🛠️ Tech Stack
- **Frontend:** Vanilla HTML5, CSS3 Glassmorphism, Native Web Crypto API (AES-GCM PBKDF2), Service Worker (PWA).
- **Backend:** Node.js, Express.js (REST proxy), Axios, Cheerio.
- **Mobile:** Capacitor Android (`@capacitor/android`, Gradle).

---

## ⚠️ Disclaimer
**iSIM-Lite is an independent, unofficial project.** 
It is not affiliated with, endorsed, or sponsored by GL Bajaj Institute of Technology and Management or the official iSIM portal creators. Credentials are encrypted on the student's local device and never stored on any external database.
