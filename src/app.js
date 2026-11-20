        const WORKER_URL_KEY = 'isim_worker_api_url_v1';
        function resolveApiBase() {
            const saved = localStorage.getItem(WORKER_URL_KEY);
            if (saved && saved.trim()) {
                const clean = saved.trim().replace(/\/+$/, '');
                return clean.endsWith('/api') ? clean : `${clean}/api`;
            }
            if (typeof window !== 'undefined' && window.location && window.location.origin) {
                const origin = window.location.origin;
                // If running on worker or localhost web
                if (!origin.startsWith('capacitor:') && !origin.startsWith('ionic:') && !origin.startsWith('file:') && !origin.includes('github.io')) {
                    return `${origin}/api`;
                }
            }
            // Default worker fallback for Android Capacitor
            return 'https://isim-lite.workers.dev/api';
        }
        let API_BASE = resolveApiBase();
        const BASE_PORTAL_URL = 'https://glb.servergi.com:8071/iSIMGLBMTR';
        const SESSION_STORAGE_KEY = 'glb_student_portal_session';
        const SUBJECT_DATES_STORAGE_KEY = 'glb_subject_attendance_dates_v1';
        const MPIN_STORAGE_KEY = 'isim_mpin_auth_v1';
        const NOTES_STORAGE_KEY = 'isim_class_notes_v1';
        const CUSTOM_CLASS_STORAGE_KEY = 'isim_custom_classes_v1';
        const CUSTOM_PROFILE_KEY = 'isim_custom_profile_v1';
        const ATTENDANCE_TARGET_KEY = 'isim_attendance_target_v1';

        let sessionId = localStorage.getItem(SESSION_STORAGE_KEY) || null;
        let currentAttType = 'today';
        let profileLoaded = false;
        let currentProfilePhoto = null;
        
        let attendanceLoaded = false;
        let attendanceLoadedAt = 0;
        let attendanceLoadedType = null;
        let attendanceRequestId = 0;
        let profileRequestId = 0;
        let captchaRequestId = 0;
        let currentView = 'view-attendance';

        let currentSelectedDate = getTodayIsoDate();
        let searchInFlight = false;
        let searchDirection = 0;
        let activeSearchAbortController = null;
        let cachedWeeklyTimetable = null;
        let selectedTimetableDayName = getCurrentDayOfWeek();
        const dateAttendanceCache = new Map();

        // Simulator State
        let currentTargetPercentage = Number(localStorage.getItem(ATTENDANCE_TARGET_KEY)) || 75;
        let simOverallAttended = 0;
        let simOverallHeld = 0;
        let simAddedAttended = 0;
        let simAddedBunked = 0;
        let lastLoadedGaugesData = [];

        // MPIN State
        let enteredMpin = '';
        let setupMpinStep = 1;
        let setupMpinFirstPin = '';
        let enteredSetupMpin = '';
        let quickCaptchaSessionId = null;

        const pageOverlay = document.getElementById('pageOverlay');
        const loaderText = document.getElementById('loaderText');
        const statusMsg = document.getElementById('statusMsg');
        const loginError = document.getElementById('loginError');

        const THEME_PREF_KEY = 'glb_selected_theme_mode';
        const DARK_MODE_KEY = 'glb_dark_mode_enabled';
        const PORTAL_THEMES = [
            { name: 'Indigo', primary: '#4f46e5', hover: '#4338ca', soft: '#e0e7ff', tint: '#eef2ff', rgb: '79, 70, 229' },
            { name: 'Royal Blue', primary: '#2563eb', hover: '#1d4ed8', soft: '#dbeafe', tint: '#eff6ff', rgb: '37, 99, 235' },
            { name: 'Emerald', primary: '#059669', hover: '#047857', soft: '#d1fae5', tint: '#ecfdf5', rgb: '5, 150, 105' },
            { name: 'Violet', primary: '#7c3aed', hover: '#6d28d9', soft: '#ede9fe', tint: '#f5f3ff', rgb: '124, 58, 237' },
            { name: 'Rose', primary: '#e11d48', hover: '#be123c', soft: '#ffe4e6', tint: '#fff1f2', rgb: '225, 29, 72' },
            { name: 'Cyan', primary: '#0891b2', hover: '#0e7490', soft: '#cffafe', tint: '#ecfeff', rgb: '8, 145, 178' },
            { name: 'Amber', primary: '#d97706', hover: '#b45309', soft: '#fef3c7', tint: '#fffbeb', rgb: '217, 119, 6' },
            { name: 'Mint', primary: '#10b981', hover: '#059669', soft: '#d1fae5', tint: '#ecfdf5', rgb: '16, 185, 129' },
            { name: 'Sky', primary: '#0284c7', hover: '#0369a1', soft: '#e0f2fe', tint: '#f0f9ff', rgb: '2, 132, 199' },
            { name: 'Purple', primary: '#9333ea', hover: '#7e22ce', soft: '#f3e8ff', tint: '#faf5ff', rgb: '147, 51, 234' }
        ];

        const defaultProfileSvg = `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

        // Service Worker Registration
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('./sw.js').catch(() => {});
            });
        }

        // --- MPIN CRYPTOGRAPHY (AES-GCM Web Crypto) ---
        async function deriveMpinKey(mpin, salt) {
            const enc = new TextEncoder();
            const keyMaterial = await crypto.subtle.importKey(
                'raw', enc.encode(mpin), { name: 'PBKDF2' }, false, ['deriveKey']
            );
            return crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt, iterations: 10000, hash: 'SHA-256' },
                keyMaterial,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
        }

        async function encryptMpinCredentials(mpin, creds) {
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const key = await deriveMpinKey(mpin, salt);
            const enc = new TextEncoder();
            const ciphertext = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                key,
                enc.encode(JSON.stringify(creds))
            );
            return {
                salt: btoa(String.fromCharCode(...salt)),
                iv: btoa(String.fromCharCode(...iv)),
                cipher: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
                admNo: creds.userId,
                name: creds.name || 'Student'
            };
        }

        async function decryptMpinCredentials(mpin, payload) {
            const salt = Uint8Array.from(atob(payload.salt), c => c.charCodeAt(0));
            const iv = Uint8Array.from(atob(payload.iv), c => c.charCodeAt(0));
            const cipher = Uint8Array.from(atob(payload.cipher), c => c.charCodeAt(0));
            const key = await deriveMpinKey(mpin, salt);
            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                key,
                cipher
            );
            return JSON.parse(new TextDecoder().decode(decrypted));
        }

        function triggerHaptic(duration = 20) {
            if ('vibrate' in navigator) {
                try { navigator.vibrate(duration); } catch (_) {}
            }
        }

        function updateMpinDotsUI(pinStr, containerId = 'mpinDots') {
            const dots = document.querySelectorAll(`#${containerId} .mpin-dot`);
            dots.forEach((dot, idx) => {
                dot.classList.toggle('filled', idx < pinStr.length);
            });
        }

        function pressMpinDigit(digit) {
            triggerHaptic(20);
            if (enteredMpin.length >= 4) return;
            enteredMpin += digit;
            updateMpinDotsUI(enteredMpin, 'mpinDots');
            if (enteredMpin.length === 4) {
                setTimeout(handleMpinSubmit, 150);
            }
        }

        function deleteMpinDigit() {
            triggerHaptic(15);
            if (enteredMpin.length > 0) {
                enteredMpin = enteredMpin.slice(0, -1);
                updateMpinDotsUI(enteredMpin, 'mpinDots');
            }
        }

        async function handleMpinSubmit() {
            const rawPayload = localStorage.getItem(MPIN_STORAGE_KEY);
            if (!rawPayload) return switchToPasswordLogin();

            const payload = JSON.parse(rawPayload);
            const mpinCard = document.getElementById('mpinCard');
            const mpinError = document.getElementById('mpinError');

            try {
                const creds = await decryptMpinCredentials(enteredMpin, payload);
                // Correct MPIN!
                enteredMpin = '';
                updateMpinDotsUI('', 'mpinDots');
                mpinError.classList.remove('show');

                pageOverlay.classList.add('active');
                loaderText.innerText = "Unlocking iSIM Dashboard...";

                // Check if existing session is active
                if (sessionId) {
                    try {
                        const checkRes = await fetch(`${API_BASE}/session/${encodeURIComponent(sessionId)}`);
                        const checkData = await checkRes.json();
                        if (checkRes.ok && checkData.success && checkData.loggedIn) {
                            showDashboardView();
                            fetchProfile(true);
                            switchMainTab('view-attendance', document.getElementById('tabBtnAttendance'), false);
                            pageOverlay.classList.remove('active');
                            return;
                        }
                    } catch (_) {}
                }

                // Session expired on portal -> Fast silent re-login with decrypted credentials
                loaderText.innerText = "Renewing college session...";
                await initQuickCaptchaReLogin(creds);

            } catch (err) {
                // Wrong MPIN
                triggerHaptic([40, 60, 40]);
                mpinCard.classList.add('shake');
                const dots = document.querySelectorAll('#mpinDots .mpin-dot');
                dots.forEach(d => d.classList.add('error'));
                mpinError.innerText = "Incorrect MPIN. Please try again.";
                mpinError.classList.add('show');

                setTimeout(() => {
                    mpinCard.classList.remove('shake');
                    dots.forEach(d => d.classList.remove('error'));
                    enteredMpin = '';
                    updateMpinDotsUI('', 'mpinDots');
                }, 500);
            }
        }

        async function initQuickCaptchaReLogin(creds) {
            try {
                const res = await fetch(`${API_BASE}/init-session`);
                const data = await res.json();
                if (data.success) {
                    quickCaptchaSessionId = data.sessionId;
                    window._savedCredsForQuickLogin = creds;
                    document.getElementById('quickCaptchaImg').src = data.captchaImage;
                    document.getElementById('quickCaptchaImg').style.display = 'block';
                    document.getElementById('quickCaptchaState').style.display = 'none';
                    pageOverlay.classList.remove('active');
                    document.getElementById('quickCaptchaModal').classList.add('active');
                    document.getElementById('quickCaptchaInput').value = '';
                    document.getElementById('quickCaptchaInput').focus();
                } else {
                    throw new Error();
                }
            } catch (_) {
                pageOverlay.classList.remove('active');
                switchToPasswordLogin();
            }
        }

        async function reloadQuickCaptcha() {
            const img = document.getElementById('quickCaptchaImg');
            const state = document.getElementById('quickCaptchaState');
            img.style.display = 'none';
            state.style.display = 'flex';
            try {
                const res = await fetch(`${API_BASE}/init-session`);
                const data = await res.json();
                if (data.success) {
                    quickCaptchaSessionId = data.sessionId;
                    img.src = data.captchaImage;
                    img.style.display = 'block';
                    state.style.display = 'none';
                }
            } catch (_) {}
        }

        async function submitQuickCaptchaReLogin() {
            const captcha = document.getElementById('quickCaptchaInput').value.trim();
            if (!captcha) return alert('Please enter the captcha');
            const creds = window._savedCredsForQuickLogin;
            if (!creds || !quickCaptchaSessionId) return;

            document.getElementById('quickCaptchaModal').classList.remove('active');
            pageOverlay.classList.add('active');
            loaderText.innerText = "Logging in...";

            try {
                const res = await fetch(`${API_BASE}/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: quickCaptchaSessionId,
                        userId: creds.userId,
                        password: creds.password,
                        captcha
                    })
                });
                const data = await res.json();
                if (data.success) {
                    sessionId = quickCaptchaSessionId;
                    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
                    showDashboardView();
                    fetchProfile(true);
                    switchMainTab('view-attendance', document.getElementById('tabBtnAttendance'), false);
                } else {
                    alert(data.error || 'Login failed. Please check captcha.');
                    initQuickCaptchaReLogin(creds);
                }
            } catch (_) {
                alert('Connection error');
                switchToPasswordLogin();
            } finally {
                pageOverlay.classList.remove('active');
            }
        }

        function closeQuickCaptchaModal() {
            document.getElementById('quickCaptchaModal').classList.remove('active');
            switchToPasswordLogin();
        }

        function switchToPasswordLogin() {
            enteredMpin = '';
            updateMpinDotsUI('', 'mpinDots');
            document.getElementById('mpin-view').classList.add('hidden');
            document.getElementById('login-view').classList.remove('hidden');
            document.getElementById('quickMpinHint').classList.toggle('hidden', !localStorage.getItem(MPIN_STORAGE_KEY));
            initSession();
        }

        function switchToMpinLogin() {
            const rawPayload = localStorage.getItem(MPIN_STORAGE_KEY);
            if (!rawPayload) return;
            const payload = JSON.parse(rawPayload);
            const custom = JSON.parse(localStorage.getItem(CUSTOM_PROFILE_KEY) || '{}');
            document.getElementById('mpinGreetingName').innerText = `Welcome Back, ${custom.nickname || payload.name || payload.admNo}`;
            document.getElementById('login-view').classList.add('hidden');
            document.getElementById('mpin-view').classList.remove('hidden');
            enteredMpin = '';
            updateMpinDotsUI('', 'mpinDots');
        }

        // MPIN Setup Flow
        function openSetupMpinModal(isChange = false) {
            setupMpinStep = 1;
            setupMpinFirstPin = '';
            enteredSetupMpin = '';
            document.getElementById('setupMpinTitle').innerText = isChange ? "Change 4-Digit MPIN" : "Create 4-Digit MPIN";
            document.getElementById('setupMpinDesc').innerText = "Step 1: Enter a new 4-digit PIN";
            document.getElementById('setupMpinError').classList.remove('show');
            updateMpinDotsUI('', 'setupMpinDots');
            document.getElementById('setupMpinModal').classList.add('active');
        }

        function closeSetupMpinModal() {
            document.getElementById('setupMpinModal').classList.remove('active');
            enteredSetupMpin = '';
            setupMpinFirstPin = '';
        }

        function pressSetupMpinDigit(digit) {
            triggerHaptic(20);
            if (enteredSetupMpin.length >= 4) return;
            enteredSetupMpin += digit;
            updateMpinDotsUI(enteredSetupMpin, 'setupMpinDots');
            if (enteredSetupMpin.length === 4) {
                setTimeout(handleSetupMpinStep, 150);
            }
        }

        function deleteSetupMpinDigit() {
            triggerHaptic(15);
            if (enteredSetupMpin.length > 0) {
                enteredSetupMpin = enteredSetupMpin.slice(0, -1);
                updateMpinDotsUI(enteredSetupMpin, 'setupMpinDots');
            }
        }

        async function handleSetupMpinStep() {
            if (setupMpinStep === 1) {
                setupMpinFirstPin = enteredSetupMpin;
                enteredSetupMpin = '';
                setupMpinStep = 2;
                document.getElementById('setupMpinDesc').innerText = "Step 2: Confirm your 4-digit PIN";
                updateMpinDotsUI('', 'setupMpinDots');
            } else if (setupMpinStep === 2) {
                if (enteredSetupMpin === setupMpinFirstPin) {
                    // Match! Encrypt and save
                    const userId = document.getElementById('admNumber').value.trim() || localStorage.getItem('last_user_id') || 'STUDENT';
                    const password = document.getElementById('password').value || localStorage.getItem('last_user_pass') || '';
                    const creds = { userId, password, name: document.getElementById('profName')?.innerText || 'Student' };

                    const payload = await encryptMpinCredentials(enteredSetupMpin, creds);
                    localStorage.setItem(MPIN_STORAGE_KEY, JSON.stringify(payload));
                    localStorage.setItem('last_user_id', userId);
                    if (password) localStorage.setItem('last_user_pass', password);

                    closeSetupMpinModal();
                    updateMpinStatusInProfile();
                    alert('🎉 4-Digit MPIN set successfully! Next time you open the app, you can unlock instantly without entering credentials.');
                } else {
                    triggerHaptic([40, 60, 40]);
                    const err = document.getElementById('setupMpinError');
                    err.innerText = "PINs do not match. Please restart setup.";
                    err.classList.add('show');
                    setTimeout(() => {
                        openSetupMpinModal();
                    }, 800);
                }
            }
        }

        function removeMpin() {
            if (confirm('Are you sure you want to remove your MPIN? You will need to enter your roll number and password to login.')) {
                localStorage.removeItem(MPIN_STORAGE_KEY);
                updateMpinStatusInProfile();
            }
        }

        function updateMpinStatusInProfile() {
            const hasMpin = Boolean(localStorage.getItem(MPIN_STORAGE_KEY));
            const label = document.getElementById('mpinStatusLabel');
            const btnRemove = document.getElementById('btnRemoveMpin');
            if (label) label.innerText = hasMpin ? "4-Digit MPIN: Active (1-Tap Login Enabled)" : "4-Digit MPIN: Not configured";
            if (btnRemove) btnRemove.classList.toggle('hidden', !hasMpin);
        }

        // --- TIMETABLE & NOTES FEATURE ---
        function getCurrentDayOfWeek() {
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const today = days[new Date().getDay()];
            return today === 'Sunday' ? 'Monday' : today;
        }

        async function selectTimetableDay(dayName) {
            selectedTimetableDayName = dayName;
            document.querySelectorAll('.day-pill').forEach(pill => {
                pill.classList.toggle('active', pill.dataset.day === dayName);
            });
            renderTimetableCardsForDay(dayName);
        }

        async function loadTimetableTab() {
            document.getElementById('timetableLoading').classList.remove('hidden');
            document.getElementById('timetableCardsList').innerHTML = '';
            try {
                const tt = await ensureWeeklyTimetableLoaded();
                document.getElementById('timetableLoading').classList.add('hidden');
                
                // Highlight today pill
                const currentDay = getCurrentDayOfWeek();
                document.querySelectorAll('.day-pill').forEach(pill => {
                    const isToday = pill.dataset.day === currentDay;
                    pill.classList.toggle('today-badge', isToday);
                    if (pill.dataset.day === selectedTimetableDayName) pill.classList.add('active');
                });
                
                renderTimetableCardsForDay(selectedTimetableDayName);
            } catch (e) {
                document.getElementById('timetableLoading').classList.add('hidden');
                document.getElementById('timetableCardsList').innerHTML = `<div style="text-align:center; padding:30px; color:#ef4444; font-weight:600;">Could not load timetable from portal.</div>`;
            }
        }

        function renderTimetableCardsForDay(dayName) {
            const container = document.getElementById('timetableCardsList');
            const weekly = cachedWeeklyTimetable;
            const officialClasses = (weekly && weekly.byDay && weekly.byDay[dayName]) ? [...weekly.byDay[dayName]] : [];
            
            // Merge custom added classes
            const customClasses = JSON.parse(localStorage.getItem(CUSTOM_CLASS_STORAGE_KEY) || '[]');
            const customForDay = customClasses.filter(c => c.day === dayName);
            const allDayClasses = [...officialClasses, ...customForDay];

            if (allDayClasses.length === 0) {
                container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted); font-weight:600;">No classes scheduled for ${dayName}.</div>`;
                return;
            }

            const notesMap = JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) || '{}');
            let html = '';

            allDayClasses.forEach((cls, idx) => {
                const classKey = `${dayName}_${cls.subjectCode || cls.subject}_${cls.timeSlot}`;
                const note = notesMap[classKey] || '';
                const time12 = convertTo12Hour(cls.timeSlot);

                html += `
                    <div class="class-card">
                        <div class="class-info-left">
                            <div class="class-time-slot">
                                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style="width:14px;height:14px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                                ${escapeHtml(time12 || cls.timeSlot)}
                            </div>
                            <div class="class-subject-title">${escapeHtml(cls.subject)}</div>
                            <div class="class-meta-details">
                                ${cls.subjectCode ? `<span>Code: <b>${escapeHtml(cls.subjectCode)}</b></span>` : ''}
                                ${cls.faculty ? `<span>Faculty: <b>${escapeHtml(cls.faculty)}</b></span>` : ''}
                                ${cls.hall ? `<span>Room: <b>${escapeHtml(cls.hall)}</b></span>` : ''}
                            </div>
                            ${note ? `<div class="class-note-badge">📌 ${escapeHtml(note)}</div>` : ''}
                        </div>
                        <button type="button" class="btn-note" onclick="openNoteModal('${escapeHtml(classKey)}', '${escapeHtml(cls.subject)}')">
                            ${note ? '✏️ Edit Note' : '📝 Add Note'}
                        </button>
                    </div>
                `;
            });

            container.innerHTML = html;
        }

        // Note Editor Functions
        let activeNoteKey = null;
        function openNoteModal(classKey, subjectTitle) {
            activeNoteKey = classKey;
            const notesMap = JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) || '{}');
            document.getElementById('noteInput').value = notesMap[classKey] || '';
            document.getElementById('noteModalTitle').innerText = subjectTitle ? `Note: ${subjectTitle}` : 'Class Note';
            document.getElementById('noteModal').classList.add('active');
        }

        function closeNoteModal() {
            document.getElementById('noteModal').classList.remove('active');
            activeNoteKey = null;
        }

        function saveCurrentNote() {
            if (!activeNoteKey) return;
            const text = document.getElementById('noteInput').value.trim();
            const notesMap = JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) || '{}');
            if (text) {
                notesMap[activeNoteKey] = text;
            } else {
                delete notesMap[activeNoteKey];
            }
            localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notesMap));
            closeNoteModal();
            renderTimetableCardsForDay(selectedTimetableDayName);
        }

        function deleteCurrentNote() {
            if (!activeNoteKey) return;
            const notesMap = JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) || '{}');
            delete notesMap[activeNoteKey];
            localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notesMap));
            closeNoteModal();
            renderTimetableCardsForDay(selectedTimetableDayName);
        }

        // Add Custom Class Modal
        function openAddCustomClassModal() {
            document.getElementById('customClassName').value = '';
            document.getElementById('customClassRoom').value = '';
            document.getElementById('customClassModal').classList.add('active');
        }

        function closeAddCustomClassModal() {
            document.getElementById('customClassModal').classList.remove('active');
        }

        function saveCustomClass() {
            const subject = document.getElementById('customClassName').value.trim();
            const start = document.getElementById('customClassStart').value;
            const end = document.getElementById('customClassEnd').value;
            const room = document.getElementById('customClassRoom').value.trim();
            if (!subject) return alert('Please enter subject title');

            const timeSlot = `${start} - ${end}`;
            const customClasses = JSON.parse(localStorage.getItem(CUSTOM_CLASS_STORAGE_KEY) || '[]');
            customClasses.push({
                day: selectedTimetableDayName,
                subject,
                timeSlot,
                hall: room || 'Custom',
                faculty: 'Personal',
                subjectCode: 'EXTRA'
            });
            localStorage.setItem(CUSTOM_CLASS_STORAGE_KEY, JSON.stringify(customClasses));
            closeAddCustomClassModal();
            renderTimetableCardsForDay(selectedTimetableDayName);
        }

        // --- ATTENDANCE WHAT-IF SIMULATOR & BUNK CALCULATOR ---
        function setAttendanceTarget(targetNum) {
            currentTargetPercentage = targetNum;
            localStorage.setItem(ATTENDANCE_TARGET_KEY, String(targetNum));
            document.querySelectorAll('#targetSelector .target-btn').forEach(btn => {
                btn.classList.toggle('active', Number(btn.dataset.target) === targetNum);
            });
            recalculateSimulation();
        }

        function recalculateSimulation() {
            const attended = simOverallAttended + simAddedAttended;
            const total = simOverallHeld + simAddedAttended + simAddedBunked;
            const currentPct = total > 0 ? (attended / total) * 100 : 0;
            const target = currentTargetPercentage;

            document.getElementById('simAttendCount').innerText = `+${simAddedAttended}`;
            document.getElementById('simBunkCount').innerText = `+${simAddedBunked}`;
            document.getElementById('simPredictedPct').innerText = `${currentPct.toFixed(1)}%`;
            document.getElementById('simPredictedPct').style.color = currentPct >= target ? '#16a34a' : '#ef4444';

            // Safe to bunk / Classes needed calculation
            const statusBox = document.getElementById('simBunkStatusBox');
            const icon = document.getElementById('bunkStatusIcon');
            const title = document.getElementById('bunkStatusTitle');
            const desc = document.getElementById('bunkStatusDesc');

            if (total === 0) {
                title.innerText = "No Records Loaded";
                desc.innerText = "Fetch Semester or Monthly attendance to see your exact bunk margins.";
                return;
            }

            if (currentPct >= target) {
                // Safe to bunk: floor((100 * A - T * Target) / Target)
                const safeBunks = Math.floor((100 * attended - target * total) / target);
                icon.className = "bunk-icon-circle bunk-safe";
                icon.innerHTML = `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"></path></svg>`;
                title.innerText = `🟢 Safe to Bunk: ${Math.max(0, safeBunks)} Classes`;
                desc.innerText = safeBunks > 0 
                    ? `You can safely miss up to ${safeBunks} more classes and remain above your ${target}% target!`
                    : `You are currently on the boundary of ${target}%. Don't miss the next class.`;
            } else {
                // Classes needed: ceil((Target * total - 100 * attended) / (100 - Target))
                const needed = Math.ceil((target * total - 100 * attended) / (100 - target));
                icon.className = "bunk-icon-circle bunk-danger";
                icon.innerHTML = `<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>`;
                title.innerText = `🔴 Shortage: Need ${needed} Consecutive Classes`;
                desc.innerText = `You must attend the next ${needed} classes in a row without skipping to reach ${target}%!`;
            }
        }

        function stepSimClass(type, step) {
            triggerHaptic(15);
            if (type === 'present') {
                simAddedAttended = Math.max(0, simAddedAttended + step);
            } else if (type === 'absent') {
                simAddedBunked = Math.max(0, simAddedBunked + step);
            }
            recalculateSimulation();
        }

        function resetOverallSimulation() {
            simAddedAttended = 0;
            simAddedBunked = 0;
            recalculateSimulation();
        }

        function populateSubjectBunkAnalytics(gaugesData) {
            lastLoadedGaugesData = gaugesData || [];
            const container = document.getElementById('simSubjectCardsGrid');
            if (!gaugesData || gaugesData.length === 0) return;

            let totalAtt = 0, totalHeld = 0;
            let html = '';

            gaugesData.forEach((sub, idx) => {
                const pct = parseFloat(sub.value) || 0;
                // Estimate held vs attended if only percentage is provided
                const estimatedHeld = 30;
                const estimatedAtt = Math.round((pct / 100) * estimatedHeld);
                totalAtt += estimatedAtt;
                totalHeld += estimatedHeld;

                const target = currentTargetPercentage;
                let marginText = '';
                if (pct >= target) {
                    const safe = Math.floor((100 * estimatedAtt - target * estimatedHeld) / target);
                    marginText = `<span style="color:#16a34a; font-weight:700;">🟢 Safe to skip: ${Math.max(0, safe)} classes</span>`;
                } else {
                    const need = Math.ceil((target * estimatedHeld - 100 * estimatedAtt) / (100 - target));
                    marginText = `<span style="color:#ef4444; font-weight:700;">🔴 Need ${need} classes for ${target}%</span>`;
                }

                html += `
                    <div class="sim-subject-card" id="subjCard_${idx}">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
                            <div style="font-size:14px; font-weight:800; color:var(--text-dark);">${escapeHtml(sub.label)}</div>
                            <span class="badge ${pct >= target ? 'badge-present' : 'badge-absent'}">${pct.toFixed(1)}%</span>
                        </div>
                        <div style="font-size:12.5px;">${marginText}</div>
                    </div>
                `;
            });

            if (totalHeld > 0) {
                simOverallAttended = totalAtt;
                simOverallHeld = totalHeld;
                recalculateSimulation();
            }

            container.innerHTML = html;
        }

        // --- PROFILE CUSTOMIZATION & REPORT GENERATOR ---
        function openProfileCustomModal() {
            const custom = JSON.parse(localStorage.getItem(CUSTOM_PROFILE_KEY) || '{}');
            document.getElementById('customNicknameInput').value = custom.nickname || '';
            document.getElementById('profileCustomModal').classList.add('active');
        }

        function closeProfileCustomModal() {
            document.getElementById('profileCustomModal').classList.remove('active');
        }

        function saveProfileCustomizations() {
            const nickname = document.getElementById('customNicknameInput').value.trim();
            const fileInput = document.getElementById('customAvatarFile');
            const custom = JSON.parse(localStorage.getItem(CUSTOM_PROFILE_KEY) || '{}');

            custom.nickname = nickname;

            if (fileInput.files && fileInput.files[0]) {
                const reader = new FileReader();
                reader.onload = function(e) {
                    custom.avatarData = e.target.result;
                    localStorage.setItem(CUSTOM_PROFILE_KEY, JSON.stringify(custom));
                    applyProfileCustomizations();
                    closeProfileCustomModal();
                };
                reader.readAsDataURL(fileInput.files[0]);
            } else {
                localStorage.setItem(CUSTOM_PROFILE_KEY, JSON.stringify(custom));
                applyProfileCustomizations();
                closeProfileCustomModal();
            }
        }

        function applyProfileCustomizations() {
            const custom = JSON.parse(localStorage.getItem(CUSTOM_PROFILE_KEY) || '{}');
            if (custom.nickname) {
                const topName = document.getElementById('topNavName');
                if (topName) topName.innerText = custom.nickname;
            }
            if (custom.avatarData) {
                const topAvatar = document.getElementById('topNavAvatar');
                const profImg = document.getElementById('profImg');
                const defSvg = document.getElementById('profDefaultSvg');
                if (profImg) {
                    profImg.src = custom.avatarData;
                    profImg.classList.remove('hidden');
                }
                if (defSvg) defSvg.classList.add('hidden');
                if (topAvatar) {
                    topAvatar.innerHTML = `<img src="${custom.avatarData}" style="width:100%;height:100%;object-fit:cover;">`;
                }
            }
        }

        function copyAttendanceReport() {
            const name = document.getElementById('profName')?.innerText || 'Student';
            const adm = document.getElementById('profAdm')?.innerText || '';
            const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
            
            let text = `📊 *iSIM Attendance Report*\n👤 *Student:* ${name} (${adm})\n📅 *Date:* ${today}\n🎯 *Target:* ${currentTargetPercentage}%\n----------------------------\n`;
            
            if (lastLoadedGaugesData && lastLoadedGaugesData.length > 0) {
                lastLoadedGaugesData.forEach(sub => {
                    const val = parseFloat(sub.value) || 0;
                    const status = val >= currentTargetPercentage ? '✅' : '⚠️';
                    text += `${status} ${sub.label}: *${val}%*\n`;
                });
            } else {
                text += `Overall Percentage: Simulated ~${currentTargetPercentage}%\n`;
            }
            text += `\n⚡ _Generated via iSIM Lite_ 🚀`;

            navigator.clipboard.writeText(text).then(() => {
                alert('📋 Attendance report copied to clipboard! You can share it directly on WhatsApp.');
            }).catch(() => {
                alert('Could not copy report to clipboard.');
            });
        }

        // --- BACKGROUND PUSH NOTIFICATIONS ---
        function urlBase64ToUint8Array(base64String) {
            const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
            const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
            const rawData = window.atob(base64);
            const outputArray = new Uint8Array(rawData.length);
            for (let i = 0; i < rawData.length; ++i) {
                outputArray[i] = rawData.charCodeAt(i);
            }
            return outputArray;
        }

        async function requestPushNotificationPermission() {
            if (!('Notification' in window) || !('serviceWorker' in navigator)) {
                return alert('Push notifications are not supported in this browser/device.');
            }
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                alert('Notification permission was denied. Please allow notifications in site/app settings.');
                updatePushStatusInProfile();
                return;
            }
            
            try {
                const reg = await navigator.serviceWorker.ready;
                const keyRes = await fetch(`${API_BASE}/push/vapid-public-key`);
                const keyData = await keyRes.json();
                const convertedKey = urlBase64ToUint8Array(keyData.publicKey);
                
                let sub = await reg.pushManager.getSubscription();
                if (!sub) {
                    sub = await reg.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: convertedKey
                    });
                }
                
                await fetch(`${API_BASE}/push/subscribe`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId,
                        subscription: sub,
                        preferences: { notifyAbsent: true, notifyLowAttendance: true }
                    })
                });

                localStorage.setItem('isim_push_enabled', 'true');
                updatePushStatusInProfile();
                alert('🔔 Background push notifications enabled! You will receive real-time alerts when marked Absent or when attendance drops.');
            } catch (err) {
                alert('Failed to register push notifications: ' + err.message);
            }
        }

        async function sendTestPushNotification() {
            if (!('Notification' in window) || Notification.permission !== 'granted') {
                return requestPushNotificationPermission();
            }
            try {
                const reg = await navigator.serviceWorker.ready;
                const sub = await reg.pushManager.getSubscription();
                
                // Show immediate notification
                reg.showNotification('⚠️ Attendance Alert: Marked ABSENT!', {
                    body: 'Alert: You were marked Absent in Database Management Systems (09:10 - 10:00 AM). Check your attendance!',
                    icon: 'https://www.glbitm.org/images/favicon.png',
                    badge: 'https://www.glbitm.org/images/favicon.png',
                    vibrate: [200, 100, 200, 100, 300]
                });

                if (sub) {
                    fetch(`${API_BASE}/push/test`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId, subscription: sub })
                    }).catch(() => {});
                }
            } catch (e) {
                alert('Test push notification could not be sent: ' + e.message);
            }
        }

        function updatePushStatusInProfile() {
            const label = document.getElementById('pushStatusLabel');
            const btnEnable = document.getElementById('btnEnablePush');
            if (!label) return;
            
            if (!('Notification' in window)) {
                label.innerText = 'Status: Unsupported on this browser';
                if (btnEnable) btnEnable.classList.add('hidden');
                return;
            }

            if (Notification.permission === 'granted') {
                label.innerText = 'Status: Active (Alerts Enabled ✅)';
                label.style.color = '#16a34a';
                if (btnEnable) btnEnable.innerText = 'Subscribed ✅';
            } else if (Notification.permission === 'denied') {
                label.innerText = 'Status: Blocked in Browser Settings ❌';
                label.style.color = '#ef4444';
                if (btnEnable) btnEnable.innerText = 'Enable Alerts';
            } else {
                label.innerText = 'Status: Not Configured';
                label.style.color = 'var(--text-dark)';
                if (btnEnable) btnEnable.innerText = 'Enable Alerts';
            }
        }

        // --- WORKER CONNECTION MANAGER ---
        function saveWorkerUrlFromInput() {
            const input = document.getElementById('workerUrlInput');
            if (!input) return;
            const url = input.value.trim();
            if (url) {
                localStorage.setItem(WORKER_URL_KEY, url);
            } else {
                localStorage.removeItem(WORKER_URL_KEY);
            }
            API_BASE = resolveApiBase();
            testServerConnection(true);
        }

        async function testServerConnection(showAlert = false) {
            const statusBadge = document.getElementById('serverConnectionStatus');
            if (statusBadge) {
                statusBadge.innerText = 'Testing...';
                statusBadge.style.color = 'var(--primary)';
            }
            try {
                const res = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
                const data = await res.json();
                if (data.success) {
                    if (statusBadge) {
                        statusBadge.innerText = data.engine ? `Connected to ${data.engine} ✅` : 'Connected to Worker ✅';
                        statusBadge.style.color = '#16a34a';
                    }
                    if (showAlert) alert(`✅ Successfully connected to Cloudflare Worker!\n\nEngine: ${data.engine || 'Cloudflare Edge'}\nEndpoint: ${API_BASE}`);
                    return true;
                }
            } catch (err) {
                if (statusBadge) {
                    statusBadge.innerText = 'Connection Failed ❌';
                    statusBadge.style.color = '#ef4444';
                }
                if (showAlert) alert(`❌ Could not connect to Worker at:\n${API_BASE}\n\nMake sure your Cloudflare Worker is deployed or running with 'npm run worker:dev'.\nError: ${err.message}`);
                return false;
            }
        }

        function initWorkerUrlUI() {
            const input = document.getElementById('workerUrlInput');
            if (input) {
                input.value = localStorage.getItem(WORKER_URL_KEY) || (window.location.protocol.startsWith('http') ? window.location.origin : '');
            }
            testServerConnection(false);
        }
