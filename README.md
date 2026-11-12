# iSIM-Lite 🚀

> **The student portal you actually want to use.** 
> A blazing fast, modern, and mobile-responsive UI wrapper for the GL Bajaj iSIM Student Portal.

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![Maintained](https://img.shields.io/badge/maintained-yes-success.svg)
![Made with Love](https://img.shields.io/badge/built%20by-Suryansh%20Agarwal-ff69b4.svg)

## 🌟 Why iSIM-Lite?
The official portal gets the job done, but it can be slow and hard to read on mobile devices. **iSIM-Lite** acts as a lightweight bridge—it securely fetches your data from the official server in the background and presents it to you in a clean, beautiful, and distraction-free interface. 

## ✨ Key Features
- **📱 Mobile-First Design:** Looks perfect on phones, tablets, and desktops.
- **⚡ Lightning Fast:** Optimized backend scraping with session caching.
- **📊 Advanced Attendance Analytics:** 
  - Visual gauge charts for Semester & Monthly attendance.
  - Progress bars for Today's attendance.
  - Subject-wise filtering with custom date ranges.
- **🔒 Secure Sessions:** Smart session management that keeps you logged in securely without exposing credentials.
- **🖼️ Profile Integration:** Fetches your ID, name, and profile picture seamlessly.

## 🛠️ Tech Stack
**Frontend:**
- HTML5, CSS3 (Custom variables, modern Flexbox/Grid)
- Vanilla JavaScript (No heavy frameworks, pure speed)

**Backend:**
- **Node.js** & **Express.js** (REST API)
- **Axios** (Network requests)
- **Cheerio** (HTML parsing & web scraping)

## 🚀 Quick Start (Local Development)

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/itsuryansh/iSIM-Lite.git](https://github.com/itsuryansh/iSIM-Lite.git)
   cd iSIM-Lite
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run the server:**
   ```bash
   npm start
   # or 
   node server.js
   ```

4. **Open in Browser:**
   Navigate to `http://localhost:3000` (or whichever port you have configured).

## ☁️ Deployment (Render.com)
This app is ready to be deployed on Render. 
- **Build Command:** `npm install`
- **Start Command:** `node server.js`
- Make sure to set the environment variable `CORS_ORIGINS` if you want to restrict frontend access.

## ⚠️ Disclaimer
**iSIM-Lite is an independent, unofficial project.** 
It is not affiliated with, endorsed, or sponsored by GL Bajaj Institute of Technology and Management or the official iSIM portal creators. This was built strictly for educational purposes to improve the student user experience. Your credentials are used solely to authenticate with the official portal and are **never** stored on any external database.

---
### 👨‍💻 Developed by
**Suryansh Agarwal**  
Let's connect: [GitHub](https://github.com/itsuryansh)
